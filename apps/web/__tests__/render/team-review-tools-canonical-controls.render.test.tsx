/**
 * TEAM-UI-SPEC §1 / §4 — the Team Review tool pages render the canonical
 * Evidence Library controls, not the legacy `<Button>`.
 *
 *   QC, coding schemas, disagreements, metrics and External Review:
 *     - no `ui-button` anywhere on the page;
 *     - a canonical PageShell header (`ui-page-header`, one <h1>);
 *     - row actions are secondary/ghost, the one forward action is
 *       `app-primary-action`;
 *     - destructive styling ONLY on irreversible actions: Archive schema and
 *       Revoke / End sessions / token reveal are `app-secondary-action--danger`
 *       entry points, the reveal confirm is `app-danger-action`; a QC FAIL or
 *       a disagreement resolution is a verdict (primary), never red;
 *     - the External Review console tabs are `app-tabs` / `app-tab`.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ME = "99999999-9999-4999-8999-999999999991";
const SAMPLE = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const SCHEMA = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const DISAGREEMENT = "55555555-5555-4555-8555-555555555555";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  confirm: vi.fn(),
  role: { value: "ADMIN" },
  metricsFail: { value: false },
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  useActiveSpace: () => ({ type: "ORGANIZATION", roleLabel: mocks.role.value }),
  useCan: () => true,
  usePlatformContext: () => ({ envelope: { account: { userId: "99999999-9999-4999-8999-999999999991" } } }),
  useOptionalPlatformContext: () => ({ envelope: { user: { id: "99999999-9999-4999-8999-999999999991" } } }),
  // TEAM-UI-SPEC (structure) — External review's "← Review" back link asks the
  // review-destination resolver whether /review opens (it is also on Pro).
  useWorkspaceFragment: () => null,
  usePersonalSpaceFragment: () => null,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
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

import QcPage from "../../app/(app)/review/qc/page";
import CodingSchemasPage from "../../app/(app)/review/schemas/page";
import DisagreementsPage from "../../app/(app)/review/disagreements/page";
import ReviewerMetricsPage from "../../app/(app)/review/metrics/page";
import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const INVITATION = {
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
  viewerCanRevoke: true,
};

function reply(path: string): unknown {
  if (path.startsWith("/v1/reviewer/workspace")) {
    return { workspace: { capabilities: ["review.assign", "review.qc.verdict", "review.schema.author"] } };
  }
  if (path.startsWith("/v1/reviewer-ops/assignable-reviewers")) return { reviewers: [{ userId: ME, displayName: "Dana" }] };
  if (path.startsWith("/v1/reviewer/qc/samples")) {
    return {
      samples: [
        { id: SAMPLE, workflowId: WORKFLOW, state: "ASSIGNED", verdict: null, failureReason: null, sampledAtUtc: "2026-02-01T00:00:00.000Z", qcReviewerUserId: ME },
      ],
    };
  }
  if (path.startsWith("/v1/coding/schemas")) {
    return { schemas: [{ id: SCHEMA, slug: "privilege_review", label: "Privilege review", category: "PRIVILEGE", version: 1, status: "PUBLISHED", fields: [] }] };
  }
  if (path.startsWith("/v1/reviewer/disagreements")) {
    return {
      disagreements: [
        { id: DISAGREEMENT, workflowId: WORKFLOW, state: "UNDER_SECOND_REVIEW", challengerUserId: ME, challengerRationale: "Wrong call", secondReviewerUserId: null, supervisorUserId: null, originalDecisionId: null, filedAtUtc: "2026-02-01T00:00:00.000Z", resolvedAtUtc: null },
      ],
    };
  }
  if (path.startsWith("/v1/reviewer/metrics")) {
    if (mocks.metricsFail.value) throw Object.assign(new Error("down"), { statusCode: 503 });
    return { metrics: { throughput7d: 3, approvalRate7dPct: 50, escalationRate7dPct: 0, disagreementRate7dPct: 0, qcFailureRate7dPct: 0, avgReviewDurationMs7d: 1000 } };
  }
  if (path === "/v1/external-review/invitations") return { invitations: [INVITATION], viewerCanIssue: true };
  if (path.endsWith("/activity")) return { activity: [] };
  if (path.endsWith("/delivery")) return { deliveries: [] };
  if (path.endsWith("/feedback")) return { decisions: [], comments: [] };
  return {};
}

beforeEach(() => {
  mocks.role.value = "ADMIN";
  mocks.metricsFail.value = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => reply(path));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(false);
});
afterEach(cleanup);

function expectNoLegacyButtons() {
  expect(document.querySelectorAll(".ui-button, [data-ui-button]")).toHaveLength(0);
}
function expectCanonicalHeader(title: string) {
  const header = document.querySelector("[data-ui-page-header]");
  expect(header).not.toBeNull();
  const h1s = document.querySelectorAll("h1");
  expect(h1s).toHaveLength(1);
  expect(h1s[0]!.textContent).toBe(title);
}
const cls = (el: Element | null) => (el as HTMLElement | null)?.className ?? "";

describe("QC", () => {
  it("uses the canonical header, secondary row verdicts and a primary FAIL submit — never red", async () => {
    render(<QcPage />);
    const fail = await waitFor(() => {
      const el = document.querySelector('[data-qc-verdict-btn="FAIL"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await waitFor(() => expect(fail.hasAttribute("disabled")).toBe(false));
    expectCanonicalHeader("Quality control");
    for (const v of ["PASS", "FAIL", "PARTIAL"]) {
      const b = document.querySelector(`[data-qc-verdict-btn="${v}"]`);
      expect(cls(b)).toBe("app-secondary-action");
    }
    fireEvent.click(fail);
    const submit = await waitFor(() => document.querySelector("[data-qc-fail-submit]") as HTMLButtonElement);
    expect(cls(submit)).toBe("app-primary-action");
    expect(cls(document.querySelector("[data-qc-fail-cancel]"))).toBe("app-secondary-action");
    expect(submit.getAttribute("data-disabled-reason")).toBe("Choose a failure reason.");
    expect(document.querySelectorAll(".app-danger-action, .app-secondary-action--danger")).toHaveLength(0);
    expect(document.querySelector("[data-qc-table]")?.hasAttribute("data-responsive")).toBe(true);
    expectNoLegacyButtons();
  });
});

describe("Coding schemas", () => {
  it("Seed is the one primary and Archive is a --danger entry point", async () => {
    render(<CodingSchemasPage />);
    const archive = await screen.findByRole("button", { name: "Archive Privilege review" });
    expect(cls(archive)).toBe("app-secondary-action app-secondary-action--danger");
    expect(cls(document.querySelector("[data-coding-seed-defaults]"))).toBe("app-primary-action");
    expect(document.querySelectorAll(".app-primary-action")).toHaveLength(1);
    expect(document.querySelectorAll(".app-danger-action")).toHaveLength(0);
    expectCanonicalHeader("Coding schemas");
    expectNoLegacyButtons();
  });
});

describe("Disagreements", () => {
  it("uses the canonical header, secondary transitions and a primary resolution submit", async () => {
    render(<DisagreementsPage />);
    const upheld = await waitFor(() => {
      const el = document.querySelector('[data-disagreement-transition-btn="RESOLVED_UPHELD"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    expectCanonicalHeader("Disagreements");
    for (const b of Array.from(document.querySelectorAll("[data-disagreement-transition-btn]"))) {
      expect(cls(b)).toBe("app-secondary-action");
    }
    fireEvent.click(upheld);
    await waitFor(() => expect(cls(upheld)).toBe("app-secondary-action app-secondary-action--filled"));
    expect(cls(document.querySelector("[data-disagreement-resolve-submit]"))).toBe("app-primary-action");
    expect(cls(document.querySelector("[data-disagreement-resolve-cancel]"))).toBe("app-secondary-action");
    const other = document.querySelector('[data-disagreement-transition-btn="UNDER_SUPERVISOR_REVIEW"]');
    expect(other?.getAttribute("data-disabled-reason")).toBe("Finish or cancel the open resolution first.");
    expect(document.querySelectorAll(".app-danger-action, .app-secondary-action--danger")).toHaveLength(0);
    expectNoLegacyButtons();
  });
});

describe("Metrics", () => {
  it("renders metric panels and a secondary Retry on failure", async () => {
    render(<ReviewerMetricsPage />);
    await waitFor(() => expect(document.querySelectorAll("[data-reviewer-metric-card]").length).toBe(6));
    expect(cls(document.querySelector("[data-reviewer-metric-card]"))).toBe("app-panel");
    expectNoLegacyButtons();
    cleanup();
    mocks.metricsFail.value = true;
    render(<ReviewerMetricsPage />);
    const retry = await waitFor(() => {
      const el = document.querySelector("[data-reviewer-metrics-retry]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(cls(retry)).toBe("app-secondary-action");
    expectNoLegacyButtons();
  });
});

describe("External Review console", () => {
  async function openDrawer() {
    render(<ExternalInvitationsPage />);
    const row = await waitFor(() => {
      const el = document.querySelector(`[data-invitation-row="${GRANT}"]`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(screen.getByRole("button", { name: "Open sue@acme.com" }));
    await screen.findByRole("button", { name: "End sessions" });
    return row;
  }

  it("renders the lifecycle tabs as app-tabs with tab semantics", async () => {
    render(<ExternalInvitationsPage />);
    await waitFor(() => expect(document.querySelector(`[data-invitation-row="${GRANT}"]`)).not.toBeNull());
    const nav = document.querySelector("[data-console-tabs]") as HTMLElement;
    expect(nav.className).toBe("app-tabs");
    expect(nav.getAttribute("role")).toBe("tablist");
    expect(nav.style.overflowX).toBe("auto");
    const tabs = screen.getAllByRole("tab");
    // T-136 — five lifecycle statuses; "Bulk Invite" is no longer a tab.
    expect(tabs).toHaveLength(5);
    expect(tabs.map((t) => t.textContent ?? "").some((label) => /invite/i.test(label))).toBe(false);
    for (const t of tabs) expect(t.classList.contains("app-tab")).toBe(true);
    const active = document.querySelector('[data-tab="active"]') as HTMLElement;
    expect(active.className).toBe("app-tab is-active");
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-invitations-table]")?.hasAttribute("data-responsive")).toBe(true);
    fireEvent.keyDown(active, { key: "ArrowRight" });
    await waitFor(() => expect(document.querySelector('[data-tab="pending"]')?.getAttribute("data-tab-active")).toBe("true"));
    // TEAM-UI-SPEC (structure) — the tool name, as the Review tools panel names it.
    expectCanonicalHeader("External review");
    expectNoLegacyButtons();
  });

  it("styles only the irreversible drawer actions as destructive", async () => {
    await openDrawer();
    expect(cls(document.querySelector("[data-bulk-revoke-action]"))).toBe("app-secondary-action app-secondary-action--danger");
    expect(cls(document.querySelector("[data-invitation-revoke]"))).toBe("app-secondary-action app-secondary-action--danger");
    expect(cls(document.querySelector("[data-invitation-end-sessions]"))).toBe("app-secondary-action app-secondary-action--danger");
    expect(cls(document.querySelector("[data-invitation-resend]"))).toBe("app-secondary-action");
    expect(cls(document.querySelector("[data-drawer-close]"))).toBe("app-ghost-action");
    expect(cls(document.querySelector("[data-break-glass-arm]"))).toBe("app-secondary-action app-secondary-action--danger");
    // ADMIN cannot reveal; the gate stays a disabled control with its reason.
    expect(document.querySelector("[data-break-glass-arm]")?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-break-glass-arm]")?.getAttribute("data-capability-allowed")).toBe("false");
    for (const b of Array.from(document.querySelectorAll("button"))) {
      expect(b.getAttribute("style") ?? "").not.toMatch(/background|color|border|box-shadow/);
    }
    expectNoLegacyButtons();
  });

  it("confirms a token reveal with app-danger-action beside a secondary Cancel", async () => {
    mocks.role.value = "OWNER";
    await openDrawer();
    fireEvent.click(document.querySelector("[data-break-glass-arm]") as HTMLElement);
    const confirm = await waitFor(() => document.querySelector("[data-break-glass-confirm]") as HTMLElement);
    expect(cls(confirm)).toBe("app-danger-action");
    expect(cls(document.querySelector("[data-break-glass-cancel]"))).toBe("app-secondary-action");
    fireEvent.click(confirm);
    const err = await screen.findByRole("alert");
    expect(err.closest("[data-break-glass-form]")).not.toBeNull();
    expect(document.querySelectorAll(".app-danger-action")).toHaveLength(1);
  });

  it("makes Issue the one primary while the invite form is open (T-136: inviting is an action, not a tab)", async () => {
    render(<ExternalInvitationsPage />);
    await waitFor(() => expect(document.querySelector(`[data-invitation-row="${GRANT}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector("[data-invite-reviewer-action]") as HTMLElement);
    const submit = await waitFor(() => document.querySelector("[data-bulk-issue-submit]") as HTMLElement);
    expect(cls(submit)).toBe("app-primary-action");
    expect(document.querySelectorAll(".app-primary-action")).toHaveLength(1);
    expect(document.querySelector("[data-bulk-revoke-action]")).toBeNull();
    expectNoLegacyButtons();
  });
});
