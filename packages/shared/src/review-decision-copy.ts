/**
 * THE ONE OUTCOME AND REFUSAL COPY for review decisions (Team remediation,
 * 2026-11-24 — CONSUMER-MAP §1.4 "Outcome copy").
 *
 * The decision authority answers every door with the same `outcome` and the
 * same refusal `details.reason`; this module turns them into the sentences the
 * web Review page, focus mode, the Evidence page and the mobile app show, so a
 * first-of-two decision never reads as an approval on one surface and as
 * "recorded" on another.
 *
 * Wording: approvals and rejections are INTERNAL review decisions. Nothing
 * here may read as a public authenticity statement.
 */

export type ReviewDecisionOutcomeCopyInput = {
  stageRecorded: "FIRST" | "SECOND" | "ADJUDICATION" | string;
  statusChanged: boolean;
  reviewState?: string;
  nextRequirement: "second_review" | "adjudication" | "information" | null;
  idempotent: boolean;
  secondReview?: {
    cause?: string | null;
    eligibleReviewerCount?: number | null;
    staffing?: "ok" | "no_eligible_second_reviewer" | string | null;
  } | null;
};

export type ReviewOutcomeKind = "approve" | "reject" | "request_info" | "record_response" | "decision";

/** Why a second review is required, as a clause ("because …"). */
export const SECOND_REVIEW_CAUSE_LABELS: Readonly<Record<string, string>> = {
  workflow_escalated: "the two reviews disagreed",
  independent_review_requested: "an independent review was requested",
  integrity_escalation: "an integrity concern was escalated",
  legacy_escalation: "an escalation raised before 27 Nov 2026 requires it",
  workspace_policy: "this workspace requires two reviewers for every review",
  open_escalation: "an escalation is open",
  active_legal_hold: "the evidence is under legal hold",
  redaction_required: "fields need redaction",
  unresolved_adjudication: "the previous round's adjudication was left unresolved",
  recorded_requirement: "it was required when the first review was recorded",
};

export function secondReviewCauseLabel(cause: string | null | undefined): string | null {
  if (!cause) return null;
  return SECOND_REVIEW_CAUSE_LABELS[cause] ?? null;
}

export const FIRST_ONLY_MESSAGE = "First review recorded — waiting for an independent reviewer. It is not final until a second reviewer decides.";
export const FIRST_ONLY_NO_REVIEWER_MESSAGE =
  "First review recorded — waiting for an independent reviewer. Nobody else is eligible yet: invite a member with review permission, then assign the second review.";
export const INFORMATION_REQUESTED_MESSAGE = "Information requested. The review waits until the response is recorded.";
export const ADJUDICATION_NEXT_MESSAGE =
  "Decision recorded. The two reviews disagree, so an independent owner or admin must adjudicate.";
export const ALREADY_RECORDED_MESSAGE = "This decision was already recorded. Nothing changed.";

/** What a submission actually did, in one sentence (every surface). */
export function describeReviewOutcome(
  kind: ReviewOutcomeKind,
  outcome: ReviewDecisionOutcomeCopyInput | null | undefined,
): string {
  if (outcome && typeof outcome === "object") {
    if (outcome.idempotent) return ALREADY_RECORDED_MESSAGE;
    if (outcome.nextRequirement === "second_review") {
      return outcome.secondReview?.staffing === "no_eligible_second_reviewer"
        ? FIRST_ONLY_NO_REVIEWER_MESSAGE
        : FIRST_ONLY_MESSAGE;
    }
    if (outcome.nextRequirement === "adjudication") return ADJUDICATION_NEXT_MESSAGE;
    if (outcome.nextRequirement === "information") return INFORMATION_REQUESTED_MESSAGE;
    if (outcome.statusChanged) {
      if (kind === "approve") return "Review approved (internal).";
      if (kind === "reject") return "Review not accepted (internal).";
      if (kind === "request_info") return "Information requested. The review waits for a response.";
      if (kind === "record_response") return "Response recorded. The review can continue.";
      if (outcome.stageRecorded === "ADJUDICATION") return "Adjudication recorded. The review is resolved.";
      return "Decision recorded. The review is resolved.";
    }
    if (outcome.stageRecorded === "ADJUDICATION") {
      return "Adjudication recorded. A new review round starts: the assigned reviewer decides, then an independent reviewer confirms.";
    }
    return "Decision recorded. The review status did not change.";
  }
  // An API that predates `outcome`: say only what is certain.
  if (kind === "approve") return "Approval recorded (internal).";
  if (kind === "reject") return "Not accepted — recorded (internal).";
  if (kind === "request_info") return "Information requested.";
  if (kind === "record_response") return "Response recorded.";
  return "Decision recorded.";
}

