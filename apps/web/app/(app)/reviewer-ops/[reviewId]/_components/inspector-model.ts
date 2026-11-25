/**
 * Review inspector — the pure model behind the page.
 *
 * Everything here is a function of the API response, so the page renders
 * exactly what the server decided and a render test can pin the wording:
 *
 *   - which actions this viewer may take now, and why the others are closed
 *     (`viewer.actions` from GET /v1/reviewer-ops/workspace/:id, with the old
 *     lifecycle-only rule as a fallback for an API that predates it);
 *   - what a decision actually did (`outcome` on approve / reject /
 *     request-info / response-received and the decisions route), so a FIRST
 *     decision under a second-review requirement never reads as an approval;
 *   - one message per refusal reason, so a stale or out-of-stage decision is
 *     never reported as "already resolved".
 *
 * Wording: approvals and rejections are INTERNAL review decisions. Nothing
 * here may read as a public authenticity statement.
 */

import {
  ADJUDICATION_NEXT_MESSAGE,
  FIRST_ONLY_MESSAGE,
  SECOND_REVIEW_CAUSE_LABELS,
  describeReviewOutcome,
  describeReviewRefusal,
  type ReviewDecisionOutcomeCopyInput,
} from "@proovra/shared";

export type LifecycleState =
  | "DRAFT"
  | "SUBMITTED"
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFORMATION"
  | "ESCALATED"
  | "APPROVED"
  | "REJECTED"
  | "ARCHIVED";

export type SlaState =
  | "HEALTHY"
  | "DUE_SOON"
  | "BREACHED"
  | "ESCALATED"
  | "BLOCKED"
  | "PAUSED"
  | "COMPLETED";

export type ViewerActionName =
  | "start"
  | "pause"
  | "resume"
  | "request_info"
  | "record_response"
  | "approve"
  | "reject"
  | "reassign"
  | "adjudicate"
  | "archive"
  // Team remediation — T-009 / T-019.
  | "reopen"
  | "escalate";

export type ViewerAction = {
  action: ViewerActionName;
  allowed: boolean;
  reason?: string;
};

export type Viewer = {
  userId: string;
  isAssignee: boolean;
  actions: ViewerAction[];
  /** T-019 — whether an escalation this viewer raises forces an independent second review. */
  escalationForcesIndependentReview?: boolean;
};

export type DecisionOutcome = ReviewDecisionOutcomeCopyInput & {
  stageRecorded: "FIRST" | "SECOND" | "ADJUDICATION";
  reviewState: string;
};

export type ActionState = { allowed: boolean; reason: string | null };
export type ActionMap = Record<ViewerActionName, ActionState>;

export const ACTION_LABELS: Record<ViewerActionName, string> = {
  start: "Start review",
  pause: "Pause",
  resume: "Resume",
  request_info: "Request information",
  record_response: "Record response",
  approve: "Approve",
  reject: "Reject",
  reassign: "Reassign",
  adjudicate: "Adjudicate the disagreement",
  archive: "Archive",
  reopen: "Reopen review",
  escalate: "Escalate",
};

