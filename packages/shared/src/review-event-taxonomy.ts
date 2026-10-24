/**
 * THE INTERNAL REVIEW EVENT TAXONOMY (owner decision 2026-10-24).
 *
 * Internal Review workflow is NOT forensic custody. Review activity is an
 * internal operational judgment: it establishes nothing about the evidence
 * bytes, their integrity, origin, timestamps, anchors or storage. It lives in
 * the Review workflow event log, the decision rounds, the escalation records,
 * the authorized internal Review UI and the tenant audit — never in the
 * forensic custody chain, never in reportable-change or artifact-staleness
 * decisions, never in a report, package, Public Verify or any external
 * surface.
 *
 * Every Review writer, the history presenter, the inbox, the tenant audit, web
 * and mobile read the ONE vocabulary below. Only an actual verdict is
 * REVIEW_DECISION_RECORDED: Reopen, In review, Close, claim, assignment and
 * priority are not decisions.
 *
 * HISTORY IS NOT REWRITTEN. Before this decision, Review status changes were
 * appended to forensic custody as REVIEW_DECISION_RECORDED with
 * `{ status, actorUserId }`, whatever the change. Those stored rows keep their
 * bytes and hashes; `classifyLegacyReviewCustody` reads their payload to name
 * what each one actually was, for authorized internal views only.
 */

export const REVIEW_EVENT_CODES = [
  "REVIEW_WORKFLOW_CREATED",
  "REVIEW_WORKFLOW_STATE_CHANGED",
  "REVIEW_CLAIMED",
  "REVIEW_ASSIGNMENT_CHANGED",
  "REVIEW_PRIORITY_CHANGED",
  "REVIEW_DUE_DATE_CHANGED",
  "REVIEW_INFORMATION_REQUESTED",
  "REVIEW_INFORMATION_RESPONSE_RECORDED",
  "REVIEW_ESCALATION_CREATED",
  "REVIEW_ESCALATION_RESOLVED",
  "REVIEW_REOPENED",
  "REVIEW_CLOSED",
  "REVIEW_DECISION_RECORDED",
  "REVIEW_SLA_CHANGED",
  "REVIEW_BULK_ACTION",
] as const;
export type ReviewEventCode = (typeof REVIEW_EVENT_CODES)[number];

export const REVIEW_EVENT_LABELS: Readonly<Record<ReviewEventCode, string>> = {
  REVIEW_WORKFLOW_CREATED: "Review workflow created",
  REVIEW_WORKFLOW_STATE_CHANGED: "Review state changed",
  REVIEW_CLAIMED: "Review claimed",
  REVIEW_ASSIGNMENT_CHANGED: "Reviewer changed",
  REVIEW_PRIORITY_CHANGED: "Priority changed",
  REVIEW_DUE_DATE_CHANGED: "Due date changed",
  REVIEW_INFORMATION_REQUESTED: "More information requested",
  REVIEW_INFORMATION_RESPONSE_RECORDED: "Response received",
  REVIEW_ESCALATION_CREATED: "Escalated",
  REVIEW_ESCALATION_RESOLVED: "Escalation resolved",
  REVIEW_REOPENED: "Review reopened",
  REVIEW_CLOSED: "Review closed",
  REVIEW_DECISION_RECORDED: "Decision recorded",
  REVIEW_SLA_CHANGED: "Review SLA changed",
  REVIEW_BULK_ACTION: "Bulk review action",
};

/**
 * The tenant-audit action each internal Review event is recorded under (the
 * existing append-only platform audit — no second audit chain).
 */
export const REVIEW_EVENT_AUDIT_ACTIONS: Readonly<Record<ReviewEventCode, string>> = {
  REVIEW_WORKFLOW_CREATED: "review.workflow.created",
  REVIEW_WORKFLOW_STATE_CHANGED: "review.state.changed",
  REVIEW_CLAIMED: "review.claimed",
  REVIEW_ASSIGNMENT_CHANGED: "review.assignment.changed",
  REVIEW_PRIORITY_CHANGED: "review.priority.changed",
  REVIEW_DUE_DATE_CHANGED: "review.due_date.changed",
  REVIEW_INFORMATION_REQUESTED: "review.information.requested",
  REVIEW_INFORMATION_RESPONSE_RECORDED: "review.information.response_recorded",
  REVIEW_ESCALATION_CREATED: "review.escalation.created",
  REVIEW_ESCALATION_RESOLVED: "review.escalation.resolved",
  REVIEW_REOPENED: "review.reopened",
  REVIEW_CLOSED: "review.closed",
  REVIEW_DECISION_RECORDED: "review.decision.recorded",
  REVIEW_SLA_CHANGED: "review.sla.changed",
  REVIEW_BULK_ACTION: "review.bulk_action",
};

