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
  | "archive";

export type ViewerAction = {
  action: ViewerActionName;
  allowed: boolean;
  reason?: string;
};

export type Viewer = {
  userId: string;
  isAssignee: boolean;
  actions: ViewerAction[];
};

export type DecisionOutcome = {
  stageRecorded: "FIRST" | "SECOND" | "ADJUDICATION";
  statusChanged: boolean;
  reviewState: string;
  nextRequirement: "second_review" | "adjudication" | null;
  idempotent: boolean;
};

export type ActionState = { allowed: boolean; reason: string | null };
export type ActionMap = Record<ViewerActionName, ActionState>;

export const ACTION_LABELS: Record<ViewerActionName, string> = {
  start: "Start review",
  pause: "Pause",
  resume: "Resume",
  request_info: "Request information",
  record_response: "Record response",
  approve: "Approve (internal)",
  reject: "Reject (internal)",
  reassign: "Reassign",
  adjudicate: "Adjudicate the disagreement",
  archive: "Archive",
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

/** The actions with an inline control, in the order a reviewer meets them. */
export const INLINE_ACTIONS: ViewerActionName[] = [
  "start",
  "approve",
  "reject",
  "request_info",
  "record_response",
  "pause",
  "resume",
];

/**
 * The one reason shown under "What you can do now": the reason the next
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

/** The single primary control: the next allowed step forward. */
export function primaryAction(actions: ActionMap): ViewerActionName | null {
  for (const name of ["start", "record_response", "approve", "adjudicate"] as const) {
    if (actions[name].allowed) return name;
  }
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

export const FIRST_ONLY_MESSAGE = "First review recorded. A second reviewer must confirm.";
export const ADJUDICATION_NEXT_MESSAGE =
  "Decision recorded. The two reviews disagree, so an independent owner or admin must adjudicate.";

export function describeOutcome(
  kind: LifecycleActionKind,
  outcome: DecisionOutcome | null | undefined,
): string {
  if (outcome && typeof outcome === "object") {
    if (outcome.idempotent) return "This decision was already recorded. Nothing changed.";
    if (outcome.nextRequirement === "second_review") return FIRST_ONLY_MESSAGE;
    if (outcome.nextRequirement === "adjudication") return ADJUDICATION_NEXT_MESSAGE;
    if (outcome.statusChanged) {
      if (kind === "approve") return "Review approved (internal).";
      if (kind === "reject") return "Review rejected (internal).";
      if (kind === "request_info") return "Information requested. The review waits for a response.";
      if (kind === "record_response") return "Response recorded. The review can continue.";
      if (outcome.stageRecorded === "ADJUDICATION") return "Adjudication recorded. The review is resolved.";
      return "Decision recorded. The review is resolved.";
    }
    return "Decision recorded. The review status did not change.";
  }
  // An API that predates `outcome`: say only what is certain.
  if (kind === "approve") return "Approval recorded (internal).";
  if (kind === "reject") return "Rejection recorded (internal).";
  if (kind === "request_info") return "Information requested.";
  if (kind === "record_response") return "Response recorded.";
  return "Decision recorded.";
}

/** Approve confirmation copy, from what the decisions panel last read. */
export function approveConfirmDescription(review: {
  state: string | null;
  secondRequired: boolean;
}): string {
  const internal =
    "This is an internal review decision. It is not a public statement about the evidence's authenticity.";
  if (review.state === "first_required" && review.secondRequired) {
    return `This records the first review only — a second reviewer must confirm before the review is approved. ${internal}`;
  }
  if (review.state === "second_required") {
    return `This records the second review. If it matches the first, the review is approved (internal); if it differs, it goes to adjudication. ${internal}`;
  }
  return `${internal} The approval is recorded permanently and may release outputs held for review. Reopening starts a new round; it does not remove this decision.`;
}

// ---------------------------------------------------------------------------
// Refusals → copy
// ---------------------------------------------------------------------------

export type Refusal = {
  status: number;
  code: string | null;
  reason: string | null;
};

const REFUSAL_MESSAGES: Record<string, string> = {
  not_assignee:
    "Only the assigned reviewer can record this decision. Ask an assignment manager to assign the review to you.",
  second_stage_needs_reassignment:
    "This review needs its second decision from a different reviewer. Reassign it to another eligible reviewer.",
  same_reviewer_blocked:
    "You made the first decision, so you cannot make the second. A different reviewer must decide.",
  use_adjudication:
    "The two reviews disagree. Use the adjudication panel — Approve and Reject cannot settle a disagreement.",
  adjudicator_role_required: "Adjudication needs a workspace owner or admin.",
  adjudicator_not_independent:
    "You decided one of the two reviews, so you cannot adjudicate them. Another owner or admin must.",
  second_review_pending:
    "A second review or adjudication is still pending, so this review cannot be closed yet.",
  second_reviewer_not_independent:
    "The first reviewer cannot take the second review. Choose a different reviewer.",
  decision_not_from_stage:
    "That decision is not available at this stage of the review. Reload to see what is needed now.",
  stale_decision:
    "This review changed while you were working on it. Check the latest state before deciding again.",
  review_already_resolved: "This review is already resolved; no further decisions are accepted.",
  duplicate_stage_decision:
    "A decision for this stage has already been recorded. Reload to see it.",
  forbidden_wording:
    "The note uses wording that cannot be recorded, such as a public authenticity claim. Rephrase it and try again.",
  // Engine aliases for the reasons above.
  actor_not_assignee:
    "Only the assigned reviewer can record this decision. Ask an assignment manager to assign the review to you.",
  concurrent_change:
    "This review changed while you were working on it. Check the latest state before deciding again.",
  review_finished: "This review is already resolved; no further actions are accepted.",
  not_awaiting_information: "No information request is waiting for a response on this review.",
  already_paused: "The review is already paused.",
  not_paused: "The review is not paused.",
};

/**
 * One message per refusal. Reason first (the contract's `details.reason`),
 * then a code that is itself a reason (the lineage route sends some as the
 * code), then step-up, network and status fallbacks.
 */
export function describeRefusal(r: Refusal, fallback: string): string {
  const reason = r.reason?.trim() || null;
  if (reason && REFUSAL_MESSAGES[reason]) return REFUSAL_MESSAGES[reason];
  const code = r.code?.trim() || null;
  if (code && REFUSAL_MESSAGES[code]) return REFUSAL_MESSAGES[code];
  const upper = code?.toUpperCase() ?? "";
  if (upper.startsWith("STEP_UP") || (reason ?? "").toUpperCase().startsWith("STEP_UP")) {
    return "This action needs you to confirm your identity again. Re-verify, then try again.";
  }
  if (upper === "NETWORK_ERROR") {
    return "The connection dropped before the server answered. Reload to check whether the action was recorded before trying again.";
  }
  if (code === "decision_not_allowed" || upper === "DECISION_NOT_ALLOWED") {
    return "That decision is not allowed at this stage of the review. Reload to see what is needed now.";
  }
  if (r.status === 403) return "You do not have permission to do this on this review.";
  if (r.status === 404) return "This review no longer exists in this workspace.";
  if (r.status === 409) {
    return "The review's state does not allow this right now. Reload to see what is needed now.";
  }
  return fallback;
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
  APPROVED: "Approved (internal)",
  REJECTED: "Rejected (internal)",
  ARCHIVED: "Archived",
};

export function lifecycleLabel(state: string): string {
  return LIFECYCLE_LABELS[state as LifecycleState] ?? "Unknown status";
}

const SLA_STATE_LABELS: Record<SlaState, string> = {
  HEALTHY: "On track",
  DUE_SOON: "Due soon",
  BREACHED: "Overdue",
  ESCALATED: "Overdue (escalated)",
  BLOCKED: "Blocked",
  PAUSED: "Paused",
  COMPLETED: "Met",
};

export function slaStateLabel(state: string): string {
  return SLA_STATE_LABELS[state as SlaState] ?? "Unknown";
}

/**
 * The header SLA badge. When the lifecycle badge already says "Escalated",
 * the SLA badge does not repeat the word (the old header read
 * "escalated • escalated").
 */
export function headerSlaLabel(sla: string, lifecycle: string): string {
  if (sla === "ESCALATED" && lifecycle === "ESCALATED") return "SLA overdue";
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
  APPROVE: "Approved (internal)",
  REJECT: "Rejected (internal)",
  REQUEST_INFO: "Information requested",
  NEEDS_MORE_INFO: "Needs more information",
  UPHOLD_FIRST: "Upheld the first decision",
  UPHOLD_SECOND: "Upheld the second decision",
  UNRESOLVED: "Unresolved",
};

export const DECISION_OPTION_LABELS: Record<string, string> = {
  APPROVE: "Approve (internal)",
  REJECT: "Reject (internal)",
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

export const SECOND_REVIEW_TRIGGER_LABELS: Record<string, string> = {
  workflow_escalated: "the review was escalated",
  open_escalation: "an escalation is open",
  active_legal_hold: "the evidence is under legal hold",
  redaction_required: "fields need redaction",
};

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
