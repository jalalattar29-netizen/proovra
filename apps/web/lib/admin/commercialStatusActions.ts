/**
 * THE STATUS BUTTONS ON A COMMERCIAL REQUEST, DERIVED FROM THE SHARED TABLE.
 *
 * =============================================================================
 * WHY THE PAGE DOES NOT DECIDE THIS
 * =============================================================================
 * The Contact Sales list, its detail page and the Demo Request queue each
 * used to render a hard-coded row of five status buttons and PATCH whatever
 * was clicked. The API accepted anything, so an ARCHIVED inquiry could be
 * dragged back to NEW, and "Rejected" was one accidental click away from
 * "Qualified" with nothing in between. None of the three pages said what a
 * click would do.
 *
 * Now the API refuses moves that are not in `COMMERCIAL_REQUEST_TRANSITIONS`
 * (packages/shared), and this module reads the SAME table to decide which
 * buttons to offer and which of them deserve a confirmation. A consequential
 * move — closing, rejecting, resolving, reopening — opens a dialog that names
 * the request and states the effect; a routine triage move does not, because
 * a dialog that fires on every click is a dialog nobody reads.
 *
 * The API stays the authority. The page sends `expectedStatus` with every
 * move so a colleague's concurrent change is refused as stale rather than
 * silently overwritten, and `describeRefusal` turns that refusal into a
 * sentence the operator can act on.
 */

import {
  COMMERCIAL_TRANSITION_REFUSALS,
  commercialTransitionsFrom,
  type CommercialRequestStatus,
  type CommercialTransitionRule,
} from "@proovra/shared";

import type { ConfirmActionOptions } from "../../components/ui/ConfirmActionModal";

export const COMMERCIAL_STATUS_LABEL: Record<CommercialRequestStatus, string> = {
  NEW: "New",
  REVIEWED: "Reviewed",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
};

/** What the operator is acting on, as the dialog and the button name it. */
export interface CommercialRequestSubject {
  id: string;
  fullName: string;
  organization: string;
  /** "inquiry" or "demo request" — the noun the copy uses. */
  noun: string;
}

/** The moves an operator may be offered from the request's current status. */
export function commercialStatusActions(
  status: CommercialRequestStatus,
): readonly CommercialTransitionRule[] {
  return commercialTransitionsFrom(status);
}

/** A short, stable identifier for the subject, as the dialog shows it. */
export function describeSubject(subject: CommercialRequestSubject): string {
  return `${subject.fullName} · ${subject.organization} (${subject.id.slice(0, 8)}…)`;
}

/** The accessible name of a status button: what it does, and to whom. */
export function statusActionLabel(
  rule: CommercialTransitionRule,
  subject: CommercialRequestSubject,
): string {
  return `Set status to ${COMMERCIAL_STATUS_LABEL[rule.to]} for ${subject.fullName} (${subject.organization})`;
}

/**
 * The confirmation for a CONSEQUENTIAL move, or null when the move is
 * routine and should run on the click alone.
 */
export function statusActionConfirmation(
  rule: CommercialTransitionRule,
  subject: CommercialRequestSubject,
): ConfirmActionOptions | null {
  if (rule.consequence !== "CONSEQUENTIAL") return null;
  const closing = rule.to === "REJECTED" || rule.to === "ARCHIVED";
  return {
    title: `${COMMERCIAL_STATUS_LABEL[rule.to] === "Rejected" ? "Reject" : closing ? "Archive" : rule.to === "QUALIFIED" ? "Qualify" : "Reopen"} this ${subject.noun}?`,
    description: `${rule.effect}\n\nApplies to: ${describeSubject(subject)}\nCurrent status: ${COMMERCIAL_STATUS_LABEL[rule.from]} → ${COMMERCIAL_STATUS_LABEL[rule.to]}`,
    confirmLabel: `Mark as ${COMMERCIAL_STATUS_LABEL[rule.to]}`,
    tone: closing ? "danger" : "warning",
    testId: `commercial-status-${rule.to.toLowerCase()}`,
  };
}

/** The request body for a move, always carrying the status the page showed. */
export function statusPatchBody(
  from: CommercialRequestStatus,
  to: CommercialRequestStatus,
): { status: CommercialRequestStatus; expectedStatus: CommercialRequestStatus } {
  return { status: to, expectedStatus: from };
}

export type StatusRefusal = "stale" | "not_allowed" | null;

/** Which of the API's two refusals this is, read off the error's `code`. */
export function classifyStatusRefusal(err: unknown): StatusRefusal {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === COMMERCIAL_TRANSITION_REFUSALS.STALE) return "stale";
  if (code === COMMERCIAL_TRANSITION_REFUSALS.NOT_ALLOWED) return "not_allowed";
  return null;
}

export function describeRefusal(kind: Exclude<StatusRefusal, null>, noun: string): string {
  return kind === "stale"
    ? `This ${noun} was changed by another operator. The current status is shown now — nothing was overwritten.`
    : `That status change is not allowed from the ${noun}'s current status. The current status is shown now.`;
}
