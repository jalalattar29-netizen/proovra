/**
 * TEAM-SPEC R3 (2026-11-23) — the Evidence page's review actions, narrowed to
 * what the decision authority (`recordReviewDecision`) and the Close guard
 * actually accept.
 *
 * The shared projection (`projectReviewWorkflowActions`, @proovra/shared) knows
 * the stage matrix and the decision state but predates R3: it offered a verdict
 * to any reviewer and treated an owner's/admin's plain verdict in a conflict as
 * the deciding one. The authority now refuses both — a FIRST or SECOND verdict
 * is the CURRENT ASSIGNEE's, a conflict is resolved only through the explicit
 * adjudication action, and Close never skips a pending second review. This
 * post-pass applies exactly those rules (the same as the reviewer console's
 * `computeViewerActions`), keeps the response shape (`blockedBy` stays in the
 * shared vocabulary) and adds `reason`, the server's own refusal code.
 *
 * Lives beside the workflow (evidence-review), not in reviewer-ops: the
 * evidence route may not import reviewer-ops services.
 */
import type { ReviewDecisionState, ReviewWorkflowActionAvailability } from "@proovra/shared";

const VERDICTS: ReadonlySet<string> = new Set(["APPROVE_INTERNAL", "REQUEST_MORE_INFO", "REJECT_INSUFFICIENT"]);

export type ReviewActionWithReason = ReviewWorkflowActionAvailability & { reason?: string };

export function applyReviewDecisionAuthority(
  actions: ReadonlyArray<ReviewWorkflowActionAvailability>,
  input: {
    assignedToUserId: string | null;
    viewerUserId: string;
    decision: { state: ReviewDecisionState; firstReviewerUserId: string | null; resolvedByRequestInfo: boolean };
  },
): ReviewActionWithReason[] {
  const { decision } = input;
  const isAssignee = !!input.assignedToUserId && input.assignedToUserId === input.viewerUserId;
  // A round resolved by a request for information is followed by a NEW round,
  // whose next verdict is a FIRST one.
  const state: ReviewDecisionState =
    decision.state === "resolved" && decision.resolvedByRequestInfo ? "first_required" : decision.state;

  const block = (a: ReviewWorkflowActionAvailability): Pick<ReviewActionWithReason, "blockedBy" | "reason"> | null => {
    if (VERDICTS.has(a.action)) {
      if (state === "conflict_detected" || state === "adjudication_required") {
        // Plain verdict buttons never adjudicate, whoever the viewer is.
        return { blockedBy: "ADJUDICATION_REQUIRED", reason: "use_adjudication" };
      }
      if (state === "first_required" && !isAssignee) {
        return {
          blockedBy: input.assignedToUserId ? "OWNED_BY_SOMEONE_ELSE" : "CLAIM_FIRST",
          reason: "not_assignee",
        };
      }
      if (state === "second_required") {
        if (decision.firstReviewerUserId === input.viewerUserId) {
          return { blockedBy: "AWAITING_SECOND_REVIEWER", reason: "same_reviewer_blocked" };
        }
        if (!isAssignee) {
          return { blockedBy: "AWAITING_SECOND_REVIEWER", reason: "second_stage_needs_reassignment" };
        }
      }
      return null;
    }
    if (a.action === "CLOSE") {
      if (state === "second_required") return { blockedBy: "AWAITING_SECOND_REVIEWER", reason: "second_review_pending" };
      if (state === "conflict_detected" || state === "adjudication_required") {
        return { blockedBy: "ADJUDICATION_REQUIRED", reason: "second_review_pending" };
      }
    }
    return null;
  };

  return actions.map((a) => {
    // An action the shared projection already blocks keeps its own answer.
    if (!a.enabled) return { ...a };
    const b = block(a);
    return b ? { ...a, enabled: false, blockedBy: b.blockedBy, reason: b.reason } : { ...a };
  });
}
