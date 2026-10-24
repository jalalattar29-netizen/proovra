import { reviewWorkflowStateLabel } from "@proovra/shared";

/**
 * Canonical reviewer-status labels and disclaimer copy.
 *
 * Reviewer status is an internal workflow marker. It does NOT change
 * integrity results, public verification, authenticity, legal
 * admissibility, or factual truth — and we must say so wherever the
 * status is surfaced (Overview reviewer card, Review tab, External
 * Intake card, etc.). Centralising the label map + the disclaimer
 * copy here keeps every surface in lockstep: if the wording is
 * tightened for legal reasons, one edit propagates everywhere.
 *
 * Display labels are intentionally not the raw enum values. Showing
 * "NOT_STARTED" or "IN_REVIEW" in the UI is both ugly and
 * untranslated — reviewers should see human phrases.
 */

/**
 * THE WORKFLOW STATE label for every stored status — read from the ONE shared
 * presenter (`reviewWorkflowStateLabel`, 2026-10-24), never a local map.
 *
 * This used to be a second label map in which CLOSED read "Not accepted": a
 * closed review — including one that was APPROVED and then closed — told the
 * reader it had been rejected. The workflow state and the current-round
 * DECISION are separate facts; this names only the state ("Closed",
 * "Decided"), and the decision is `decisionLabel` from the server.
 */
export const REVIEWER_STATUS_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "NOT_STARTED",
    "QUEUED",
    "ASSIGNED",
    "IN_REVIEW",
    "NEEDS_INFO",
    "RESPONSE_RECEIVED",
    "READY_FOR_EXTERNAL_REVIEW",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "ESCALATED",
    "REOPENED",
    "CLOSED",
  ].map((status) => [status, reviewWorkflowStateLabel(status)]),
);

/**
 * What the ROUTING buttons DO (a status the browser may set on the
 * administrative PATCH). Closing is not a verdict: the button says "Close
 * review", never "Not accepted" — a verdict is recorded as a decision.
 */
export const REVIEWER_ROUTING_ACTION_LABELS: Readonly<Record<string, string>> = {
  NOT_STARTED: "Mark not started",
  IN_REVIEW: "Mark in review",
  CLOSED: "Close review",
};

/**
 * Subset of statuses surfaced as primary action buttons in the
 * Reviewer status control. Kept here so the Reviewer Workflow card
 * and the External Intake card cannot drift apart.
 *
 * PHASE 12 POINT 4 PASS C1 — these are ROUTING states only. A reviewer
 * VERDICT is not a status the browser assigns: it is recorded as a decision
 * and the workflow status is derived from the immutable decision log by the
 * server. `NEEDS_INFO` and `APPROVED_INTERNAL` therefore moved out of this
 * list and into `REVIEWER_DECISION_ACTIONS` below.
 */
export const REVIEWER_STATUS_PRIMARY_ACTIONS: ReadonlyArray<string> = [
  "NOT_STARTED",
  "IN_REVIEW",
  "CLOSED",
];

/**
 * Statuses derived by the server from the immutable decision log. No client
 * control may assign one — mirrors `DECISION_DERIVED_WORKFLOW_STATUSES` in
 * services/api/src/services/reviewer-ops/review-decision.service.ts.
 */
const DECISION_DERIVED_STATUSES: ReadonlySet<string> = new Set([
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "NEEDS_INFO",
]);

/** True when a surface may send this status on the administrative PATCH. */
export function isRoutingReviewerStatus(
  status: string | null | undefined,
): boolean {
  return !!status && !DECISION_DERIVED_STATUSES.has(status);
}

/**
 * The reviewer VERDICTS, expressed in the canonical decision vocabulary the
 * decision endpoint accepts (`POST /v1/review-operations/evidence/:id/decision`).
 *
 * `resultingStatus` is what the SERVER will derive once the decision is
 * recorded — it is here only so a surface can show which button is already
 * satisfied by the current state. It is never sent.
 */
export const REVIEWER_DECISION_ACTIONS: ReadonlyArray<{
  decision: "APPROVE_INTERNAL" | "REJECT_INSUFFICIENT" | "REQUEST_MORE_INFO";
  label: string;
  resultingStatus: string;
}> = [
  {
    decision: "REQUEST_MORE_INFO",
    label: "Request more context",
    resultingStatus: "NEEDS_INFO",
  },
  {
    decision: "APPROVE_INTERNAL",
    label: "Accept for internal review",
    resultingStatus: "APPROVED_INTERNAL",
  },
  {
    decision: "REJECT_INSUFFICIENT",
    label: "Reject as insufficient",
    resultingStatus: "REJECTED_INSUFFICIENT",
  },
];

/**
 * Resolve a display label without leaking a raw enum string to the
 * UI when an unrecognised value arrives (e.g. a new backend status
 * not yet mapped). Falls back to "Needs review" rather than the raw
 * string so the user is never confronted with "FOO_BAR".
 */
export function formatReviewerStatusLabel(status: string | null | undefined): string {
  return reviewWorkflowStateLabel(status);
}

/** Full disclaimer — preferred when there's room. */
export const REVIEWER_STATUS_DISCLAIMER =
  "Reviewer status is an internal workflow marker. It does not change integrity results, public verification, authenticity, legal admissibility, or factual truth.";

/** Shorter disclaimer — for compact surfaces (status chips, tooltips). */
export const REVIEWER_STATUS_DISCLAIMER_SHORT =
  "Internal workflow only. This status does not change integrity, verification, authenticity, legal admissibility, or factual truth.";