const ALL_ACTIONS: ViewerActionName[] = [
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

/**
 * A refusal / disabled reason the server names by code, as a sentence.
 *
 * Codes cover both the viewer-action reasons and the decision refusal
 * reasons, so a disabled button and a refused POST say the same thing.
 */
const REASON_SENTENCES: Record<string, string> = {
  not_assignee: "Only the assigned reviewer can decide.",
  not_assigned: "Assign the review to start.",
  unassigned: "Assign the review to start.",
  assign_first: "Assign the review to start.",
  not_started: "Start the review first.",
  start_first: "Start the review first.",
  second_stage_needs_reassignment:
    "A different reviewer must make the second decision — reassign it.",
  same_reviewer_blocked:
    "A different reviewer must make the second decision — reassign it.",
  use_adjudication:
    "This disagreement needs adjudication by an independent owner or admin.",
  conflict_detected:
    "This disagreement needs adjudication by an independent owner or admin.",
  adjudication_required:
    "This disagreement needs adjudication by an independent owner or admin.",
  adjudicator_role_required:
    "Adjudication needs a workspace owner or admin.",
  adjudicator_not_independent:
    "Adjudication needs an owner or admin who made neither decision.",
  no_conflict: "There is no disagreement to adjudicate.",
  awaiting_response: "Waiting for information — record the response to continue.",
  needs_information: "Waiting for information — record the response to continue.",
  waiting_for_information:
    "Waiting for information — record the response to continue.",
  not_waiting_for_information: "No information request is waiting for a response.",
  not_awaiting_information: "No information request is waiting for a response.",
  actor_not_assignee: "Only the assigned reviewer can decide.",
  review_finished: "This review is already resolved.",
  reviewer_required: "Your workspace role cannot review.",
  review_assign_required: "Your workspace role cannot reassign reviews.",
  reviewer_operations_not_included: "Review assignments are not included in this workspace's plan.",
  decision_not_from_stage: "Not available at this stage of the review.",
  concurrent_change: "The review changed — reload to see its current state.",
  service_account_blocked: "Service accounts cannot take review actions.",
  second_review_pending:
    "A second review or adjudication is still pending.",
  review_already_resolved: "This review is already resolved.",
  terminal: "This review is already resolved.",
  already_resolved: "This review is already resolved.",
  paused: "The review is paused — resume it to continue.",
  not_paused: "The review is not paused.",
  already_paused: "The review is already paused.",
  role_required: "Your workspace role does not allow this.",
  permission_required: "Your workspace role does not allow this.",
  missing_permission: "Your workspace role does not allow this.",
  no_reach: "You do not have access to this evidence.",
  lifecycle: "Not available at this stage of the review.",
  invalid_transition: "Not available at this stage of the review.",
  // Team remediation (T-009 / T-019 / T-020 / T-021).
  already_started: "The review has already started.",
  review_not_finished: "Only a finished review can be reopened.",
  review_escalation_not_included: "Escalations are not included in this workspace's plan.",
};

const GENERIC_DISABLED = "Not available at this stage of the review.";

/**
 * Turn a server reason into a sentence. A known code maps to its sentence; a
 * value that already reads as prose (it has a space) is shown as sent; an
 * unknown code never leaks as a raw identifier.
 */
export function humanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  const known = REASON_SENTENCES[trimmed] ?? REASON_SENTENCES[trimmed.toLowerCase()];
  if (known) return known;
  if (/\s/.test(trimmed)) return trimmed;
  return GENERIC_DISABLED;
}

const DECIDABLE: LifecycleState[] = ["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"];
const TERMINAL: LifecycleState[] = ["APPROVED", "REJECTED", "ARCHIVED"];

/**
 * The legacy rule, used ONLY when the API sends no `viewer` block. It is the
 * lifecycle-only rule the page always had, plus the reasons it never gave.
 */
function fallbackActions(lifecycle: LifecycleState, paused: boolean): ActionMap {
  const terminal = TERMINAL.includes(lifecycle);
  const decidable = DECIDABLE.includes(lifecycle);
  const closed = (reason: string): ActionState => ({ allowed: false, reason });
  const terminalReason = "This review is already resolved.";
  const stageReason = (): string =>
    terminal
      ? terminalReason
      : lifecycle === "ASSIGNED"
        ? "Start the review first."
        : lifecycle === "QUEUED" || lifecycle === "SUBMITTED" || lifecycle === "DRAFT"
          ? "Assign the review to start."
          : GENERIC_DISABLED;
  return {
    start:
      lifecycle === "ASSIGNED"
        ? { allowed: true, reason: null }
        : closed(
            terminal
              ? terminalReason
              : lifecycle === "QUEUED" || lifecycle === "SUBMITTED" || lifecycle === "DRAFT"
                ? "Assign the review to start."
                : "The review has already started.",
          ),
    request_info:
      decidable && lifecycle !== "NEEDS_INFORMATION"
        ? { allowed: true, reason: null }
        : closed(
            lifecycle === "NEEDS_INFORMATION"
              ? "Information has already been requested."
              : stageReason(),
          ),
    record_response:
      lifecycle === "NEEDS_INFORMATION"
        ? { allowed: true, reason: null }
        : closed(
            terminal ? terminalReason : "No information request is waiting for a response.",
          ),
    approve:
      decidable && lifecycle !== "NEEDS_INFORMATION"
        ? { allowed: true, reason: null }
        : closed(
            lifecycle === "NEEDS_INFORMATION"
              ? "Waiting for information — record the response to continue."
              : stageReason(),
          ),
    reject:
      decidable && lifecycle !== "NEEDS_INFORMATION"
        ? { allowed: true, reason: null }
        : closed(
            lifecycle === "NEEDS_INFORMATION"
              ? "Waiting for information — record the response to continue."
              : stageReason(),
          ),
    pause:
      !terminal && !paused
        ? { allowed: true, reason: null }
        : closed(paused ? "The review is already paused." : terminalReason),
    resume: paused
      ? { allowed: true, reason: null }
      : closed("The review is not paused."),
    reassign: closed("Reassign from the review queue."),
    adjudicate: closed("There is no disagreement to adjudicate."),
    archive: closed(GENERIC_DISABLED),
    reopen: TERMINAL.includes(lifecycle) ? { allowed: true, reason: null } : closed("Only a finished review can be reopened."),
    escalate: terminal ? closed(terminalReason) : { allowed: true, reason: null },
  };
}

