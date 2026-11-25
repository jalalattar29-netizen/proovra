/**
 * Review decision STATE — pure derivations over the immutable decision log
 * (moved here from the API's review-decision service, 2026-10-23).
 *
 * The decision authority (`recordReviewDecision`), its reconciliation, the
 * reviewer-ops routes AND the Evidence page's projection of what a viewer may
 * decide all derive from these, so the page can never offer a verdict the
 * authority refuses, or refuse one it would accept. The log passed in is ONE
 * decision round's rows.
 */

import { isAllowedReviewStageTransition, type ReviewStage } from "./review-operations.js";

export type ReviewDecisionState =
  | "first_required"
  | "second_required"
  | "conflict_detected"
  | "adjudication_required"
  | "resolved";

export type DecisionLogRow = {
  stage: string;
  decision: string;
  reviewerUserId: string;
};

// -----------------------------------------------------------------------------
// Derivation — pure functions over the immutable decision log.
// -----------------------------------------------------------------------------

/**
 * Derive the multi-stage review state from the immutable decision log.
 * (Moved from reviewer-ops.routes.ts so route + authority + reconcile
 * all share ONE derivation.)
 */
export function deriveReviewState(input: {
  decisions: ReadonlyArray<DecisionLogRow>;
  requiresSecond: boolean;
}): ReviewDecisionState {
  const first = input.decisions.find((d) => d.stage === "FIRST");
  const second = input.decisions.find((d) => d.stage === "SECOND");
  const adj = input.decisions.find((d) => d.stage === "ADJUDICATION");
  if (adj) return "resolved";
  if (first && second) {
    if (first.decision !== second.decision) return "conflict_detected";
    return "resolved";
  }
  if (first) {
    return input.requiresSecond ? "second_required" : "resolved";
  }
  return "first_required";
}

/** Map a final decision kind to the projected workflow stage. */
export function kindToProjectedStage(
  kind: string | null,
): ReviewStage | null {
  switch (kind) {
    case "APPROVE":
      return "APPROVED_INTERNAL";
    case "REJECT":
      return "REJECTED_INSUFFICIENT";
    case "REQUEST_INFO":
    case "NEEDS_MORE_INFO":
      return "NEEDS_MORE_INFO";
    default:
      return null;
  }
}

export type DecisionProjection = {
  state: ReviewDecisionState;
  /** Resolved outcome kind, when the log resolves to one. */
  finalKind: string | null;
  /**
   * Workflow stage the projection derives from the log. `null` means
   * "the log does not (yet) determine a stage" — the current lifecycle
   * status stands (e.g. awaiting a second review).
   */
  projectedStage: ReviewStage | null;
};

/**
 * Deterministically project the workflow stage from the immutable
 * decision log. This is the ONE place decision → status derivation
 * lives; recordReviewDecision and reconcileWorkflowProjection both use
 * it.
 */
export function deriveDecisionProjection(
  decisions: ReadonlyArray<DecisionLogRow>,
  requiresSecond: boolean,
): DecisionProjection {
  const first = decisions.find((d) => d.stage === "FIRST") ?? null;
  const second = decisions.find((d) => d.stage === "SECOND") ?? null;
  const adj = decisions.find((d) => d.stage === "ADJUDICATION") ?? null;

  if (adj) {
    if (adj.decision === "UNRESOLVED") {
      return { state: "resolved", finalKind: null, projectedStage: "ESCALATED" };
    }
    const finalKind =
      adj.decision === "UPHOLD_FIRST"
        ? (first?.decision as string | undefined) ?? null
        : adj.decision === "UPHOLD_SECOND"
          ? (second?.decision as string | undefined) ?? null
          : (adj.decision as string);
    return {
      state: "resolved",
      finalKind,
      projectedStage: kindToProjectedStage(finalKind),
    };
  }
  if (first && second) {
    if (first.decision !== second.decision) {
      return {
        state: "conflict_detected",
        finalKind: null,
        projectedStage: "ESCALATED",
      };
    }
    return {
      state: "resolved",
      finalKind: first.decision as string,
      projectedStage: kindToProjectedStage(first.decision as string),
    };
  }
  if (first) {
    if (requiresSecond) {
      return { state: "second_required", finalKind: null, projectedStage: null };
    }
    return {
      state: "resolved",
      finalKind: first.decision as string,
      projectedStage: kindToProjectedStage(first.decision as string),
    };
  }
  return { state: "first_required", finalKind: null, projectedStage: null };
}


// -----------------------------------------------------------------------------
// THE CURRENT-ROUND DECISION — independent of the workflow state (2026-10-24).
// -----------------------------------------------------------------------------

/**
 * What the CURRENT decision round decided. Independent of the workflow state:
 * Close ends the workflow and keeps this; Reopen starts a new round, whose
 * decision is NO_DECISION until a verdict resolves it. A request for more
 * information, a pending second review and an unresolved disagreement are not
 * decisions (the workflow state says where the review stands).
 *
 * "Approve then Close" is Workflow Closed · Decision Approved — never
 * "Not accepted" (the defect this replaces read the closed stage as a verdict).
 */
