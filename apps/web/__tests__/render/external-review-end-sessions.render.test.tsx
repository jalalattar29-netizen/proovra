/**
 * WCC D2 follow-up — External review console: "End sessions".
 *
 *   POST /v1/external-review/invitations/:id/sessions/revoke
 *     app/(app)/review/external/page.tsx — the route ends every live portal
 *     session of an invitation (the invitation itself stays valid), but the
 *     operator console had no control for it. The drawer now offers
 *     "End sessions": a confirmation first, then the write, then a reread of
 *     the invitation's activity and the list, and only then the notice. A
 *     refusal is explained in bounded copy; a caller without the reviewer-ops
 *     act capability sees the control disabled with the reason on screen.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), toast: vi.fn(), canAct: { value: true } }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  const space = { type: "ORGANIZATION", roleLabel: "ADMIN" };
  return {
    useCan: () => mocks.canAct.value,
    useActiveSpace: () => space,
    useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
});
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn({}),
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});
vi.mock("../../components/ui", async (orig) => ({
  ...((await orig()) as object),
  useToast: () => ({ addToast: mocks.toast }),
}));

import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const GRANT = "44444444-4444-4444-8444-444444444444";
const LIST = "/v1/external-review/invitations";
const ACTIVITY = `/v1/external-review/invitations/${GRANT}/activity`;
const DELIVERY = `/v1/external-review/invitations/${GRANT}/delivery`;
const END = `/v1/external-review/invitations/${GRANT}/sessions/revoke`;

const ROW = {
  grantId: GRANT,
  role: "EXTERNAL_REVIEWER",
  organization: "Acme",
  inviteEmail: "sue@acme.com",
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

let ended = false;
let endReply: () => unknown;
let rereadFails = false;

function reply(path: string, init?: RequestInit): unknown {
  if (path === END && init?.method === "POST") {
    const r = endReply();
    ended = true;
    return r;
  }
  if (ended && rereadFails && (path === LIST || path === ACTIVITY)) {
    throw Object.assign(new Error("down"), { statusCode: 503 });
  }
  if (path === LIST) return { invitations: [ROW] };
  if (path === ACTIVITY) {
    return {
      activity: ended
        ? [{ id: "a2", code: "PORTAL_SESSION_REVOKED", sessionId: null, payload: {}, occurredAtUtc: "2026-01-03T00:00:00.000Z" }]
        : [],
    };
  }
  if (path === DELIVERY) return { deliveries: [] };
  throw Object.assign(new Error("unexpected path"), { statusCode: 500 });
}

beforeEach(() => {
  ended = false;
  rereadFails = false;
  mocks.canAct.value = true;
  endReply = () => ({ ok: true, sessionsEnded: 2 });
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.toast.mockReset();
});
afterEach(cleanup);

async function openDrawer(): Promise<HTMLButtonElement> {
  render(<ExternalInvitationsPage />);
  const row = await waitFor(() => {
    const el = document.querySelector(`[data-invitation-row="${GRANT}"]`);
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(row);
  return screen.findByRole("button", { name: "End sessions" }) as Promise<HTMLButtonElement>;
}
const writes = () => mocks.fetch.mock.calls.filter(([path, init]) => path === END && init?.method === "POST");

describe("external review console — end sessions", () => {
  it("confirms, posts, rereads, and only then announces", async () => {
    fireEvent.click(await openDrawer());
    const notice = await screen.findByText(
      "Ended 2 portal sessions for sue@acme.com. The invitation is still valid.",
    );
    expect(notice.closest("[data-console-banner]")?.getAttribute("role")).toBe("status");
    expect(notice.closest("[data-console-banner]")?.getAttribute("data-console-banner-tone")).toBe("ok");
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "End sue@acme.com's portal sessions?", tone: "danger", confirmLabel: "End sessions" }),
    );
    const calls = mocks.fetch.mock.calls;
    const w = calls.findIndex(([path, init]) => path === END && init?.method === "POST");
    expect(w).toBeGreaterThan(-1);
    expect(JSON.parse(String(calls[w][1].body))).toEqual({ reason: "OPERATOR_REVOKE" });
    const after = calls.slice(w + 1).map(([path]) => path);
    expect(after).toContain(ACTIVITY);
    expect(after).toContain(LIST);
    expect(document.querySelector('[data-activity-row="PORTAL_SESSION_REVOKED"]')).not.toBeNull();
    // The confirmation came before the write.
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[w]);
  });

  it("says so plainly when there was nothing to end", async () => {
    endReply = () => ({ ok: true, sessionsEnded: 0 });
    fireEvent.click(await openDrawer());
    await screen.findByText("sue@acme.com had no signed-in portal sessions. Nothing else changed.");
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const button = await openDrawer();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes()).toHaveLength(0);
    expect(button.disabled).toBe(false);
    expect(document.querySelector("[data-console-banner]")).toBeNull();
  });

  it("does not announce success when the reread fails", async () => {
    rereadFails = true;
    fireEvent.click(await openDrawer());
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText(/Ended 2 portal sessions/)).toBeNull();
  });

  it.each([
    [503, "SESSION_UNAVAILABLE", /session service is unavailable\. Nothing was changed/],
    [404, "INVITE_NOT_FOUND", /no longer available in this workspace\. Nothing was changed/],
    [403, "NOT_PERMITTED", /do not have permission to end this reviewer's sessions/],
  ])("explains a %s refusal in bounded copy", async (statusCode, code, copy) => {
    endReply = () => {
      throw Object.assign(new Error(`raw ${code} internal detail`), { statusCode, code });
    };
    fireEvent.click(await openDrawer());
    const notice = await screen.findByText(copy);
    expect(notice.closest("[data-console-banner]")?.getAttribute("data-console-banner-tone")).toBe("warn");
    expect(document.body.textContent).not.toContain(code);
    expect(document.body.textContent).not.toContain("internal detail");
    expect(screen.queryByText(/Ended \d+ portal/)).toBeNull();
  });

  it("is disabled, with the reason on screen, for a caller without the capability", async () => {
    mocks.canAct.value = false;
    const button = await openDrawer();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-capability-allowed")).toBe("false");
    const reasonId = button.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toMatch(
      /Only workspace administrators and supervisors can end a\s+reviewer.s portal sessions\./,
    );
    fireEvent.click(button);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });
});