/**
 * The action map the page renders. `viewer.actions` is authoritative; an
 * action the server did not list is closed (never assumed open).
 */
export function deriveActions(input: {
  viewer?: Viewer | null;
  lifecycleState: LifecycleState;
  paused: boolean;
  /** Whether the review has an assignee at all. */
  assigned?: boolean;
}): ActionMap {
  const viewer = input.viewer;
  if (!viewer || !Array.isArray(viewer.actions)) {
    return fallbackActions(input.lifecycleState, input.paused);
  }
  const out = {} as ActionMap;
  for (const name of ALL_ACTIONS) {
    out[name] = { allowed: false, reason: GENERIC_DISABLED };
  }
  const unassignedStage =
    input.assigned === false ||
    input.lifecycleState === "QUEUED" ||
    input.lifecycleState === "SUBMITTED" ||
    input.lifecycleState === "DRAFT";
  for (const a of viewer.actions) {
    if (!a || !ALL_ACTIONS.includes(a.action)) continue;
    if (a.allowed) {
      out[a.action] = { allowed: true, reason: null };
      continue;
    }
    const code = (a.reason ?? "").trim();
    let reason = humanReason(code) ?? GENERIC_DISABLED;
    // The server's code is about the actor or the state machine; the page
    // knows the context that makes it actionable.
    if (unassignedStage && (code === "not_assignee" || code === "invalid_transition") && a.action !== "reassign") {
      reason = "Assign the review to start.";
    } else if (
      input.lifecycleState === "NEEDS_INFORMATION" &&
      code === "invalid_transition" &&
      (a.action === "approve" || a.action === "reject" || a.action === "request_info")
    ) {
      reason = "Waiting for information — record the response to continue.";
    } else if (a.action === "start" && code === "invalid_transition") {
      reason = TERMINAL.includes(input.lifecycleState)
        ? "This review is already resolved."
        : "The review has already started.";
    }
    out[a.action] = { allowed: false, reason };
  }
  return out;
}

/**
 * The one reason shown under the "Next step" title: the reason the next
 * DECISION is closed, which is what a reviewer opening the page wants to know.
 */
export function mainBlockedReason(actions: ActionMap): string | null {
  for (const name of ["approve", "reject", "record_response", "start", "request_info"] as const) {
    const a = actions[name];
    if (!a.allowed && a.reason) {
      if (name === "record_response" && a.reason === "No information request is waiting for a response.") continue;
      return a.reason;
    }
  }
  return null;
}

/** The verdict kinds the single decision panel offers at FIRST and SECOND. */
export type VerdictChoice = "APPROVE" | "REJECT" | "REQUEST_INFO";
export const VERDICT_CHOICES: VerdictChoice[] = ["APPROVE", "REJECT", "REQUEST_INFO"];

/** The viewer action that opens each verdict kind. */
export const VERDICT_ACTION: Record<VerdictChoice, ViewerActionName> = {
  APPROVE: "approve",
  REJECT: "reject",
  REQUEST_INFO: "request_info",
};

