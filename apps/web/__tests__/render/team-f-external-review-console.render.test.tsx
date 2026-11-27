/**
 * Team remediation stage F — the External Review console (T-136, T-155,
 * T-156, T-157, T-158; audit O-06, JRN-08 s–v).
 *
 * The REAL apiFetch over a recording `fetch` (so a failed read is the shape
 * the page really receives). Each case failed on the audited console:
 *   - "Bulk Invite" was a tab and there was no single invite entry;
 *   - an empty hours field left Issue enabled (and issued an expired invite);
 *   - a list over 100 rows was silently cut, and an invalid address was sent;
 *   - Resend and Revoke stayed enabled on a revoked row;
 *   - a failed list or drawer read rendered as an empty tab / "nothing yet".
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  const space = { type: "ORGANIZATION", roleLabel: "ADMIN" };
  return {
    useCan: () => true,
    useActiveSpace: () => space,
    useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    // F-33 — the External Review page reads the canonical active workspace id.
    useActiveWorkspaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    usePlatformContext: () => ({ envelope: null }),
    useWorkspaceFragment: () => null,
    usePersonalSpaceFragment: () => null,
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
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true, askReason: async () => null }),
}));

import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const LIST = "/v1/external-review/invitations";
const REVOKED = "44444444-4444-4444-8444-444444444444";
const LIVE = "55555555-5555-4555-8555-555555555555";

function invitation(grantId: string, over: Record<string, unknown> = {}) {
  return {
    grantId,
    inviteEmail: `${grantId.slice(0, 4)}@example.com`,
    role: "EXTERNAL_REVIEWER",
    authMethod: "TOKEN",
    mfaRequired: false,
    watermarkPolicy: "ALWAYS",
    grantState: "ACTIVE",
    expired: false,
    expiresAtUtc: "2026-12-30T00:00:00.000Z",
    inviteSentAtUtc: "2026-11-20T00:00:00.000Z",
    inviteAcceptedAtUtc: "2026-11-21T00:00:00.000Z",
    allowedDomains: [],
    ssoConnectionId: null,
    ssoSubjectHash: null,
    ssoBoundAtUtc: null,
    viewerCanRevoke: true,
    ...over,
  };
}

type Answer = { status: number; body: unknown } | "network";
let answers: Record<string, Answer[]>;
let calls: Array<{ path: string; method: string }>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      const queue = answers[`${method} ${path.split("?")[0]}`];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (next === "network") throw new TypeError("Failed to fetch");
      if (next) return json(next.status, next.body);
      if (method === "GET" && path === LIST) {
        return json(200, { invitations: [invitation(REVOKED, { grantState: "REVOKED" }), invitation(LIVE)], viewerCanIssue: true });
      }
      if (method === "GET" && path.startsWith("/v1/evidence?")) {
        return json(200, { items: [{ id: "11111111-1111-4111-8111-111111111111", title: "Dock camera footage", createdAt: "2026-01-01T00:00:00.000Z" }] });
      }
      if (method === "GET" && /\/(activity|feedback|delivery)$/.test(path)) {
        return json(200, { activity: [], decisions: [], comments: [], deliveries: [] });
      }
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

async function openInvite() {
  render(<ExternalInvitationsPage />);
  await flush();
  const action = document.querySelector("[data-invite-reviewer-action]") as HTMLButtonElement;
  expect(action).not.toBeNull();
  await act(async () => {
    action.click();
  });
  await flush();
  // A real scope target, so the reasons below are the first that apply.
  fireEvent.click(screen.getByRole("radio", { name: /^Evidence record/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ }));
  await flush();
}
const issue = () => document.querySelector("[data-bulk-issue-submit]") as HTMLButtonElement;
const reason = (b: HTMLElement) =>
  (b.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
const bulkPosts = () => calls.filter((c) => c.method === "POST" && c.path === `${LIST}/bulk`);

describe("External Review console — stage F", () => {
  it("T-136: an 'Invite reviewer' action exists and no tab is named Bulk Invite", async () => {
    render(<ExternalInvitationsPage />);
    await flush();
    expect(screen.getByRole("button", { name: "Invite reviewer" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    expect(tabs.some((t) => /bulk invite/i.test(t))).toBe(false);
    expect(tabs).toHaveLength(5);
  });

  it("T-155: an empty or non-numeric hours field disables Issue with the reason; a valid one enables it", async () => {
    await openInvite();
    fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, { target: { value: "sue@acme.com" } });
    const hours = document.querySelector("[data-bulk-default-hours]") as HTMLInputElement;
    fireEvent.change(hours, { target: { value: "" } });
    expect(issue().disabled).toBe(true);
    expect(reason(issue())).toContain("whole number of hours");
    expect(hours.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(hours, { target: { value: "0" } });
    expect(issue().disabled).toBe(true);
    fireEvent.change(hours, { target: { value: "721" } });
    expect(issue().disabled).toBe(true);
    fireEvent.click(issue());
    expect(bulkPosts()).toHaveLength(0);
    fireEvent.change(hours, { target: { value: "48" } });
    expect(reason(issue())).not.toContain("whole number of hours");
  });

  it("T-156: one invalid address of three is flagged and nothing is sent; over 100 rows is stated, never cut", async () => {
    await openInvite();
    fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, {
      target: { value: "a@acme.com\nnot-an-email\nc@acme.com" },
    });
    expect(document.querySelectorAll('[data-bulk-paste-valid="false"]')).toHaveLength(1);
    expect(issue().disabled).toBe(true);
    expect(reason(issue())).toContain("1 of 3 address is not a valid e-mail address");
    fireEvent.click(issue());
    expect(bulkPosts()).toHaveLength(0);

    const many = Array.from({ length: 103 }, (_, i) => `r${i}@acme.com`).join("\n");
    fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, { target: { value: many } });
    expect(document.querySelectorAll("[data-bulk-paste-row]")).toHaveLength(103);
    expect(issue().disabled).toBe(true);
    expect(reason(issue())).toContain("You entered 103 reviewers");
  });

  it("T-157: Resend and Revoke are disabled with a reason on a revoked row", async () => {
    render(<ExternalInvitationsPage />);
    await flush();
    await act(async () => {
      (document.querySelector('[data-tab="revoked"]') as HTMLElement).click();
    });
    await flush();
    await act(async () => {
      (document.querySelector(`[data-invitation-row="${REVOKED}"]`) as HTMLElement).click();
    });
    await flush();
    const resend = document.querySelector(`[data-invitation-resend="${REVOKED}"]`) as HTMLButtonElement;
    const revoke = document.querySelector(`[data-invitation-revoke="${REVOKED}"]`) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(revoke.disabled).toBe(true);
    expect(reason(revoke)).toContain("was revoked");
  });

  it("T-158: a failed list read shows an error with Retry, not the empty tab; Retry reloads", async () => {
    answers[`GET ${LIST}`] = [{ status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } }, { status: 200, body: { invitations: [invitation(LIVE)], viewerCanIssue: true } }];
    render(<ExternalInvitationsPage />);
    await flush();
    expect(document.querySelector("[data-external-review-list-error]")).not.toBeNull();
    expect(document.querySelector("[data-invitations-empty]")).toBeNull();
    await act(async () => {
      (document.querySelector("[data-external-review-list-retry]") as HTMLElement).click();
    });
    await flush();
    expect(document.querySelector("[data-external-review-list-error]")).toBeNull();
    expect(document.querySelector(`[data-invitation-row="${LIVE}"]`)).not.toBeNull();
  });

  it("T-158: a failed drawer read shows an error with Retry, not 'No activity recorded yet'", async () => {
    answers[`GET ${LIST}/${LIVE}/activity`] = [{ status: 503, body: { error: { code: "UNAVAILABLE", message: "x" } } }, { status: 200, body: { activity: [] } }];
    answers[`GET ${LIST}/${LIVE}/delivery`] = ["network", { status: 200, body: { deliveries: [] } }];
    render(<ExternalInvitationsPage />);
    await flush();
    await act(async () => {
      (document.querySelector(`[data-invitation-row="${LIVE}"]`) as HTMLElement).click();
    });
    await flush();
    expect(document.querySelector("[data-drawer-activity-error]")).not.toBeNull();
    expect(document.querySelector("[data-drawer-delivery-error]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("No activity recorded yet.");
    expect(document.body.textContent).not.toContain("No invitation emails have been sent yet.");
    await act(async () => {
      (document.querySelector("[data-drawer-retry]") as HTMLElement).click();
    });
    await waitFor(() => expect(document.querySelector("[data-drawer-activity-error]")).toBeNull());
    expect(document.body.textContent).toContain("No activity recorded yet.");
  });
});
