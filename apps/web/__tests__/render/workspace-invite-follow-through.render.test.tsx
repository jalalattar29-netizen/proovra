/**
 * F-07 / F-26e (Free-user audit, 2026-11-13) — what the invitee sees after the
 * server answers, through the REAL `apiFetch` over a stubbed `fetch`:
 *
 *   - a refused workspace switch after a successful accept is SHOWN as the
 *     access state it is (here: the organization's mandatory SSO), and the page
 *     does not navigate into the previous space under "you now have access";
 *   - a switch the server allows navigates;
 *   - the settled refusals that used to read "we couldn't check this
 *     invitation… try again" each get their own actionable state, and the
 *     verification email is requested with the invitation as its return path.
 *
 * The switch refusal is a FLAT body (`{message, code, reason}`), which the real
 * apiFetch raises as a plain Error with `statusCode`, not an ApiError — the
 * reason this is a render test with the real client and not a unit test.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = `wsit_v1_${"a".repeat(43)}`;
const WORKSPACE_ID = "6f1f3a52-1d4e-4c43-9d0a-2b7e7f6c9a10";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: `wsit_v1_${"a".repeat(43)}` }),
  useRouter: () => router,
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ authReady: true, user: { email: "invitee@example.test" } }),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

import InviteAcceptPage from "../../app/invite/[token]/page";

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply>;
let calls: Array<{ url: string; body: unknown }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  replies = {
    lookup: {
      status: 200,
      body: {
        state: "PENDING",
        context: {
          workspaceName: "Northgate Investigations",
          organizationName: null,
          role: "MEMBER",
          invitedEmailMasked: "i••••@example.test",
          expiresAtUtc: "2026-11-20T10:00:00.000Z",
        },
      },
    },
    accept: { status: 200, body: { workspaceId: WORKSPACE_ID, role: "MEMBER", alreadyMember: false } },
    switch: { status: 200, body: {} },
    resend: { status: 200, body: { ok: true, retryAfterSec: 60 } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const key = url.includes("/v1/teams/invites/lookup")
        ? "lookup"
        : url.includes("/accept")
          ? "accept"
          : url.includes("/v1/platform/context/switch-workspace")
            ? "switch"
            : url.includes("/v1/auth/email/resend-verification")
              ? "resend"
              : null;
      if (!key) return json(404, { message: "unexpected" });
      return json(replies[key].status, replies[key].body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
  router.replace.mockReset();
});

async function accept() {
  render(<InviteAcceptPage />);
  fireEvent.click(await screen.findByTestId("invite-accept"));
}

describe("workspace invitation follow-through", () => {
  it("a switch refused for the organization's SSO is shown, and the page does not navigate", async () => {
    replies.switch = {
      status: 403,
      body: { message: "Not a member of this workspace", code: "workspace_membership_required", reason: "mandatory_sso_required" },
    };
    await accept();
    fireEvent.click(await screen.findByTestId("invite-open-workspace"));
    expect(await screen.findByText("Invitation accepted — the workspace didn't open")).toBeTruthy();
    expect(screen.getByText(/requires its single sign-on/)).toBeTruthy();
    // The reader is offered a fresh sign-in that returns to this invitation.
    const again = screen.getByTestId("invite-switch-account");
    expect(again.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(`/invite/${TOKEN}`)}`);
    expect(router.push).not.toHaveBeenCalled();
    const switched = calls.find((c) => c.url.includes("switch-workspace"));
    expect(switched?.body).toEqual({ workspaceId: WORKSPACE_ID });
  });

  it("an interrupted switch offers a real retry, which opens the workspace once the server allows it", async () => {
    replies.switch = { status: 503, body: { message: "unavailable" } };
    await accept();
    fireEvent.click(await screen.findByTestId("invite-open-workspace"));
    expect(await screen.findByText(/interrupted the connection while opening/)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    replies.switch = { status: 200, body: {} };
    fireEvent.click(screen.getByTestId("invite-retry-open"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/home"));
  });

  it("a switch the server allows navigates into the workspace", async () => {
    await accept();
    fireEvent.click(await screen.findByTestId("invite-open-workspace"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/home"));
  });

  it("EMAIL_NOT_VERIFIED asks for verification and sends it with the invitation as the return path", async () => {
    replies.accept = {
      status: 403,
      body: { error: { code: "EMAIL_NOT_VERIFIED" }, code: "EMAIL_NOT_VERIFIED", message: "Verify your email address, then accept this invitation." },
    };
    await accept();
    expect(await screen.findByText("Verify your email address first")).toBeTruthy();
    expect(screen.queryByText("We couldn't check this invitation")).toBeNull();
    fireEvent.click(screen.getByTestId("invite-send-verification"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("resend-verification"))).toBe(true));
    const sent = calls.find((c) => c.url.includes("resend-verification"));
    expect(sent?.body).toEqual({ email: "invitee@example.test", next: `/invite/${TOKEN}` });
    expect(await screen.findByText("Verification email sent")).toBeTruthy();
  });

  it("the legal re-acceptance 428 routes to the terms, not to a retry that cannot work", async () => {
    replies.accept = {
      status: 428,
      body: { error: { code: "LEGAL_REACCEPT_REQUIRED", message: "You must accept the latest legal policies before continuing." } },
    };
    await accept();
    expect(await screen.findByText("Accept the updated terms to continue")).toBeTruthy();
    expect(screen.getByTestId("invite-review-terms").getAttribute("href")).toBe("/settings#privacy");
  });

  it.each([
    ["MEMBERSHIP_SUSPENDED", 409, "Your access to this workspace is suspended"],
    ["INVITE_SUPERSEDED", 409, "This invitation is no longer valid for you"],
    ["ENTERPRISE_CONTRACT_REQUIRED", 409, "This workspace can't add members right now"],
    ["SUBSCRIPTION_INACTIVE", 402, "This workspace can't add members right now"],
  ])("%s has its own settled state", async (code, status, title) => {
    replies.accept = { status, body: { error: { code }, code, message: "refused" } };
    await accept();
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByText("We couldn't check this invitation")).toBeNull();
  });
});