/** The adjudication kinds the same panel offers in conflict. */
export type AdjudicationKind = "UPHOLD_FIRST" | "UPHOLD_SECOND" | "NEEDS_MORE_INFO" | "UNRESOLVED";
export const ADJUDICATION_KINDS: AdjudicationKind[] = ["UPHOLD_FIRST", "UPHOLD_SECOND", "NEEDS_MORE_INFO", "UNRESOLVED"];

/** The one submit label, named by the choice (TEAM-UI-SPEC §2). */
export function decisionSubmitLabel(choice: string | null | undefined): string {
  switch (choice) {
    case "APPROVE":
      return "Record approval";
    case "REJECT":
      return "Record rejection";
    case "REQUEST_INFO":
      return "Request information";
    case "UPHOLD_FIRST":
    case "UPHOLD_SECOND":
    case "NEEDS_MORE_INFO":
    case "UNRESOLVED":
      return "Record adjudication";
    default:
      return "Record decision";
  }
}

/**
 * The one-line consequence shown before submit, from the lineage state the
 * decisions panel last read. Internal wording only.
 */
export function decisionConsequence(input: {
  state: string | null;
  secondRequired: boolean;
  choice: string | null | undefined;
}): string | null {
  const { state, secondRequired, choice } = input;
  if (!choice) return null;
  if (choice === "REQUEST_INFO") {
    return "Asks for more information — the review waits until the response is recorded.";
  }
  if ((ADJUDICATION_KINDS as string[]).includes(choice)) {
    return "Records the adjudication — the final decision for this round.";
  }
  if (state === "first_required" && secondRequired) {
    return "Records the first review; an independent second reviewer must confirm.";
  }
  if (state === "second_required") {
    return "Records the second review. If it matches the first, the review is decided; if it differs, it goes to adjudication.";
  }
  if (choice === "APPROVE") return "Final decision — approved.";
  if (choice === "REJECT") return "Final decision — rejected.";
  return null;
}

/** What the "Next step" panel offers as its ONE primary control. */
export type NextStepPrimary =
  | "start"
  | "record_response"
  | "assign_second_reviewer"
  | "adjudicate"
  | "decide"
  | null;

/**
 * The single contextual primary (TEAM-UI-SPEC §2): Start review (assigned,
 * not started) · Record response (waiting for information) · Assign an
 * independent second reviewer (handoff, managers) · Go to adjudication
 * (conflict, independent owner/admin) · Go to decision (may decide now).
 */
export function nextStepPrimary(input: {
  actions: ActionMap;
  /** The lineage asks this viewer for a FIRST or SECOND decision. */
  mayDecide: boolean;
  /** The lineage is in conflict and this viewer may adjudicate. */
  mayAdjudicate: boolean;
  /** A second-review handoff awaits an assignment this viewer may make. */
  handoffAssign: boolean;
}): NextStepPrimary {
  const { actions } = input;
  // T-020 — the REAL next step first: a hand-off that needs an assignment,
  // an adjudication, a waiting response, a decision; Start only for a review
  // that has not started (the server no longer offers Start on one in review).
  if (input.handoffAssign && actions.reassign.allowed) return "assign_second_reviewer";
  if (input.mayAdjudicate) return "adjudicate";
  if (actions.record_response.allowed) return "record_response";
  if (actions.start.allowed) return "start";
  if (input.mayDecide) return "decide";
  return null;
}

// ---------------------------------------------------------------------------
// Outcome → copy
// ---------------------------------------------------------------------------

export type LifecycleActionKind =
  | "approve"
  | "reject"
  | "request_info"
  | "record_response"
  | "decision";

// The one outcome copy lives in @proovra/shared (review-decision-copy), so focus
// mode, the Evidence page and the mobile app say what the Review page says.
export { FIRST_ONLY_MESSAGE, ADJUDICATION_NEXT_MESSAGE };

export function describeOutcome(
  kind: LifecycleActionKind,
  outcome: DecisionOutcome | null | undefined,
): string {
  return describeReviewOutcome(kind, outcome);
}

// ---------------------------------------------------------------------------
// Refusals → copy
// ---------------------------------------------------------------------------

export type Refusal = {
  status: number;
  code: string | null;
  reason: string | null;
};

