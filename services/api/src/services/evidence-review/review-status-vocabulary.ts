/**
 * PHASE 12 POINT 4 PASS C1 — the ONE definition of "this review status is a
 * verdict".
 *
 * `EvidenceReviewWorkflow.status` carries two different kinds of value:
 *
 *   - ROUTING states (NOT_STARTED / QUEUED / ASSIGNED / IN_REVIEW /
 *     READY_FOR_EXTERNAL_REVIEW / RESPONSE_RECEIVED / ESCALATED / REOPENED /
 *     CLOSED) — lifecycle position, owned by the lifecycle service;
 *   - VERDICT states — a PROJECTION of the immutable decision log, owned
 *     exclusively by `recordReviewDecision`, which appends the decision row
 *     and derives the status in the same transaction.
 *
 * This module holds the classification and nothing else. It is deliberately
 * dependency-free so the evidence surface (which also hosts the public verify
 * path) can consult it WITHOUT importing the reviewer-ops runtime — the
 * isolation invariant pinned by phase25-reviewer-ops.
 */

/** Statuses that only the decision authority may produce. */
export const DECISION_DERIVED_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "NEEDS_INFO",
]);

/** True when `status` may only be produced by recording a decision. */
export function isDecisionDerivedWorkflowStatus(
  status: string | null | undefined,
): boolean {
  return !!status && DECISION_DERIVED_WORKFLOW_STATUSES.has(status);
}
