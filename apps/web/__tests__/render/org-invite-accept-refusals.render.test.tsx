/**
 * B-16 / B-15 — the organization invitation accept page.
 *
 * B-16: every refusal used to read "ask an organization administrator for a new
 *   invitation" (by HTTP status). The accept route now sends a nested
 *   error.code for each refusal (organizations.routes.ts
 *   acceptOrgInviteHandler) and the page says what the person can actually do:
 *   sign in with the invited address, try again when the workspace was busy,
 *   ask for reinstatement when suspended, and so on.
 * B-15: the accept carries the token in the BODY of POST /v1/org-invites/accept,
 *   never in the request path.
 *
 * Mounted with the real apiFetch over a stubbed fetch, answering with the
 * bodies the route really sends.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const TOKEN = "tok-0123456789abcdef";
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useParams: () => ({ token: "tok-0123456789abcdef" }),
  usePathname: () => "/org-invites/tok-0123456789abcdef/accept",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ refresh: async () => {}, envelope: null, switchWorkspace: async () => {} }),
}));

import OrgInviteAcceptPage from "../../app/(app)/org-invites/[token]/accept/page";

const PENDING = {
  state: "PENDING",
  context: {
    organizationName: "Acme Claims",
    role: "ORG_MEMBER",
    invitedEmailMasked: "j•••@acme.test",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    workspaces: [],
  },
};

let acceptReplies: Array<{ status: number; body: unknown }> = [];
const requests: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.includes("/v1/org-invites/lookup")) return respond(200, PENDING);
      if (url.includes("/v1/org-invites/") && url.includes("accept")) {
        const next = acceptReplies.shift() ?? { status: 500, body: {} };
        return respond(next.status, next.body);
      }
      return respond(404, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountAndAccept() {
  await act(async () => {
    render(<OrgInviteAcceptPage />);
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
  await settle();
}

const acceptCalls = () => requests.filter((r) => r.method === "POST" && r.url.includes("accept"));

describe("B-15 — the token travels in the body", () => {
  it("POSTs /v1/org-invites/accept with { token }, and the path carries no token", async () => {
    acceptReplies = [
      { status: 200, body: { invitationAccepted: true, organizationId: "org-1", role: "ORG_MEMBER", assignedWorkspaceIds: [] } },
    ];
    await mountAndAccept();
    const calls = acceptCalls();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/org-invites/accept");
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ token: TOKEN });
  });
});

describe("B-16 — each refusal says what to do", () => {
  const cases: Array<[string, number, string, RegExp]> = [
    ["INVITE_EMAIL_MISMATCH", 403, "This invitation was sent to a different address", /sign in \(or create an account\) with the address/],
    ["INVITE_EXPIRED", 410, "This invitation has expired", /send a new invitation/],
    ["INVITE_REVOKED", 410, "This invitation was withdrawn", /if you still need access/],
    ["INVITE_ALREADY_USED", 410, "This invitation has already been used", /open the organization from Organizations/],
    ["ORGANIZATION_NOT_ACCEPTING_MEMBERS", 410, "This organization isn't accepting members", /archived or suspended/],
    ["MEMBERSHIP_SUSPENDED", 409, "Your membership in this organization is suspended", /does not lift a suspension/],
    ["INVITE_SUPERSEDED", 409, "This invitation is no longer valid", /before your access to this organization ended/],
  ];
  for (const [code, status, title, message] of cases) {
    it(`${code} → "${title}"`, async () => {
      acceptReplies = [{ status, body: { error: { code }, message: "server sentence" } }];
      await mountAndAccept();
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.queryByText("We couldn't accept this invite")).toBeNull();
    });
  }

  it("WORKSPACE_SEAT_CONTENTION offers Try again, which accepts again and succeeds", async () => {
    acceptReplies = [
      { status: 409, body: { error: { code: "WORKSPACE_SEAT_CONTENTION" }, message: "busy" } },
      { status: 200, body: { invitationAccepted: true, organizationId: "org-1", role: "ORG_MEMBER", assignedWorkspaceIds: [] } },
    ];
    await mountAndAccept();
    expect(screen.getByText("Too many people are joining at once")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(acceptCalls()).toHaveLength(2);
    expect(screen.getByText(/You are now a member of the organization/)).toBeTruthy();
  });

  it("a refusal with no code (an older API) keeps the status wording", async () => {
    acceptReplies = [{ status: 410, body: { message: "Invite has expired." } }];
    await mountAndAccept();
    expect(screen.getByText("We couldn't accept this invite")).toBeTruthy();
    expect(screen.getByText(/expired, revoked, or already accepted/)).toBeTruthy();
  });
});
