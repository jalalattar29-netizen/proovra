/**
 * Team remediation — Stage A (2026-11-24): the decision surfaces, rendered with
 * the REAL apiFetch (only `fetch` is stubbed). Each case fails on e4e908e88.
 *
 *   T-001…T-006  focus mode decides through the shared decision panel and the
 *                canonical door: a refused verdict keeps the text and alerts
 *                beside the controls; the outcome copy is the shared one; an
 *                assigned review offers Start and closes the verdicts with the
 *                server's reason; a non-assignee sees closed verdicts; Escalate
 *                is the shared dialog with the chosen reason and severity.
 *   T-012        one rationale field in the decision form.
 *   T-015        the requirement and "none eligible" before submission; submit closed.
 *   T-022/23/24  the governing requirement of the recorded decisions; every
 *                round; External Review feedback as advisory.
 *   T-008        the Evidence page links to the Review page and is no parallel verdict door.
 *   T-009        Reopen on the Review page.
 *   T-019        the Escalate dialog states the independence consequence.
 *   T-020        the next step is never a no-op Start on a review in review.
 *   T-007        /review/operations redirects and is not offered in the palette.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DecisionForm } from "../../app/(app)/reviewer-ops/[reviewId]/_components/DecisionPanel";
import { ReviewerDecisionLineagePanel } from "../../app/(app)/reviewer-ops/[reviewId]/_components/DecisionLineagePanel";
import { InspectorActions } from "../../app/(app)/reviewer-ops/[reviewId]/_components/InspectorActions";
import { EscalateDialog } from "../../app/(app)/reviewer-ops/[reviewId]/_components/InspectorDialogs";
import { EvidenceReviewActionsPanel } from "../../app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel";
import {
  deriveActions,
  nextStepPrimary,
  type Viewer,
} from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { reviewOperationsRedirectTarget } from "../../lib/navigation/review-operations-redirect";
import { ROUTE_REGISTRY } from "../../lib/navigation/routeRegistry";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/review/workspace",
  useParams: () => ({}),
}));

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";

const ALL = [
  "start",
  "pause",
  "resume",
  "request_info",
  "record_response",
  "approve",
  "reject",
  "reassign",
  "adjudicate",
  "archive",
  "reopen",
  "escalate",
];
function viewerWith(allowed: string[], reasons: Record<string, string> = {}, isAssignee = true): Viewer {
  return {
    userId: "u-1",
    isAssignee,
    escalationForcesIndependentReview: true,
    actions: ALL.map((a) =>
      allowed.includes(a)
        ? { action: a as never, allowed: true }
        : { action: a as never, allowed: false, reason: reasons[a] ?? reasons["*"] ?? "invalid_transition" },
    ),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let workspace: Record<string, unknown>;
let decisions: Record<string, unknown>;
let postResponses: Record<string, () => Response>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const fetchMock = vi.fn();

const wsPath = `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`;
const decPath = `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${teamId}`;

function workspaceBody(lifecycle: string, viewer: Viewer) {
  return {
    projection: { workflowId, evidenceId, lifecycleState: lifecycle, assignedToUserId: "u-1", slaPausedAtUtc: null },
    viewer,
  };
}
function decisionsBody(state: string, nextAction: string, extra: Record<string, unknown> = {}) {
  return {
    workflowId,
    evidenceId,
    state,
    secondReviewRequirement: { required: false, reason: null },
    callerContext: { userId: "u-1", teamRole: "MEMBER", isAdjudicator: false, callerIsFirstReviewer: false, nextAction },
    decisions: [],
    ...extra,
  };
}

beforeEach(() => {
  workspace = workspaceBody("IN_REVIEW", viewerWith(["approve", "reject", "request_info", "escalate"]));
  decisions = decisionsBody("first_required", "submit_first");
  postResponses = {};
  calls.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && path === wsPath) return json(200, workspace);
    if (method === "GET" && path === decPath) return json(200, decisions);
    if (method === "POST" && postResponses[path]) return postResponses[path]!();
    if (method === "POST") return json(200, { ok: true });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const choice = (kind: string) => document.querySelector(`[data-decision-choice="${kind}"]`) as HTMLButtonElement | null;
const rationale = () => document.querySelector("[data-decision-form-rationale]") as HTMLTextAreaElement | null;

// T-001 … T-006 — focus mode is the Review page itself since stage D (T-077):
// its decision, Start, refusal and Escalate behaviour is proven on the page in
// review-focus-mode.render.test.tsx.

describe("the decision form (T-012, T-015)", () => {
  const actions = deriveActions({ viewer: viewerWith(["approve", "reject", "request_info"]), lifecycleState: "IN_REVIEW", paused: false });
  it("has ONE rationale field and no separate optional Reason control", () => {
    render(<DecisionForm mode="decision" stage="FIRST" actions={actions} reviewState="first_required" secondRequired={false} onSubmit={async () => null} />);
    expect(document.querySelectorAll("[data-decision-form] textarea")).toHaveLength(1);
    expect(screen.queryByText(/optional but recommended/i)).toBeNull();
    expect(document.querySelector("[data-decision-rationale-group] [data-decision-form-rationale]")).toBeTruthy();
  });
  it("closes submission before sending when nobody can give the second review", async () => {
    const onSubmit = vi.fn(async () => null);
    render(
      <DecisionForm
        mode="decision"
        stage="FIRST"
        actions={actions}
        reviewState="first_required"
        secondRequired
        onSubmit={onSubmit}
        blockedReason="Independent reviewer required — none eligible. Invite or place a reviewer, or keep the review open."
      />,
    );
    fireEvent.click(choice("REJECT")!);
    fireEvent.change(rationale()!, { target: { value: "gap" } });
    expect((document.querySelector("[data-decision-form-submit]") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-decision-form-blocked]")?.textContent).toMatch(/none eligible/);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("the decision panel's requirement and history (T-015, T-022, T-023, T-024)", () => {
  const actions = deriveActions({ viewer: viewerWith(["approve", "reject", "request_info"]), lifecycleState: "IN_REVIEW", paused: false });
  const rowOf = (id: string, stage: string, decision: string, round: number) => ({
    id,
    stage,
    decision,
    round,
    reasonCode: null,
    rationale: `${stage} ${decision}`,
    decidedAt: "2026-11-21T10:00:00.000Z",
    reviewer: { userId: `u-${id}`, email: null, displayName: `Reviewer ${id}` },
  });
  const panel = () =>
    render(
      <ReviewerDecisionLineagePanel
        workflowId={workflowId}
        teamId={teamId}
        onSubmitDecision={async () => null}
        actions={actions}
        mayDecide
        mayAdjudicate={false}
        adjudicationBlockedReason={null}
        focusRequest={null}
      />,
    );

  it("states the requirement, its cause and that nobody is eligible BEFORE submission", async () => {
    decisions = decisionsBody("first_required", "submit_first", {
      secondReviewRequirement: { required: true, reason: "open_escalation" },
      secondReview: { required: true, cause: "open_escalation", escalation: { reason: "INTEGRITY_RISK", severity: "HIGH" }, eligibleReviewerCount: 0, staffing: "no_eligible_second_reviewer" },
    });
    panel();
    const line = await waitFor(() => {
      const el = document.querySelector("[data-decision-second-review-staffing]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(line.textContent).toMatch(/first of two because an escalation is open/);
    expect(line.textContent).toMatch(/Independent reviewer required — none eligible/);
    expect((document.querySelector("[data-decision-form-submit]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("describes a two-reviewer decision from the record, lists every round and shows external feedback as advisory", async () => {
    decisions = decisionsBody("resolved", "no_action_resolved", {
      round: 1,
      governing: { reviewers: 2, secondReviewRequired: true, cause: "active_legal_hold" },
      rounds: [
        { round: 0, current: false, settledBy: "request_info", governing: { reviewers: 1, secondReviewRequired: false, cause: null }, decisions: [rowOf("a", "FIRST", "REQUEST_INFO", 0)] },
        {
          round: 1,
          current: true,
          settledBy: "decision",
          governing: { reviewers: 2, secondReviewRequired: true, cause: "active_legal_hold" },
          decisions: [rowOf("b", "FIRST", "APPROVE", 1), rowOf("c", "SECOND", "APPROVE", 1)],
        },
      ],
      externalFeedback: [
        { id: "x1", verdict: "REJECT", rationale: "Timestamp gap", reviewer: { email: "out@example.test", displayName: "Outside Counsel" }, submittedAt: "2026-11-21T11:00:00.000Z", advisory: true },
      ],
    });
    panel();
    await waitFor(() => expect(document.querySelector("[data-decision-governing]")).toBeTruthy());
    expect(document.querySelector("[data-decision-governing]")!.textContent).toMatch(/Decided by two reviewers/);
    expect(document.body.textContent).not.toMatch(/One review decides this review/);
    expect(document.querySelectorAll("[data-decision-round]")).toHaveLength(2);
    expect(document.querySelector('[data-decision-round="0"]')!.textContent).toMatch(/request for information/);
    const ext = document.querySelector("[data-decision-external-feedback]")!;
    expect(ext.textContent).toMatch(/Advisory only/);
    expect(ext.textContent).toMatch(/Outside Counsel/);
  });
});

describe("Review page controls (T-009, T-019, T-020)", () => {
  it("offers Reopen on a finished review", () => {
    const reopen = vi.fn();
    const actions = deriveActions({ viewer: viewerWith(["reopen"]), lifecycleState: "REJECTED", paused: false });
    render(
      <InspectorActions
        actions={actions}
        primary={null}
        handlers={{
          start: () => {},
          record_response: () => {},
          pause: () => {},
          resume: () => {},
          reassign: () => {},
          assign_second_reviewer: () => {},
          escalate: () => {},
          archive: () => {},
          reopen,
          go_to_decision: () => {},
        }}
        busy={null}
        paused={false}
        fromViewer
        canEscalate={false}
        canArchive={false}
      />,
    );
    fireEvent.click(document.querySelector('[data-reviewer-action="reopen"]')!);
    expect(reopen).toHaveBeenCalled();
  });

  it("the Escalate dialog says whether the escalation forces an independent second review", () => {
    render(<EscalateDialog open onCancel={() => {}} onSubmit={async () => null} forcesIndependentReview />);
    expect(document.querySelector("[data-reviewer-escalate-independence]")?.textContent).toMatch(/requires an independent second review/);
    cleanup();
    render(<EscalateDialog open onCancel={() => {}} onSubmit={async () => null} forcesIndependentReview={false} />);
    expect(document.querySelector("[data-reviewer-escalate-independence]")).toBeNull();
  });

  it("after a first-of-two decision the next step is the hand-off, never a no-op Start", () => {
    // E2E (d): start was still allowed by an older server; the hand-off wins.
    const actions = deriveActions({ viewer: viewerWith(["start", "reassign"]), lifecycleState: "ESCALATED", paused: false });
    expect(nextStepPrimary({ actions, mayDecide: false, mayAdjudicate: false, handoffAssign: true })).toBe("assign_second_reviewer");
    expect(nextStepPrimary({ actions, mayDecide: true, mayAdjudicate: true, handoffAssign: false })).toBe("adjudicate");
  });
});

describe("the Evidence page review panel (T-008)", () => {
  it("links to the Review page and offers no verdict where reviewer operations are included", () => {
    const available = [
      { action: "CLAIM", enabled: true, blockedBy: null, requiresNote: false },
      { action: "APPROVE_INTERNAL", enabled: true, blockedBy: null, requiresNote: true },
      { action: "REJECT_INSUFFICIENT", enabled: true, blockedBy: null, requiresNote: true },
      { action: "CLOSE", enabled: true, blockedBy: null, requiresNote: false },
    ] as never;
    render(
      <ConfirmActionProvider><EvidenceReviewActionsPanel
        evidenceId={evidenceId}
        teamId={teamId}
        currentStatus="IN_REVIEW"
        assignedTo={null}
        viewerUserId="u-1"
        availableActions={available}
        reviewPageHref={`/reviewer-ops/${workflowId}`}
      /></ConfirmActionProvider>,
    );
    const link = document.querySelector("[data-evidence-review-open-review]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/reviewer-ops/${workflowId}`);
    expect(document.querySelector('[data-evidence-review-action="APPROVE_INTERNAL"]')).toBeNull();
    expect(document.querySelector('[data-evidence-review-action="CLOSE"]')).toBeNull();
    expect(document.querySelector('[data-evidence-review-action="CLAIM"]')).toBeTruthy();
    cleanup();
    // Pro (no Review page) keeps the panel.
    render(
      <ConfirmActionProvider><EvidenceReviewActionsPanel
        evidenceId={evidenceId}
        teamId={teamId}
        currentStatus="IN_REVIEW"
        assignedTo={null}
        viewerUserId="u-1"
        availableActions={available}
      /></ConfirmActionProvider>,
    );
    expect(document.querySelector('[data-evidence-review-action="APPROVE_INTERNAL"]')).toBeTruthy();
    expect(document.querySelector("[data-evidence-review-open-review]")).toBeNull();
  });
});

describe("/review/operations is retired (T-007)", () => {
  it("redirects to the inbox, preserving a stage filter, and is not offered in the palette", () => {
    expect(reviewOperationsRedirectTarget({})).toBe("/review");
    expect(reviewOperationsRedirectTarget({ stage: "ESCALATED" })).toBe("/review?view=ESCALATED");
    const entry = ROUTE_REGISTRY.find((r) => r.id === "review.operations")!;
    expect(entry.commandPaletteVisible).toBe(false);
    expect(entry.allToolsVisible).toBe(false);
    const page = readFileSync(resolve(__dirname, "../../app/(app)/review/operations/page.tsx"), "utf8");
    expect(page).toContain("redirect(");
    expect(page).not.toContain("alert(");
  });
});