/**
 * The requirement, its cause and reviewer availability, BEFORE the reviewer
 * submits — said ONCE (review remediation 2026-11-27, F-05/F-06). null when
 * one review decides. A missing second reviewer never blocks recording the
 * first decision; the sentence says what happens instead.
 */
export function describeSecondReviewRequirement(input: {
  required: boolean;
  cause?: string | null;
  escalation?: { reason?: string | null; severity?: string | null; requestedByName?: string | null; requestedAtLabel?: string | null } | null;
  eligibleReviewerCount?: number | null;
  state?: string | null;
}): string | null {
  if (!input.required) return null;
  const cause = secondReviewCauseLabel(input.cause);
  const who = input.escalation?.requestedByName
    ? ` (${input.escalation.requestedByName}${input.escalation.requestedAtLabel ? `, ${input.escalation.requestedAtLabel}` : ""})`
    : "";
  const because = cause ? ` because ${cause}${who}` : "";
  if (input.state === "second_required") {
    return `This is the independent second decision${because}. The reviewer who made the first decision cannot make it.`;
  }
  const lead = `Two decisions are needed${because}: yours is recorded first and stays pending until a different reviewer confirms it.`;
  if (input.eligibleReviewerCount === 0) {
    return `${lead} Nobody else is eligible to confirm it yet — invite a member with review permission, then assign the second review.`;
  }
  if (typeof input.eligibleReviewerCount === "number") {
    const n = input.eligibleReviewerCount;
    return `${lead} ${n >= 50 ? "50+" : n} ${n === 1 ? "reviewer is" : "reviewers are"} eligible to confirm it.`;
  }
  return lead;
}

/**
 * T-022 — what governed the RECORDED decisions of a round, never today's
 * re-derived rule.
 */
export function describeGoverningRequirement(input: {
  reviewers: number;
  secondReviewRequired: boolean;
  cause?: string | null;
}): string | null {
  const cause = secondReviewCauseLabel(input.cause);
  if (input.reviewers >= 3) return "Decided by adjudication after the two reviews disagreed.";
  if (input.reviewers === 2) {
    return cause
      ? `Decided by two reviewers (a second review was required because ${cause}).`
      : "Decided by two reviewers.";
  }
  if (input.reviewers === 1 && input.secondReviewRequired) {
    return cause
      ? `First review recorded; a second review is required because ${cause}.`
      : "First review recorded; a second review is required.";
  }
  if (input.reviewers === 1) return "Decided by one reviewer (no policy required a second review).";
  return null;
}

/** One message per refusal reason (`details.reason`), shared by every door. */
export const REVIEW_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  not_assignee:
    "Only the assigned reviewer can record this decision. Ask an assignment manager to assign the review to you.",
  second_stage_needs_reassignment:
    "This review needs its second decision from a different reviewer. Reassign it to another eligible reviewer.",
  same_reviewer_blocked:
    "You made the first decision, so you cannot make the second. A different reviewer must decide.",
  use_adjudication:
    "The two reviews disagree. Record the outcome as an adjudication — an approval or rejection cannot settle a disagreement.",
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
  duplicate_stage_decision: "A decision for this stage has already been recorded. Reload to see it.",
  forbidden_wording:
    "The note uses wording that cannot be recorded, such as a public authenticity claim. Rephrase it and try again.",
  rationale_required: "Explain your reason — a rationale is required for every decision and every request for information.",
  rationale_too_long: "The rationale is too long — keep it to 4000 characters.",
  resolver_is_assignee:
    "This escalation requires an independent second decision, so the reviewer it constrains cannot resolve it. Another owner or admin must.",
  resolver_decided_this_round:
    "You decided this review, so you cannot resolve the escalation that requires its independent second decision. Another owner or admin must.",
  independent_resolver_required:
    "This escalation requires an independent second decision; only an owner or admin who is not the reviewer can resolve it.",
  review_assign_required: "Only the assigned reviewer or an assignment manager can do this.",
  // Engine aliases for the reasons above.
  actor_not_assignee:
    "Only the assigned reviewer can record this decision. Ask an assignment manager to assign the review to you.",
  concurrent_change:
    "This review changed while you were working on it. Check the latest state before deciding again.",
  review_finished: "This review is already resolved; no further actions are accepted.",
  not_awaiting_information: "No information request is waiting for a response on this review.",
  already_paused: "The review is already paused.",
  not_paused: "The review is not paused.",
  // Review remediation 2026-11-27.
  reviewer_not_eligible:
    "You are no longer eligible to review this record (membership, review permission, access to the evidence or a required team placement changed). Ask an assignment manager to reassign it.",
  coding_incomplete:
    "This workspace requires the coding assessment to be complete before approving or rejecting. Fill the required fields listed below, or request information instead.",
  review_is_resolved: "This review was already decided in another tab or by another reviewer.",
  no_challengeable_decision: "There is no recorded decision you can challenge on this review.",
  not_requester: "Only the reviewer who requested the information can withdraw the request.",
  challenge_resolver_not_independent:
    "You challenged or made the challenged decision, so you cannot resolve this challenge. Another owner or admin must.",
};