/**
 * One message per refusal — the shared catalog (@proovra/shared
 * describeReviewRefusal), so every door's refusal reads the same everywhere.
 */
export function describeRefusal(r: Refusal, fallback: string): string {
  return describeReviewRefusal(r, fallback);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  QUEUED: "Queued",
  ASSIGNED: "Assigned",
  IN_REVIEW: "In review",
  NEEDS_INFORMATION: "Waiting for information",
  ESCALATED: "Escalated",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
};

export function lifecycleLabel(state: string): string {
  return LIFECYCLE_LABELS[state as LifecycleState] ?? "Unknown status";
}

const SLA_STATE_LABELS: Record<SlaState, string> = {
  HEALTHY: "On track",
  DUE_SOON: "Due soon",
  BREACHED: "Overdue",
  // T-045 (stage C) — an escalation is not a deadline state; the server no
  // longer sends ESCALATED here, and it never meant "overdue".
  ESCALATED: "Escalation open",
  BLOCKED: "Blocked",
  PAUSED: "Paused",
  // T-043 — completed is not "met": met means on time (see sla-presentation).
  COMPLETED: "Completed",
};

export function slaStateLabel(state: string): string {
  return SLA_STATE_LABELS[state as SlaState] ?? "Unknown";
}

/**
 * The header SLA badge. When the lifecycle badge already says "Escalated",
 * the SLA badge does not repeat the word (the old header read
 * "escalated • escalated").
 */
export function headerSlaLabel(sla: string, _lifecycle: string): string {
  // T-045 (stage C) — never "SLA overdue" because an escalation is open.
  return `SLA ${slaStateLabel(sla).toLowerCase()}`;
}

const SLA_DIMENSION_LABELS: Record<string, string> = {
  ASSIGNMENT: "Assignment",
  FIRST_RESPONSE: "First response",
  RESOLUTION: "Resolution",
  REVIEW: "Review",
  DECISION: "Decision",
  ESCALATION: "Escalation",
};

export function slaDimensionLabel(dimension: string): string {
  const known = SLA_DIMENSION_LABELS[dimension];
  if (known) return known;
  const words = dimension.toLowerCase().replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "SLA";
}

export const DECISION_KIND_LABELS: Record<string, string> = {
  APPROVE: "Approved",
  REJECT: "Rejected",
  REQUEST_INFO: "Information requested",
  NEEDS_MORE_INFO: "Needs more information",
  UPHOLD_FIRST: "Upheld the first decision",
  UPHOLD_SECOND: "Upheld the second decision",
  UNRESOLVED: "Unresolved",
};

export const DECISION_OPTION_LABELS: Record<string, string> = {
  APPROVE: "Approve",
  REJECT: "Reject",
  REQUEST_INFO: "Request information",
  NEEDS_MORE_INFO: "Needs more information",
  UPHOLD_FIRST: "Uphold the first decision",
  UPHOLD_SECOND: "Uphold the second decision",
  UNRESOLVED: "Leave unresolved",
};

export const STAGE_LABELS: Record<string, string> = {
  FIRST: "First review",
  SECOND: "Second review",
  ADJUDICATION: "Adjudication",
};

export const REASON_CODE_LABELS: Record<string, string> = {
  EVIDENCE_INCOMPLETE: "Evidence incomplete",
  REPORT_FAILED: "Report failed",
  INTEGRITY_CONCERN: "Integrity concern",
  CUSTODY_CONCERN: "Custody concern",
  MISSING_CONTEXT: "Missing context",
  LEGAL_HOLD_ISSUE: "Legal hold issue",
  REDACTION_REQUIRED: "Redaction required",
  REVIEWER_DISAGREEMENT: "Reviewer disagreement",
  OTHER: "Other",
};

export const SECOND_REVIEW_TRIGGER_LABELS: Readonly<Record<string, string>> = SECOND_REVIEW_CAUSE_LABELS;

export function teamRoleLabel(role: string | null | undefined): string {
  switch ((role ?? "").toUpperCase()) {
    case "OWNER":
      return "Owner";
    case "ADMIN":
      return "Admin";
    case "MEMBER":
      return "Member";
    case "REVIEWER":
      return "Reviewer";
    case "VIEWER":
      return "Viewer";
    default:
      return "No workspace role";
  }
}
