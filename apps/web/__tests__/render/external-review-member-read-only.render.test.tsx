/**
 * T-114 (ARCH-15) — the External Review console is READ-ONLY for a MEMBER.
 *
 * The route opens for any evidence writer, while every manage action needs an
 * OWNER or ADMIN, so a MEMBER saw Bulk Invite, bulk revoke, row checkboxes and
 * Resend / Revoke / End sessions / token reveal — all inert. The console now
 * stays discoverable (the list and each invitation's activity) but offers no
 * manage control to a caller the API would refuse, and says so in a note. The
 * answer is the page's existing manage predicate: the list's `viewerCanIssue`
 * and each row's `viewerCanRevoke`, else the envelope role.
 *
 * Real apiFetch over a stubbed transport; the OWNER case is unchanged.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const H = vi.hoisted(() => ({ role: "MEMBER", projected: true as boolean }));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCan: () => true,
  // A Team workspace (PERSONAL, shared for a member; the owner's own for OWNER).
  useActiveSpace: () =>
    H.role === "Owner"
      ? { type: "PERSONAL", id: "ws-1", displayName: "Personal Space", roleLabel: "Owner", plan: "TEAM" }
      : { type: "PERSONAL", id: "ws-1", displayName: "Dana's workspace", roleLabel: H.role, shared: true, plan: "TEAM" },
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  usePlatformContext: () => ({ envelope: null }),
  useWorkspaceFragment: () => null,
  usePersonalSpaceFragment: () => null,
}));
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn({}),
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});

import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const GRANT = "44444444-4444-4444-8444-444444444444";
const ROW = {
  grantId: GRANT,
  role: "EXTERNAL_REVIEWER",
  organization: "Acme",
  inviteEmail: "sue@acme.test",
  mfaRequired: false,
  watermarkPolicy: "STANDARD",
  inviteSentAtUtc: "2026-01-01T00:00:00.000Z",
  inviteAcceptedAtUtc: "2026-01-02T00:00:00.000Z",
  inviteResentAtUtc: null,
  activityCount: 1,
  grantState: "ACTIVE",
  expiresAtUtc: null,
  expired: false,
  authMethod: "TOKEN",
  ssoConnectionId: null,
  allowedDomains: [],
  ssoSubjectHash: null,
  ssoNameId: null,
  ssoBoundAtUtc: null,
  mfaSatisfiedAtUtc: null,
  latestDelivery: null,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/external-review/invitations") && !url.includes(GRANT)) {
        const manager = H.role === "Owner" || H.role === "ADMIN";
        return json(
          H.projected
            ? { invitations: [{ ...ROW, viewerCanRevoke: manager }], viewerCanIssue: manager }
            : { invitations: [ROW] },
        );
      }
      if (url.includes("/activity")) return json({ activity: [] });
      if (url.includes("/delivery")) return json({ deliveries: [] });
      if (url.includes("/feedback")) return json({ decisions: [], comments: [] });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountAndOpen() {
  render(<ExternalInvitationsPage />);
  const row = await waitFor(() => {
    const el = document.querySelector(`[data-invitation-row="${GRANT}"]`);
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(row);
  await waitFor(() => expect(document.querySelector("[data-drawer-delivery-panel]")).not.toBeNull());
}

const manageControls = () => ({
  bulkInviteTab: document.querySelector('[data-tab="bulk"]'),
  bulkRevoke: document.querySelector("[data-bulk-revoke-action]"),
  rowCheckbox: document.querySelector(`[data-row-multi="${GRANT}"]`),
  resend: document.querySelector(`[data-invitation-resend="${GRANT}"]`),
  revoke: document.querySelector(`[data-invitation-revoke="${GRANT}"]`),
  endSessions: document.querySelector(`[data-invitation-end-sessions="${GRANT}"]`),
  reveal: document.querySelector("[data-break-glass-arm]"),
});

describe("T-114 — External Review console for a MEMBER", () => {
  it("MEMBER: the list and record stay readable; no Bulk Invite / Revoke / Resend; a read-only note", async () => {
    H.role = "MEMBER";
    H.projected = true;
    await mountAndOpen();
    expect(screen.getAllByText("sue@acme.test").length).toBeGreaterThan(0);
    const c = manageControls();
    expect(c.bulkInviteTab).toBeNull();
    expect(c.bulkRevoke).toBeNull();
    expect(c.rowCheckbox).toBeNull();
    expect(c.resend).toBeNull();
    expect(c.revoke).toBeNull();
    expect(c.endSessions).toBeNull();
    expect(c.reveal).toBeNull();
    expect(screen.queryByText("Bulk Invite")).toBeNull();
    const note = document.querySelector("[data-external-review-read-only]");
    expect(note?.textContent).toMatch(/Read-only/);
    expect(note?.textContent).toMatch(/needs an owner or admin of this workspace/);
  });

  it("MEMBER on an API without the projected fields: the envelope role decides, still read-only", async () => {
    H.role = "MEMBER";
    H.projected = false;
    await mountAndOpen();
    expect(manageControls().bulkInviteTab).toBeNull();
    expect(manageControls().revoke).toBeNull();
    expect(document.querySelector("[data-external-review-read-only]")).not.toBeNull();
  });

  it("OWNER: unchanged — Bulk Invite, bulk revoke and the row's Resend / Revoke are offered, no note", async () => {
    H.role = "Owner";
    H.projected = true;
    await mountAndOpen();
    const c = manageControls();
    expect(c.bulkInviteTab).not.toBeNull();
    expect(c.bulkRevoke).not.toBeNull();
    expect(c.rowCheckbox).not.toBeNull();
    expect(c.resend).not.toBeNull();
    expect((c.revoke as HTMLButtonElement | null)?.disabled).toBe(false);
    expect(c.endSessions).not.toBeNull();
    expect(document.querySelector("[data-external-review-read-only]")).toBeNull();
  });
});