/** The one prefix every refused write shows ("nothing was recorded"). */
export function notRecordedMessage(detail: string): string {
  return `Not recorded: ${detail.replace(/^[A-Z]/, (m) => m.toLowerCase())}`;
}

export type ReviewRefusal = { status: number; code: string | null; reason: string | null };

/**
 * One message per refusal. Reason first (the contract's `details.reason`),
 * then a code that is itself a reason, then step-up, network and status
 * fallbacks. Never a raw identifier.
 */
export function describeReviewRefusal(r: ReviewRefusal, fallback: string): string {
  const reason = r.reason?.trim() || null;
  if (reason && REVIEW_REFUSAL_MESSAGES[reason]) return REVIEW_REFUSAL_MESSAGES[reason]!;
  const code = r.code?.trim() || null;
  if (code && REVIEW_REFUSAL_MESSAGES[code]) return REVIEW_REFUSAL_MESSAGES[code]!;
  const upper = code?.toUpperCase() ?? "";
  if (upper.startsWith("STEP_UP") || (reason ?? "").toUpperCase().startsWith("STEP_UP")) {
    return "This action needs you to confirm your identity again. Re-verify, then try again.";
  }
  if (upper === "NETWORK_ERROR") {
    return "The connection dropped before the server answered. Reload to check whether the action was recorded before trying again.";
  }
  if (upper === "REVIEW_NOTE_REQUIRED") return REVIEW_REFUSAL_MESSAGES.rationale_required!;
  if (code === "decision_not_allowed" || upper === "DECISION_NOT_ALLOWED") {
    return "That decision is not allowed at this stage of the review. Reload to see what is needed now.";
  }
  if (r.status === 403) return "You do not have permission to do this on this review.";
  if (r.status === 404) return "This review no longer exists in this workspace.";
  if (r.status === 409) return "The review's state does not allow this right now. Reload to see what is needed now.";
  return fallback;
}

/**
 * The Escalate dialog's statement of the escalation's EFFECT (2026-11-27):
 * an administrative escalation alerts owners and admins and changes nothing
 * about who decides; an integrity reason or an explicit request requires an
 * independent second decision. Kept under the T-019 name for callers.
 */
export function describeEscalationIndependence(forces: boolean): string | null {
  return forces
    ? "This escalation requires an independent second decision: the review's decision must then be confirmed by a different reviewer, and only an owner or admin who is neither reviewer can resolve the escalation."
    : "This escalation alerts the workspace's owners and admins. It does not change who can decide the review.";
}

/** Extra line when independence is requested but nobody else is eligible (F-09). */
export function describeIndependenceStaffing(eligibleReviewerCount: number | null | undefined): string | null {
  if (eligibleReviewerCount !== 0) return null;
  return "Nobody else in this workspace can give the second decision yet. The review would stay pending until you invite a member with review permission.";
}

// -----------------------------------------------------------------------------
// T-083 (stage D) — what an AUTOMATIC escalation says.
// -----------------------------------------------------------------------------

/**
 * The summary the review automation writes on an escalation it raises itself.
 * Catalog copy (the operations catalog `ops.review.escalation.overdue_auto` /
 * `stuck_auto` meaning), never engine wording ("reviewer ops reconcile").
 */
export const REVIEW_AUTO_ESCALATION_SUMMARY = {
  overdue: "Review is past its deadline; raised automatically.",
  stuck: (label: string): string => `Review is stuck (${label.trim().toLowerCase()}); raised automatically.`,
} as const;

const LEGACY_OVERDUE_SUMMARY = /^Review past due\s*[—-]\s*automatic escalation by reviewer ops reconcile\.?$/i;
const LEGACY_STUCK_SUMMARY = /^Workflow stuck\s*[—-]\s*(.+?)\.\s*Automatic escalation by reviewer ops reconcile\.?$/i;

/**
 * T-083 — an escalation summary as a person reads it. Rows written before the
 * engine used catalog copy carry the engine's English ("… by reviewer ops
 * reconcile."); they are presented in the catalog's words at read time (the
 * stored row is never rewritten). A person's own summary is shown as written.
 */
export function presentReviewEscalationSummary(summary: string | null | undefined): string {
  const text = (summary ?? "").trim();
  if (LEGACY_OVERDUE_SUMMARY.test(text)) return REVIEW_AUTO_ESCALATION_SUMMARY.overdue;
  const stuck = LEGACY_STUCK_SUMMARY.exec(text);
  if (stuck) return REVIEW_AUTO_ESCALATION_SUMMARY.stuck(stuck[1]!);
  return text;
}