/** Only these are decisions. A state change, Reopen or Close never is. */
export function isReviewDecisionEvent(code: ReviewEventCode): boolean {
  return code === "REVIEW_DECISION_RECORDED";
}

const VERDICT_KINDS = new Set(["APPROVE", "REJECT", "UPHOLD_FIRST", "UPHOLD_SECOND", "UNRESOLVED"]);
const INFO_KINDS = new Set(["REQUEST_INFO", "NEEDS_MORE_INFO"]);

/**
 * A stored Review workflow event (EvidenceReviewWorkflowEventType + its
 * values) in the canonical taxonomy. Pure; reads only the event's own type and
 * the decision kind its nextValue records.
 */
export function classifyReviewWorkflowEvent(event: {
  eventType: string;
  nextValue?: unknown;
}): ReviewEventCode {
  const type = String(event.eventType ?? "").toUpperCase();
  const next = event.nextValue && typeof event.nextValue === "object" ? (event.nextValue as Record<string, unknown>) : {};
  switch (type) {
    case "CREATED":
      return "REVIEW_WORKFLOW_CREATED";
    case "CLAIMED":
      return "REVIEW_CLAIMED";
    case "ASSIGNED":
    case "UNASSIGNED":
    case "REASSIGNED":
      return "REVIEW_ASSIGNMENT_CHANGED";
    case "PRIORITY_CHANGED":
      return "REVIEW_PRIORITY_CHANGED";
    case "DUE_DATE_CHANGED":
      return "REVIEW_DUE_DATE_CHANGED";
    case "NEEDS_MORE_INFO":
      return "REVIEW_INFORMATION_REQUESTED";
    case "RESPONSE_RECEIVED":
      return "REVIEW_INFORMATION_RESPONSE_RECORDED";
    case "ESCALATED":
      return "REVIEW_ESCALATION_CREATED";
    case "REOPENED":
      return "REVIEW_REOPENED";
    case "CLOSED":
      return "REVIEW_CLOSED";
    case "APPROVED_INTERNAL":
    case "REJECTED_INSUFFICIENT":
    case "REVIEW_COMPLETED":
      return "REVIEW_DECISION_RECORDED";
    case "SLA_UPDATED":
    case "SLA_BREACHED":
      return "REVIEW_SLA_CHANGED";
    case "BULK_ACTION":
      return "REVIEW_BULK_ACTION";
    case "DECISION_LOGGED": {
      // The decision authority logs every submission here; only a verdict
      // kind is a decision. A request for information is not.
      const kind = String(next.decision ?? "").toUpperCase();
      if (INFO_KINDS.has(kind)) return "REVIEW_INFORMATION_REQUESTED";
      if (VERDICT_KINDS.has(kind)) return "REVIEW_DECISION_RECORDED";
      return "REVIEW_WORKFLOW_STATE_CHANGED";
    }
    case "STATUS_CHANGED":
    case "STAGE_CHANGED":
    case "REVIEW_STARTED":
    default:
      return reviewCodeForStatus(next.status ?? next.stage, "REVIEW_WORKFLOW_STATE_CHANGED");
  }
}

/** A workflow status change, named by the status it moved TO. */
export function reviewEventCodeForStatusChange(status: string | null | undefined): ReviewEventCode {
  return reviewCodeForStatus(status, "REVIEW_WORKFLOW_STATE_CHANGED");
}

/** What a status/stage value MOVED TO means as an event. */
function reviewCodeForStatus(value: unknown, fallback: ReviewEventCode): ReviewEventCode {
  switch (String(value ?? "").toUpperCase()) {
    case "REOPENED":
      return "REVIEW_REOPENED";
    case "CLOSED":
      return "REVIEW_CLOSED";
    case "ESCALATED":
      return "REVIEW_ESCALATION_CREATED";
    case "NEEDS_INFO":
    case "NEEDS_MORE_INFO":
      return "REVIEW_INFORMATION_REQUESTED";
    case "RESPONSE_RECEIVED":
      return "REVIEW_INFORMATION_RESPONSE_RECORDED";
    case "APPROVED_INTERNAL":
    case "READY_FOR_EXTERNAL_REVIEW":
    case "REJECTED_INSUFFICIENT":
      return "REVIEW_DECISION_RECORDED";
    default:
      return fallback;
  }
}

/**
 * HISTORICAL COMPATIBILITY. A forensic custody row stored before 2026-10-24
 * as REVIEW_DECISION_RECORDED `{ status, actorUserId }` — whatever the status
 * change — named for what it was. Internal, authorized views only; the stored
 * row is never rewritten and never leaves through an external projection.
 */
export function classifyLegacyReviewCustody(payload: unknown): ReviewEventCode {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return reviewCodeForStatus(p.status, "REVIEW_WORKFLOW_STATE_CHANGED");
}

export function reviewEventLabel(code: ReviewEventCode): string {
  return REVIEW_EVENT_LABELS[code];
}
