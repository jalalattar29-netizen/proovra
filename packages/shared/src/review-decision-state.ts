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

import type { ReviewStage } from "./review-operations.js";

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
