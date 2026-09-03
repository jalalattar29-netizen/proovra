/**
 * WHICH STATUS CHANGES ON AN INBOUND COMMERCIAL REQUEST ARE ALLOWED, AND
 * WHICH OF THEM ARE CONSEQUENTIAL.
 *
 * =============================================================================
 * WHY THIS IS ONE TABLE AND NOT TWO OPINIONS
 * =============================================================================
 * The Contact Sales and Demo Request queues share a six-state lifecycle
 * (NEW, REVIEWED, CONTACTED, QUALIFIED, REJECTED, ARCHIVED). Until this
 * module existed, the admin page offered every status as a one-click button
 * and the API accepted any status for any record — so ARCHIVED → NEW was a
 * click away, REJECTED could be reached from QUALIFIED by accident, and
 * nothing anywhere said which of those moves closed a customer conversation.
 *
 * The API is the authority: it refuses a transition that is not in this
 * table with 409, and it refuses a stale one (the page still shows an older
 * status than the row holds) with 409 as well. The web app reads the SAME
 * table to decide which buttons to offer and which of them deserve a
 * confirmation. Two copies of this rule would drift; one shared module
 * cannot.
 *
 * =============================================================================
 * CONSEQUENTIAL VERSUS ROUTINE
 * =============================================================================
 * Not every move deserves a confirmation dialog. Asking an operator to
 * confirm "mark as reviewed" fifty times a day teaches them to confirm
 * without reading, which is worse than not asking. So each edge carries a
 * consequence class:
 *
 *   ROUTINE        internal triage that the next click can undo
 *                  (NEW → REVIEWED, REVIEWED → CONTACTED, CONTACTED → REVIEWED)
 *   CONSEQUENTIAL  closes, rejects, resolves, suppresses future work, or
 *                  reopens a closed request — the operator is told what the
 *                  move means and asked to confirm it
 *
 * NEW is the entry state and is never a destination: a request that has
 * been looked at cannot pretend it has not.
 */

export const COMMERCIAL_REQUEST_STATUSES = [
  "NEW",
  "REVIEWED",
  "CONTACTED",
  "QUALIFIED",
  "REJECTED",
  "ARCHIVED",
] as const;

export type CommercialRequestStatus = (typeof COMMERCIAL_REQUEST_STATUSES)[number];

export type CommercialTransitionConsequence = "ROUTINE" | "CONSEQUENTIAL";

export interface CommercialTransitionRule {
  from: CommercialRequestStatus;
  to: CommercialRequestStatus;
  consequence: CommercialTransitionConsequence;
  /** What the move does, in the words the confirmation dialog shows. */
  effect: string;
}

/**
 * Every allowed edge. An edge not listed here is refused by the API.
 *
 * Terminal states (QUALIFIED, REJECTED, ARCHIVED) can only be left through an
 * explicit reopen, and every reopen is consequential because it puts a closed
 * conversation back into somebody's queue.
 */
export const COMMERCIAL_REQUEST_TRANSITIONS: readonly CommercialTransitionRule[] = [
  // From NEW — first triage.
  { from: "NEW", to: "REVIEWED", consequence: "ROUTINE", effect: "Marks the request as reviewed. It stays in the active queue." },
  { from: "NEW", to: "CONTACTED", consequence: "ROUTINE", effect: "Records that the requester has been contacted. It stays in the active queue." },
  { from: "NEW", to: "REJECTED", consequence: "CONSEQUENTIAL", effect: "Rejects the request. It leaves the active queue and no follow-up will be scheduled." },
  { from: "NEW", to: "ARCHIVED", consequence: "CONSEQUENTIAL", effect: "Archives the request without a decision. It leaves the active queue and no follow-up will be scheduled." },

  // From REVIEWED.
  { from: "REVIEWED", to: "CONTACTED", consequence: "ROUTINE", effect: "Records that the requester has been contacted. It stays in the active queue." },
  { from: "REVIEWED", to: "QUALIFIED", consequence: "CONSEQUENTIAL", effect: "Marks the request as qualified and hands it to sales. It leaves the triage queue." },
  { from: "REVIEWED", to: "REJECTED", consequence: "CONSEQUENTIAL", effect: "Rejects the request. It leaves the active queue and no follow-up will be scheduled." },
  { from: "REVIEWED", to: "ARCHIVED", consequence: "CONSEQUENTIAL", effect: "Archives the request without a decision. It leaves the active queue and no follow-up will be scheduled." },

  // From CONTACTED.
  { from: "CONTACTED", to: "REVIEWED", consequence: "ROUTINE", effect: "Moves the request back to reviewed. It stays in the active queue." },
  { from: "CONTACTED", to: "QUALIFIED", consequence: "CONSEQUENTIAL", effect: "Marks the request as qualified and hands it to sales. It leaves the triage queue." },
  { from: "CONTACTED", to: "REJECTED", consequence: "CONSEQUENTIAL", effect: "Rejects the request. It leaves the active queue and no follow-up will be scheduled." },
  { from: "CONTACTED", to: "ARCHIVED", consequence: "CONSEQUENTIAL", effect: "Archives the request without a decision. It leaves the active queue and no follow-up will be scheduled." },

  // Leaving a terminal state — every one of these reopens a closed request.
  { from: "QUALIFIED", to: "CONTACTED", consequence: "CONSEQUENTIAL", effect: "Reopens a qualified request and returns it to the active queue as contacted." },
  { from: "QUALIFIED", to: "ARCHIVED", consequence: "CONSEQUENTIAL", effect: "Archives a qualified request. It leaves every queue." },
  { from: "REJECTED", to: "REVIEWED", consequence: "CONSEQUENTIAL", effect: "Reopens a rejected request and returns it to the active queue." },
  { from: "REJECTED", to: "ARCHIVED", consequence: "CONSEQUENTIAL", effect: "Archives a rejected request. It leaves every queue." },
  { from: "ARCHIVED", to: "REVIEWED", consequence: "CONSEQUENTIAL", effect: "Restores an archived request to the active queue." },
];

/** The rule for one edge, or null when the edge is not allowed. */
export function commercialTransitionRule(
  from: CommercialRequestStatus,
  to: CommercialRequestStatus,
): CommercialTransitionRule | null {
  if (from === to) return null;
  return COMMERCIAL_REQUEST_TRANSITIONS.find((r) => r.from === from && r.to === to) ?? null;
}

export function isCommercialTransitionAllowed(
  from: CommercialRequestStatus,
  to: CommercialRequestStatus,
): boolean {
  return commercialTransitionRule(from, to) !== null;
}

/** The destinations an operator may be offered from `from`, in table order. */
export function commercialTransitionsFrom(
  from: CommercialRequestStatus,
): readonly CommercialTransitionRule[] {
  return COMMERCIAL_REQUEST_TRANSITIONS.filter((r) => r.from === from);
}

export function isTerminalCommercialStatus(status: CommercialRequestStatus): boolean {
  return status === "QUALIFIED" || status === "REJECTED" || status === "ARCHIVED";
}

/**
 * The API's refusal codes for a status change. Shared so the page can tell a
 * stale view ("somebody else moved it — reloaded") from a disallowed move.
 */
export const COMMERCIAL_TRANSITION_REFUSALS = {
  /** `expectedStatus` was sent and no longer matches the row. */
  STALE: "stale_status",
  /** The edge is not in the table. */
  NOT_ALLOWED: "transition_not_allowed",
} as const;
