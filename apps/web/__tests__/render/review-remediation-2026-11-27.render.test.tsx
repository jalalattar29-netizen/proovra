/**
 * Review remediation 2026-11-27 — consumer surfaces outside the Review page,
 * rendered with the REAL apiFetch over a stubbed network:
 *
 *   F-03  Monitoring → Escalations: every move follows the row's
 *         `viewerActions`; a closed move stays visible, disabled, with its
 *         reason; the independence cause is said in words; a refusal shows the
 *         review refusal copy.
 *   F-11  Challenged decisions: a resolution sends the chosen verdict and
 *   F-22  rationale and says what the server superseded; the challenger is
 *         never offered a resolution, and an independence refusal names who
 *         can resolve and the staffing path.
 *   §2/3/6 Review settings: the three Review policy toggles, with plain
 *         explanations, saved through the existing flags body.
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chooseListbox } from "./_listbox";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/sla",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { EscalationsSection } from "../../app/(app)/reviewer-ops/escalations/_section";
import DisagreementsPage from "../../app/(app)/review/disagreements/page";
import { ReviewerSlaPolicyPanel } from "../../components/reviewer-experience/ReviewerSlaPolicyPanel";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "88888888-8888-4888-8888-888888888888";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ESC = "e0000000-0000-4000-8000-000000000001";
const DIS = "d0000000-0000-4000-8000-000000000001";
const WF = "11111111-2222-4333-8444-555555555555";

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }> = {};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  routes = {};
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const key = Object.keys(routes)
      .filter((k) => `${method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key) {
      const r = routes[key]!(init);
      return json(r.status, r.body);
    }
    if (path === "/v1/auth/me") return json(200, { user: { id: ME } });
    if (path === "/v1/identity/mfa/factors") return json(200, { hasMfa: true });
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { EVIDENCE_VIEW: true, REVIEWER_OPS_VIEW: true, REVIEWER_OPS_ACT: true, ESCALATIONS_VIEW: true, REVIEW_ASSIGN: true },
    diagnostics: { requestId: "review-remediation" },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role: "OWNER" } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { reviewerOperationsIncluded: true, reviewQueuesIncluded: true },
  };
}

function shell(children: React.ReactNode) {
  return (
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>{children}</ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>
  );
}

async function settle() {
  for (let i = 0; i < 14; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

// ---------------------------------------------------------------------------
// F-03 — Monitoring escalations follow viewerActions
// ---------------------------------------------------------------------------

function escalation(over: Record<string, unknown> = {}) {
  return {
    id: ESC,
    teamId: WS,
    workflowId: WF,
    evidenceId: null,
    reason: "INDEPENDENT_REVIEW_REQUESTED",
    severity: "WARNING",
    status: "OPEN",
    safeSummary: "Second pair of eyes",
    createdAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    resolutionNote: null,
    suppressedAtUtc: null,
    suppressionReason: null,
    assignedToUserId: null,
    incidentId: null,
    independenceCause: "independent_review_requested",
    independenceNote: "High-value matter",
    viewerActions: [
      { action: "acknowledge", allowed: true },
      { action: "reassign", allowed: true },
      { action: "resolve", allowed: false, reason: "resolver_is_assignee" },
      { action: "suppress", allowed: false, reason: "resolver_is_assignee" },
    ],
    ...over,
  };
}

describe("F-03 Monitoring escalations follow the row's viewerActions", () => {
  it("disables Resolve / Suppress with the independence reason, keeps the allowed moves, and names the cause", async () => {
    routes["GET /v1/reviewer-ops/escalations?"] = () => ({ status: 200, body: { escalations: [escalation()], total: 1 } });
    render(shell(<EscalationsSection />));
    await settle();
    const resolve = document.querySelector("[data-escalation-action-resolve]") as HTMLButtonElement;
    const suppress = document.querySelector("[data-escalation-action-suppress]") as HTMLButtonElement;
    const ack = document.querySelector("[data-escalation-action-acknowledge]") as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    expect(suppress.disabled).toBe(true);
    expect(ack.disabled).toBe(false);
    expect((document.querySelector("[data-escalation-action-reassign]") as HTMLButtonElement).disabled).toBe(false);
    // The reason is visible text, tied to the control.
    const reasonId = resolve.getAttribute("aria-describedby")!;
    expect(document.getElementById(reasonId)!.textContent).toMatch(/the reviewer it constrains cannot resolve it/);
    // The independence cause, in words.
    expect(document.querySelector("[data-escalation-independence]")!.textContent).toMatch(
      /^Requires an independent second decision because an independent review was requested\. Note: High-value matter/,
    );
    // Clicking a disabled Resolve opens nothing and posts nothing.
    fireEvent.click(resolve);
    await settle();
    expect(document.querySelector("[data-reviewer-reason-input]")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an administrative escalation says so; an older API without viewerActions keeps the status rule", async () => {
    const { viewerActions: _drop, ...legacy } = escalation({ reason: "WORKFLOW_STALLED", independenceCause: null, independenceNote: null });
    void _drop;
    routes["GET /v1/reviewer-ops/escalations?"] = () => ({ status: 200, body: { escalations: [legacy], total: 1 } });
    render(shell(<EscalationsSection />));
    await settle();
    expect(document.querySelector("[data-escalation-independence]")!.textContent).toBe(
      "Administrative — does not change who decides the review.",
    );
    expect((document.querySelector("[data-escalation-action-resolve]") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[data-escalation-action-reason]")).toBeNull();
  });

  it("a refused resolve shows the review refusal copy, not the generic text", async () => {
    routes["GET /v1/reviewer-ops/escalations?"] = () => ({
      status: 200,
      body: { escalations: [escalation({ viewerActions: [{ action: "resolve", allowed: true }] })], total: 1 },
    });
    routes[`POST /v1/reviewer-ops/escalations/${ESC}/resolve`] = () => ({
      status: 409,
      body: { error: { code: "REVIEW_ESCALATION_INDEPENDENCE_REQUIRED", details: { reason: "resolver_decided_this_round" } } },
    });
    render(shell(<EscalationsSection />));
    await settle();
    expect(document.querySelector("[data-escalation-action-acknowledge]")).toBeNull();
    fireEvent.click(document.querySelector("[data-escalation-action-resolve]")!);
    await settle();
    fireEvent.change(document.querySelector("[data-reviewer-reason-input]")!, { target: { value: "Handled" } });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-reviewer-reason-submit]")!);
    });
    await settle();
    expect(document.querySelector('[role="alert"].app-alert--danger')!.textContent).toMatch(
      /^You decided this review, so you cannot resolve the escalation/,
    );
  });
});

// ---------------------------------------------------------------------------
// F-11 / F-22 — Challenged decisions
// ---------------------------------------------------------------------------

function disagreement(over: Record<string, unknown> = {}) {
  return {
    id: DIS,
    workflowId: WF,
    state: "UNDER_SECOND_REVIEW",
    challengerUserId: OTHER,
    challengerRationale: "Wrong call",
    secondReviewerUserId: ME,
    supervisorUserId: null,
    originalDecisionId: "dec-1",
    filedAtUtc: "2026-11-25T00:00:00.000Z",
    resolvedAtUtc: null,
    ...over,
  };
}

describe("F-11 / F-22 Challenged decisions", () => {
  it("an overturn sends the chosen verdict and rationale and says the review was reopened for a new round", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({ status: 200, body: { disagreements: [disagreement()] } });
    routes[`POST /v1/reviewer/disagreements/${DIS}/transition`] = () => ({ status: 200, body: { ok: true, superseded: "reopen" } });
    render(shell(<DisagreementsPage />));
    await settle();
    fireEvent.click(document.querySelector('[data-disagreement-transition-btn="RESOLVED_OVERTURNED"]')!);
    await settle();
    expect(document.querySelector("[data-disagreement-resolve-effect]")!.textContent).toMatch(/reopened for a new round/);
    const submit = document.querySelector("[data-disagreement-resolve-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    chooseListbox(document.querySelector("[data-disagreement-resolve-verdict-select]"), "REJECT");
    fireEvent.change(document.querySelector("[data-disagreement-resolve-rationale]")!, { target: { value: "Custody gap confirmed." } });
    await settle();
    fireEvent.click(document.querySelector("[data-disagreement-resolve-submit]")!);
    await settle();
    const post = calls.find((c) => c.method === "POST" && c.path.includes(`/v1/reviewer/disagreements/${DIS}/transition`))!;
    expect(post.body).toEqual({ to: "RESOLVED_OVERTURNED", verdict: "REJECT", rationale: "Custody gap confirmed." });
    expect(document.querySelector("[data-disagreement-banner]")!.textContent).toMatch(
      /^The challenged outcome was overturned: the review was reopened for a new round\./,
    );
  });

  it("a restarted round and an already-superseded decision are said in plain words", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({ status: 200, body: { disagreements: [disagreement()] } });
    routes[`POST /v1/reviewer/disagreements/${DIS}/transition`] = () => ({ status: 200, body: { ok: true, superseded: "advance_round" } });
    render(shell(<DisagreementsPage />));
    await settle();
    fireEvent.click(document.querySelector('[data-disagreement-transition-btn="RESOLVED_PARTIAL"]')!);
    await settle();
    chooseListbox(document.querySelector("[data-disagreement-resolve-verdict-select]"), "NEEDS_INFO");
    fireEvent.change(document.querySelector("[data-disagreement-resolve-rationale]")!, { target: { value: "Partly." } });
    await settle();
    fireEvent.click(document.querySelector("[data-disagreement-resolve-submit]")!);
    await settle();
    expect(document.querySelector("[data-disagreement-banner]")!.textContent).toMatch(/partially overturned: the review's round restarted/);
  });

  it("a supersede failure (finding B) says nothing was recorded and keeps the rationale for a retry", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({ status: 200, body: { disagreements: [disagreement()] } });
    // The route's real (flat) body.
    routes[`POST /v1/reviewer/disagreements/${DIS}/transition`] = () => ({
      status: 409,
      body: { denial: "DISAGREEMENT_SUPERSEDE_FAILED", code: "DISAGREEMENT_SUPERSEDE_FAILED" },
    });
    render(shell(<DisagreementsPage />));
    await settle();
    fireEvent.click(document.querySelector('[data-disagreement-transition-btn="RESOLVED_OVERTURNED"]')!);
    await settle();
    chooseListbox(document.querySelector("[data-disagreement-resolve-verdict-select]"), "REJECT");
    fireEvent.change(document.querySelector("[data-disagreement-resolve-rationale]")!, { target: { value: "Custody gap confirmed." } });
    await settle();
    fireEvent.click(document.querySelector("[data-disagreement-resolve-submit]")!);
    await settle();
    const banner = document.querySelector("[data-disagreement-banner]")!.textContent!;
    expect(banner).toMatch(/^Not recorded: the challenged outcome could not be superseded/);
    expect(banner).toMatch(/the review is unchanged/);
    expect(banner).not.toMatch(/overturned: the review was reopened/);
    expect((document.querySelector("[data-disagreement-resolve-rationale]") as HTMLTextAreaElement).value).toBe("Custody gap confirmed.");
  });

  it("the challenger is not offered review or resolution, and is told who resolves it", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({
      status: 200,
      body: { disagreements: [disagreement({ challengerUserId: ME, state: "FILED", secondReviewerUserId: null })] },
    });
    render(shell(<DisagreementsPage />));
    await settle();
    expect(document.querySelector('[data-disagreement-transition-btn="UNDER_SECOND_REVIEW"]')).toBeNull();
    expect(document.querySelector('[data-disagreement-transition-btn="WITHDRAWN"]')).not.toBeNull();
    expect(document.querySelector("[data-disagreement-not-independent]")!.textContent).toMatch(/another owner or admin reviews and resolves it/);
  });

  it("the reviewer whose decision is challenged is not offered resolution: the page follows the server's viewerIndependent", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({
      status: 200,
      body: {
        disagreements: [
          disagreement({ state: "FILED", secondReviewerUserId: null, viewerIndependent: false, viewerNotIndependentReason: "made_challenged_decision" }),
        ],
      },
    });
    render(shell(<DisagreementsPage />));
    await settle();
    expect(document.querySelector('[data-disagreement-transition-btn="UNDER_SECOND_REVIEW"]')).toBeNull();
    expect(document.querySelector('[data-disagreement-transition-btn="RESOLVED_UPHELD"]')).toBeNull();
    expect(document.querySelector("[data-disagreement-not-independent]")!.textContent).toMatch(/You made the challenged decision/);
  });

  it("an independence refusal names who can resolve and the staffing path", async () => {
    routes["GET /v1/reviewer/disagreements"] = () => ({ status: 200, body: { disagreements: [disagreement()] } });
    routes[`POST /v1/reviewer/disagreements/${DIS}/transition`] = () => ({
      status: 409,
      body: { error: { code: "DISAGREEMENT_RESOLVER_NOT_INDEPENDENT", details: { reason: "DISAGREEMENT_RESOLVER_NOT_INDEPENDENT" } } },
    });
    render(shell(<DisagreementsPage />));
    await settle();
    fireEvent.click(document.querySelector('[data-disagreement-transition-btn="RESOLVED_UPHELD"]')!);
    await settle();
    chooseListbox(document.querySelector("[data-disagreement-resolve-verdict-select]"), "APPROVE");
    fireEvent.change(document.querySelector("[data-disagreement-resolve-rationale]")!, { target: { value: "Stands." } });
    await settle();
    fireEvent.click(document.querySelector("[data-disagreement-resolve-submit]")!);
    await settle();
    const banner = document.querySelector("[data-disagreement-banner]")!.textContent!;
    expect(banner).toMatch(/^Not recorded: /);
    expect(banner).toMatch(/owner or admin who neither filed this challenge nor made the challenged decision/);
    expect(banner).toMatch(/invite one from Members & access/);
    expect(document.querySelector("[data-disagreement-staffing-link]")!.getAttribute("href")).toBe("/people");
    // The resolution form and its text stay for whoever may retry.
    expect((document.querySelector("[data-disagreement-resolve-rationale]") as HTMLTextAreaElement).value).toBe("Stands.");
  });
});

// ---------------------------------------------------------------------------
// Review settings — the three Review policy toggles
// ---------------------------------------------------------------------------

function policy(flags: Record<string, unknown> = {}) {
  return {
    policy: {
      policy: { assignmentHours: 2, firstReviewHours: 24, completionHours: 72, escalationHours: 48, dueSoonHours: 8 },
      sources: { template: {}, workspace: { assignmentHours: 2 }, env: {} },
    },
    flags: {
      requireStepUpForApprove: false,
      requireStepUpForReject: false,
      requireStepUpForEscalationResolve: false,
      requireStepUpForBulk: false,
      reviewerInactivityHours: null,
      reviewRequiresIndependentApproval: false,
      reviewRequiresTeamPlacement: false,
      reviewRequiresCompleteCoding: true,
      reviewRequiresCompleteCodingSince: "2026-11-27T08:00:00.000Z",
      ...flags,
    },
    version: 3,
    teamId: WS,
  };
}

describe("Review settings — Review policy toggles", () => {
  it("shows the three policies with plain explanations and saves them through the flags body", async () => {
    routes[`GET /v1/reviewer-ops/sla-policy?teamId=${WS}`] = () => ({ status: 200, body: policy() });
    routes["POST /v1/reviewer-ops/sla-policy"] = () => ({ status: 200, body: policy({ reviewRequiresIndependentApproval: true }) });
    render(<ReviewerSlaPolicyPanel teamId={WS} canEdit />);
    await settle();
    const section = document.querySelector("[data-review-policy-section]")!;
    expect(section.textContent).toMatch(/Every review needs an independent second decision/);
    expect(section.textContent).toMatch(/Reviewers must be placed in a Collaboration Team/);
    expect(section.textContent).toMatch(/Approving or rejecting requires complete coding \(applies to reviews started after you turn it on\)/);
    expect(section.textContent).toMatch(/Requesting information is never blocked/);
    expect(section.textContent).toMatch(/On since /);
    const independent = document.querySelector('[data-review-policy-flag-input="reviewRequiresIndependentApproval"]') as HTMLInputElement;
    const coding = document.querySelector('[data-review-policy-flag-input="reviewRequiresCompleteCoding"]') as HTMLInputElement;
    expect(independent.checked).toBe(false);
    expect(coding.checked).toBe(true);
    expect(independent.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(independent);
    await settle();
    fireEvent.submit(document.querySelector("[data-review-sla-policy]")!);
    await settle();
    const save = calls.find((c) => c.method === "POST" && c.path === "/v1/reviewer-ops/sla-policy")!;
    expect((save.body as { flags: Record<string, unknown> }).flags).toEqual({ reviewRequiresIndependentApproval: true });
  });

  it("a read-only viewer sees each policy as On / Off", async () => {
    routes[`GET /v1/reviewer-ops/sla-policy?teamId=${WS}`] = () => ({ status: 200, body: policy() });
    render(<ReviewerSlaPolicyPanel teamId={WS} canEdit={false} />);
    await settle();
    expect(document.querySelector('[data-review-policy-flag="reviewRequiresCompleteCoding"]')!.textContent).toMatch(/On$/);
    expect(document.querySelector('[data-review-policy-flag="reviewRequiresTeamPlacement"]')!.textContent).toMatch(/Off$/);
    expect(document.querySelector("[data-review-policy-flag-input]")).toBeNull();
  });
});
