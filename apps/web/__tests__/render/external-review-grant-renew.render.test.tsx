/**
 * EP-0450 / PRO-CENZ-01 (closure phase 2) — Renew an external-review grant.
 *
 * POST /v1/external-review/grants/:id/renew is the explicit, audited renewal
 * (SEC-08). Both surfaces that list grants — the record/case panel and the
 * External Review console — offer Renew ONLY where the list projects
 * `viewerCanRenew: true`, confirm first (as owner share links renew), send the
 * workspace and the stated period through the step-up flow, and say the
 * route's own refusals. Real apiFetch over a stubbed fetch.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const gates = { confirm: true };
vi.mock("../../lib/platform-context/useServerProjectionGates", () => ({
  usePlanFeature: () => true,
}));
vi.mock("../../lib/platform-context", () => ({
  useCan: () => true,
  useActiveSpace: () => ({ type: "ORGANIZATION", roleLabel: "ADMIN" }),
  useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui", async (orig) => ({
  ...((await orig()) as object),
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) =>
      fn({ "x-proovra-step-up-challenge-id": "challenge-1" }),
  };
  return { StepUpModal: () => null, useStepUpAction: () => control, isStepUpCancelled: () => false };
});
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => gates.confirm }),
}));

import { ExternalReviewSubjectPanel } from "../../components/external-review/ExternalReviewSubjectPanel";
import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "11111111-1111-4111-8111-111111111111";
const RENEW = `/v1/external-review/grants/${GRANT}/renew`;

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let viewerCanRenew = true;
let renewReply: { status: number; body: unknown };

const grant = () => ({
  id: GRANT,
  reviewerEmail: "reviewer@outside.test",
  reviewerDisplayName: null,
  state: "ACTIVE",
  expiresAtUtc: "2030-01-01T00:00:00.000Z",
  acceptedAtUtc: null,
  lastAccessedAtUtc: null,
  viewerCanRenew,
});
const invitation = () => ({
  grantId: GRANT, role: "EXTERNAL_REVIEWER", organization: null, inviteEmail: "sue@acme.com", mfaRequired: false,
  watermarkPolicy: "STANDARD", inviteSentAtUtc: "2026-01-01T00:00:00.000Z", inviteAcceptedAtUtc: "2026-01-02T00:00:00.000Z",
  inviteResentAtUtc: null, activityCount: 0, grantState: "ACTIVE", expiresAtUtc: "2030-01-01T00:00:00.000Z",
  expired: false, authMethod: "TOKEN", ssoConnectionId: null, allowedDomains: [], ssoSubjectHash: null, ssoNameId: null,
  ssoBoundAtUtc: null, mfaSatisfiedAtUtc: null, latestDelivery: null, viewerCanRenew,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  viewerCanRenew = true;
  gates.confirm = true;
  renewReply = { status: 200, body: { grant: { id: GRANT, expiresAtUtc: "2030-01-08T00:00:00.000Z", state: "ACTIVE" } } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, headers });
      if (path === RENEW) return json(renewReply.status, renewReply.body);
      if (path.startsWith("/v1/external-review/grants?")) return json(200, { grants: [grant()] });
      if (path === "/v1/external-review/invitations") return json(200, { invitations: [invitation()] });
      if (path.endsWith("/activity")) return json(200, { activity: [] });
      if (path.endsWith("/delivery")) return json(200, { deliveries: [] });
      if (path.endsWith("/feedback")) return json(200, { decisions: [], comments: [] });
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renews = () => calls.filter((c) => c.method === "POST" && c.path === RENEW);

async function renderPanel() {
  render(<ExternalReviewSubjectPanel teamId={TEAM} subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />);
  await waitFor(() => expect(screen.getByText("reviewer@outside.test")).toBeTruthy());
}

describe("EP-0450 — Renew on the record panel", () => {
  it("renews a grant the API marks renewable: confirmed, workspace + period sent with the step-up, list reread", async () => {
    await renderPanel();
    const listReads = calls.filter((c) => c.path.startsWith("/v1/external-review/grants?")).length;
    fireEvent.click(screen.getByRole("button", { name: "Renew" }));
    await waitFor(() => expect(screen.getByText("Access renewed for reviewer@outside.test.")).toBeTruthy());
    expect(renews()).toHaveLength(1);
    expect(renews()[0]!.body).toEqual({ teamId: TEAM, days: 7 });
    expect(renews()[0]!.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    expect(calls.filter((c) => c.path.startsWith("/v1/external-review/grants?")).length).toBe(listReads + 1);
  });

  it("offers no Renew where the API does not project viewerCanRenew, and a declined confirmation sends nothing", async () => {
    viewerCanRenew = false;
    await renderPanel();
    expect(screen.queryByRole("button", { name: "Renew" })).toBeNull();
    // Revoke stays (a corrective action is never gated on the plan).
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    cleanup();
    viewerCanRenew = true;
    gates.confirm = false;
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Renew" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(renews()).toHaveLength(0);
  });

  it("says each refusal of the renew route", async () => {
    renewReply = { status: 409, body: { error: { code: "EXTERNAL_REVIEW_GRANT_NOT_RENEWABLE" } } };
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Renew" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/can no longer be renewed/));
    cleanup();
    renewReply = {
      status: 403,
      body: { error: { code: "ENTITLEMENT_REQUIRED", message: "External Review is not included on this workspace's plan." } },
    };
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Renew" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer included on this workspace's plan/));
    cleanup();
    renewReply = { status: 403, body: { error: { code: "FORBIDDEN", message: "Forbidden" } } };
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Renew" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/role does not include renewing/));
  });
});

async function openConsoleDrawer() {
  render(<ExternalInvitationsPage />);
  const row = await waitFor(() => {
    const el = document.querySelector(`[data-invitation-row="${GRANT}"]`);
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(row);
  await screen.findByRole("button", { name: "Resend invitation email" });
}

describe("EP-0450 — Renew in the External Review console", () => {
  it("renews from the drawer where the API marks the row renewable", async () => {
    await openConsoleDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Renew access" }));
    await waitFor(() => expect(renews()).toHaveLength(1));
    expect(renews()[0]!.body).toEqual({ teamId: TEAM, days: 7 });
    expect(renews()[0]!.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    await waitFor(() => expect(screen.getByText(/Renewed access for sue@acme.com for 7 days\./)).toBeTruthy());
  });

  it("offers no Renew on a row the API does not mark renewable", async () => {
    viewerCanRenew = false;
    await openConsoleDrawer();
    expect(screen.queryByRole("button", { name: "Renew access" })).toBeNull();
  });

  it("says a refused renewal in the console", async () => {
    renewReply = { status: 409, body: { error: { code: "EXTERNAL_REVIEW_GRANT_NOT_RENEWABLE" } } };
    await openConsoleDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Renew access" }));
    await waitFor(() => expect(screen.getByText(/can no longer be renewed/)).toBeTruthy());
  });
});