export const REVIEW_DECISIONS = ["NO_DECISION", "APPROVED", "NOT_ACCEPTED"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const REVIEW_DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = {
  NO_DECISION: "No decision",
  APPROVED: "Approved",
  NOT_ACCEPTED: "Not accepted",
};

/** The decision a RESOLVED projection of the round's log carries. */
export function reviewDecisionFromProjection(
  projection: { state: ReviewDecisionState | string; projectedStage?: string | null } | null | undefined,
): ReviewDecision {
  if (!projection || projection.state !== "resolved") return "NO_DECISION";
  switch (projection.projectedStage) {
    case "APPROVED_INTERNAL":
      return "APPROVED";
    case "REJECTED_INSUFFICIENT":
      return "NOT_ACCEPTED";
    default:
      return "NO_DECISION";
  }
}

/**
 * LEGACY: a workflow decided before the decision log existed has only its
 * stored status. Only a VERDICT status carries a decision — CLOSED, REOPENED
 * and every routing state carry none (a closed stage is never read as a
 * verdict).
 */
export function legacyReviewDecisionFromStatus(dbStatus: string | null | undefined): ReviewDecision {
  switch (String(dbStatus ?? "").toUpperCase()) {
    case "APPROVED_INTERNAL":
    case "READY_FOR_EXTERNAL_REVIEW":
      return "APPROVED";
    case "REJECTED_INSUFFICIENT":
      return "NOT_ACCEPTED";
    default:
      return "NO_DECISION";
  }
}

// -----------------------------------------------------------------------------
// SECOND-REVIEW TRIGGER POLICY (Team remediation T-013, 2026-11-24).
// -----------------------------------------------------------------------------

/**
 * Escalation reasons the AUTOMATIC overdue / SLA / stuck-workflow sweeps raise.
 * An escalation of one of these reasons that no person raised
 * (`createdByUserId` null) says only that a clock ran out — nothing about the
 * quality of the decision — so it does NOT force an independent second review.
 */
export const AUTOMATIC_SWEEP_ESCALATION_REASONS = [
  "REVIEW_OVERDUE",
  "FIRST_REVIEW_OVERDUE",
  "COMPLETION_OVERDUE",
  "WORKFLOW_STALLED",
] as const;
const AUTOMATIC_SWEEP_REASON_SET: ReadonlySet<string> = new Set(AUTOMATIC_SWEEP_ESCALATION_REASONS);

/**
 * THE ONE forcing predicate (coordinator decision T-013): only an escalation
 * the overdue/SLA sweep raised on its own stops forcing independent review.
 * Every other active escalation — any reason, any severity, raised by a person
 * — keeps forcing it, as do a legal hold, a redaction-required decision and an
 * ESCALATED review (conflict, unresolved adjudication, a reviewer's Escalate).
 */
export function escalationForcesIndependentReview(escalation: {
  reason: string;
  createdByUserId?: string | null;
}): boolean {
  return !(escalation.createdByUserId == null && AUTOMATIC_SWEEP_REASON_SET.has(String(escalation.reason)));
}

/** Why the current round needs an independent second review. */
export type SecondReviewCause =
  | "workflow_escalated"
  | "open_escalation"
  | "active_legal_hold"
  | "redaction_required"
  | "unresolved_adjudication";

/**
 * Causes whose requirement STAYS with a round once its FIRST decision was
 * recorded under it (binding direction 4: resolving an escalation never
 * invents or finalises a decision). The FIRST verdict then waits for its
 * SECOND reviewer even after the escalation is resolved. A legal hold or a
 * redaction requirement keeps the earlier rule (P2-1): once lifted, the first
 * verdict stands.
 */
export const STICKY_SECOND_REVIEW_CAUSES: ReadonlyArray<SecondReviewCause> = [
  "workflow_escalated",
  "open_escalation",
  "unresolved_adjudication",
];

/**
 * Whether a DECISION_LOGGED event's `nextValue` pins its round to a second
 * review: the FIRST decision was recorded as `second_required` for a sticky
 * cause. A legacy event (recorded before causes were written) counts as
 * sticky: the system never silently finalises a decision it cannot explain —
 * the explicit re-evaluation job (T-014) handles those rounds.
 */
export function decisionEventPinsSecondReview(nextValue: unknown): boolean {
  const v = (nextValue ?? {}) as { state?: unknown; decisionStage?: unknown; secondReviewCause?: unknown };
  if (v.state !== "second_required") return false;
  if (v.decisionStage !== undefined && v.decisionStage !== "FIRST") return false;
  if (v.secondReviewCause === undefined) return true;
  return (STICKY_SECOND_REVIEW_CAUSES as ReadonlyArray<unknown>).includes(v.secondReviewCause);
}

/** The marker the explicit re-evaluation job (T-014) writes on a round it re-derived. */
export const SECOND_REVIEW_REEVALUATION_SOURCE = "second_review_policy_reevaluation" as const;

/**
 * T-018 — the round is FINISHED and the next submission opens a new round:
 *   - a request for information settled it and the review has since moved on
 *     (not terminal, no longer waiting for that information); or
 *   - an adjudicator recorded UNRESOLVED: the disagreement stands, so a fresh
 *     round (first decision by the assignee, then an independent second
 *     review) is the defined next step — never a dead end.
 */
export function roundContinuesInNewRound(
  decisions: ReadonlyArray<DecisionLogRow>,
  projection: DecisionProjection,
  stageNow: ReviewStage,
): "request_info" | "unresolved_adjudication" | null {
  const terminal = stageNow === "APPROVED_INTERNAL" || stageNow === "REJECTED_INSUFFICIENT" || stageNow === "CLOSED";
  if (terminal || projection.state !== "resolved") return null;
  if (projection.projectedStage === "NEEDS_MORE_INFO" && stageNow !== "NEEDS_MORE_INFO") return "request_info";
  if (decisions.some((d) => d.stage === "ADJUDICATION" && d.decision === "UNRESOLVED")) return "unresolved_adjudication";
  return null;
}

// -----------------------------------------------------------------------------
// THE CANONICAL STAGE RULES the server applies (2026-11-25, round 2). The
// decision authority, the lifecycle doors, Start, and the projections that
// tell a client which actions to offer all call these — one rule, so a button
// the page shows is a move the server accepts. They read the PERSISTED stage
// and the stage matrix (isAllowedReviewStageTransition), never the lifecycle
// an open escalation derives.
// -----------------------------------------------------------------------------

/** A review in one of these stages takes no further verdict. */
export const DECISION_TERMINAL_STAGES: ReadonlySet<ReviewStage> = new Set<ReviewStage>([
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "CLOSED",
]);

/**
 * Why the decision authority refuses this verdict kind from this stage, or null.
 * A verdict is a move to the stage it projects; adjudication kinds project no
 * stage and are governed by the decision state instead.
 */
export function verdictStageRefusal(
  currentStage: ReviewStage,
  kind: string,
): "review_already_resolved" | "decision_not_from_stage" | null {
  return verdictToStageRefusal(currentStage, kindToProjectedStage(kind));
}

/** The same rule, for a caller that already holds the verdict's projected stage. */
export function verdictToStageRefusal(
  currentStage: ReviewStage,
  verdictStage: ReviewStage | null,
): "review_already_resolved" | "decision_not_from_stage" | null {
  if (DECISION_TERMINAL_STAGES.has(currentStage)) return "review_already_resolved";
  if (verdictStage !== null && verdictStage !== currentStage && !isAllowedReviewStageTransition(currentStage, verdictStage)) {
    return "decision_not_from_stage";
  }
  return null;
}

/**
 * Why an explicit move (Start, Close / archive, Reopen, Escalate) is refused
 * from this stage, or null: a move into the stage it is already in is refused,
 * and otherwise the stage matrix decides.
 */
export function stageMoveRefusal(
  currentStage: ReviewStage,
  toStage: ReviewStage,
): "already_in_stage" | "invalid_stage_transition" | null {
  if (currentStage === toStage) return "already_in_stage";
  return isAllowedReviewStageTransition(currentStage, toStage) ? null : "invalid_stage_transition";
}

/**
 * Why the Review page's Start is refused, or null — the ONE rule both the
 * `/start` door and the Review page offer apply (round 2, 2026-11-25).
 *
 * The stage rule is `stageMoveRefusal(stage, "IN_REVIEW")`, with one case on
 * top: an in-review review that was HANDED OVER (the latest Start was by
 * someone other than the current assignee — e.g. the second reviewer after a
 * FIRST verdict, or a new assignee after a reassignment) may be started by
 * its new assignee. Otherwise Start on an in-review review is a no-op and is
 * refused (`already_started`, T-020).
 */
export function reviewStartRefusal(
  currentStage: ReviewStage,
  handedOver: boolean,
): "already_started" | "invalid_stage_transition" | null {
  const move = stageMoveRefusal(currentStage, "IN_REVIEW");
  if (move === "already_in_stage") return handedOver ? null : "already_started";
  return move;
}

/**
 * Whether an in-review review was handed over to its current assignee: the
 * latest REVIEW_STARTED actor is known and is not the assignee. No recorded
 * Start (legacy rows, direct writes) is NOT a handover.
 */
export function reviewWasHandedOver(input: {
  assignedToUserId: string | null;
  latestStartActorUserId: string | null | undefined;
}): boolean {
  return (
    !!input.assignedToUserId &&
    !!input.latestStartActorUserId &&
    input.latestStartActorUserId !== input.assignedToUserId
  );
}
