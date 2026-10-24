"use client";

/**
 * Review actions — the internal review decisions for one record.
 *
 * WHAT THIS PANEL MAY OFFER IS THE SERVER'S ANSWER (2026-10-23). It used to
 * keep its own copy of the stage matrix, enable buttons from a status it never
 * refreshed after an action, ask for reasons through `window.prompt`, and name
 * the assignee by a truncated user id. Claim, Escalate and Reopen therefore
 * looked like they did nothing: the request succeeded, and the panel went on
 * showing the old state with the same buttons.
 *
 * Now:
 *   - each control is enabled exactly when the server's `availableActions`
 *     (the shared `projectReviewWorkflowActions`) says so, and otherwise says
 *     why beside it;
 *   - every click ends in one visible outcome — busy, then a persistent
 *     success line and the RE-READ record (`onChanged` refetches the
 *     workspace), or an actionable error — and a second click cannot be sent
 *     while one is in flight;
 *   - a decision that needs a reason asks for it in the panel, and states what
 *     the decision will do before it is taken;
 *   - the assignee is a name, "You", or "Unassigned" — never an identifier.
 *
 * Internal only: decisions and notes never reach public verification, the
 * report or external contributors, and they do not change the evidence.
 */

import { useId, useState } from "react";

import {
  REVIEW_WORKFLOW_ACTION_LABELS,
  REVIEW_WORKFLOW_ACTION_OUTCOMES,
  REVIEW_WORKFLOW_BLOCK_COPY,
  reviewAssigneeLabel,
  reviewWorkflowStateLabel,
  type ReviewWorkflowAction,
  type ReviewWorkflowActionAvailability,
} from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { ReasonedActionButton } from "./ReasonedActionButton";

/** The review routes' refusal codes, said in words a reviewer can act on. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  already_assigned_elsewhere:
    "Another reviewer claimed this review first. The panel now shows the current owner.",
  already_in_stage: "The review is already in that state. The panel now shows the current state.",
  invalid_stage_transition:
    "That step is not available at the review's current stage. The panel now shows the current state.",
  review_already_resolved:
    "A verdict is already recorded for this review, so another cannot be recorded here.",
  duplicate_stage_decision:
    "A verdict for this review stage was recorded at the same moment by someone else.",
  same_reviewer_blocked: "The second review must be made by a different reviewer.",
  note_required: "This decision needs a written reason.",
  rationale_required: "This decision needs a written reason.",
  STEP_UP_REQUIRED: "Confirm your identity to record this decision, then try again.",
  reviewer_operations_not_included: "The review workflow is not included in this workspace's plan.",
};

/** The route's limit for an escalation reason, applied to every reason. */
const NOTE_MAX = 400;

const SUCCESS_COPY: Readonly<Record<ReviewWorkflowAction, string>> = {
  CLAIM: "You now own this review.",
  BEGIN_REVIEW: "Review begun. A verdict can now be recorded.",
  APPROVE_INTERNAL: "Internal approval recorded.",
  REQUEST_MORE_INFO: "More information requested.",
  REJECT_INSUFFICIENT: "Rejection recorded.",
  ESCALATE: "Review escalated to this workspace's owners and admins.",
  REOPEN: "Review reopened.",
  CLOSE: "Review closed.",
};

/**
 * Begin review: a version-checked move of a claimed review to In review
 * (audit F7). claimAndBeginReview sends the same request after a claim.
 */
export async function beginReview(evidenceId: string, expectedUpdatedAt: string | null | undefined) {
  await apiFetch(`/v1/evidence/${evidenceId}/reviewer-workflow`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "IN_REVIEW", ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) }),
  });
}

/**
 * Start review = claim it, then begin it against the claim's own version.
 * A refused claim throws; a claim that succeeded is never reported as a
 * failure — a refused begin comes back as `beginError`.
 */
export async function claimAndBeginReview(evidenceId: string, teamId: string): Promise<{ beginError: unknown }> {
  const claimed = (await apiFetch(`/v1/review-operations/evidence/${evidenceId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId }),
  })) as { workflow?: { updatedAt?: string } } | null;
  // The path is written here, not forwarded, so the request is attributed
  // to its route by the capability analyzer.
  const expectedUpdatedAt = claimed?.workflow?.updatedAt;
  try {
    await apiFetch(`/v1/evidence/${evidenceId}/reviewer-workflow`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "IN_REVIEW", ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) }),
    });
    return { beginError: null };
  } catch (beginError) {
    return { beginError: beginError ?? new Error("begin_failed") };
  }
}

function refusalMessage(err: unknown, fallback: string): string {
  const e = (err ?? {}) as { body?: { error?: { code?: string } }; code?: string };
  const code = e.body?.error?.code ?? e.code ?? null;
  if (code && REFUSAL_COPY[code]) return REFUSAL_COPY[code]!;
  return toSafeUserError(err, { message: fallback }).message;
}

export function EvidenceReviewActionsPanel({
  evidenceId,
  teamId,
  currentStatus,
  decisionLabel,
  assignedTo,
  viewerUserId,
  availableActions,
  workflowUpdatedAt,
  onChanged,
}: {
  evidenceId: string;
  teamId: string | null;
  currentStatus: string | null;
  /** The server's current-round decision label (2026-10-24); the state alone never names a verdict. */
  decisionLabel?: string | null;
  assignedTo: { id: string; displayName: string | null; email: string | null } | null;
  viewerUserId: string | null;
  /** The server's projection; absent → nothing is offered. */
  availableActions: ReadonlyArray<ReviewWorkflowActionAvailability> | null | undefined;
  /**
   * The workflow version this panel shows. Begin review sends it, so a review
   * that changed under the viewer is refused rather than overwritten.
   */
  workflowUpdatedAt?: string | null;
  /** Re-reads the record from the server. Awaited before success is shown. */
  onChanged?: () => Promise<void> | void;
}) {
  const { confirm } = useConfirmAction();
  const [pending, setPending] = useState<ReviewWorkflowAction | null>(null);
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reasonFor, setReasonFor] = useState<ReviewWorkflowAction | null>(null);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const actions = availableActions ?? [];
  const byAction = new Map(actions.map((a) => [a.action, a]));

  async function run(action: ReviewWorkflowAction, note: string | null) {
    if (pending) return;
    setPending(action);
    setOutcome(null);
    try {
      if (action === "CLAIM") {
        await apiFetch(`/v1/review-operations/evidence/${evidenceId}/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        });
      } else if (action === "BEGIN_REVIEW") {
        // Audit F7: the panel had no way from Claim to a verdict.
        await beginReview(evidenceId, workflowUpdatedAt);
      } else {
        await apiFetch(`/v1/review-operations/evidence/${evidenceId}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The workspace is DERIVED from the record by the server.
          body: JSON.stringify({
            decision: action,
            note,
            ...(action === "ESCALATE" ? { escalationReason: note } : {}),
          }),
        });
      }
      await onChanged?.();
      setReasonFor(null);
      setReason("");
      setOutcome({ tone: "success", text: SUCCESS_COPY[action] });
    } catch (err) {
      // A refusal often means the record moved under us: re-read it so the
      // panel shows the state the message refers to.
      await onChanged?.();
      setOutcome({
        tone: "error",
        text: refusalMessage(err, "The review could not be updated. Try again."),
      });
    } finally {
      setPending(null);
    }
  }

  async function start(action: ReviewWorkflowAction) {
    const a = byAction.get(action);
    if (!a?.enabled || pending) return;
    if (a.requiresNote) {
      setReasonFor(action);
      setReason("");
      setOutcome(null);
      return;
    }
    if (action === "CLOSE" || action === "APPROVE_INTERNAL") {
      const ok = await confirm({
        title: action === "CLOSE" ? "Close this review?" : "Record an internal approval?",
        description: REVIEW_WORKFLOW_ACTION_OUTCOMES[action],
        confirmLabel: REVIEW_WORKFLOW_ACTION_LABELS[action],
      });
      if (!ok) return;
    }
    await run(action, null);
  }

  const reasonValid = reason.trim().length > 0 && reason.trim().length <= NOTE_MAX;

  // WHAT IS OFFERED. A block that applies to every action (no workspace, no
  // review permission) is ONE sentence, not six disabled buttons. An action
  // the current stage does not allow is not offered. An action refused for a
  // reason the reviewer should know (a verdict already recorded, another
  // owner) stays visible, disabled, with that reason beside it.
  const globalBlock =
    actions.length > 0 &&
    actions.every(
      (a) =>
        a.blockedBy === "NO_WORKSPACE" ||
        a.blockedBy === "NO_WORKFLOW" ||
        a.blockedBy === "NOT_INCLUDED" ||
        a.blockedBy === "NOT_PERMITTED",
    )
      ? actions[0]!.blockedBy
      : null;
  const offered = globalBlock
    ? []
    : actions.filter(
        (a) =>
          a.blockedBy !== "NOT_FROM_STAGE" &&
          // Claiming a review you already own is not an action to offer.
          a.blockedBy !== "ALREADY_YOURS",
      );

  return (
    <section className="evd-panel" data-evidence-review-decisions>
      <header className="evd-header">
        <div>
          <div className="evd-kicker">Review actions</div>
          <h3 className="evd-title">Internal review decisions</h3>
          <p className="evd-muted">
            Internal only. Decisions and notes stay in this workspace. They do not change the
            evidence, its integrity, its public verification or its report.
          </p>
        </div>
      </header>

      <div className="evd-actions" data-evidence-review-state>
        <span
          className="app-status-badge"
          data-tone="slate"
          data-evidence-review-stage={currentStatus ?? "NOT_STARTED"}
        >
          {reviewWorkflowStateLabel(currentStatus)}
        </span>
        <span className="evd-muted" data-evidence-review-decision>
          Decision: {decisionLabel ?? "No decision"}
        </span>
        <span className="evd-muted" data-evidence-review-assignee>
          Reviewer: {reviewAssigneeLabel(assignedTo, viewerUserId)}
        </span>
      </div>

      {outcome ? (
        <p
          className={outcome.tone === "error" ? "evd-error" : "evd-muted"}
          role={outcome.tone === "error" ? "alert" : "status"}
          data-evidence-review-outcome={outcome.tone}
        >
          {outcome.text}
        </p>
      ) : null}

      {reasonFor ? (
        <form
          className="evd-reason"
          data-evidence-review-reason={reasonFor}
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonValid) void run(reasonFor, reason.trim());
          }}
        >
          <label htmlFor={reasonId} className="evd-title">
            {REVIEW_WORKFLOW_ACTION_LABELS[reasonFor]}: reason (required, internal only)
          </label>
          <p className="evd-muted">{REVIEW_WORKFLOW_ACTION_OUTCOMES[reasonFor]}</p>
          <textarea
            id={reasonId}
            className="app-form-input"
            rows={3}
            maxLength={NOTE_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${reasonId}-count`}
          />
          <span id={`${reasonId}-count`} className="app-hint">
            {reason.trim().length}/{NOTE_MAX}
          </span>
          <div className="evd-actions">
            <button
              type="submit"
              className="app-primary-action"
              disabled={!reasonValid || pending !== null}
              aria-busy={pending === reasonFor || undefined}
              data-evidence-review-reason-submit
            >
              {pending === reasonFor ? "Saving…" : REVIEW_WORKFLOW_ACTION_LABELS[reasonFor]}
            </button>
            <button
              type="button"
              className="app-secondary-action"
              disabled={pending !== null}
              onClick={() => {
                setReasonFor(null);
                setReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {globalBlock ? (
        <p className="evd-muted" data-evidence-review-blocked={globalBlock}>
          {REVIEW_WORKFLOW_BLOCK_COPY[globalBlock]}
        </p>
      ) : null}

      <div className="evd-actions evd-actions--top">
        {offered.map((a) => (
            <ReasonedActionButton
              key={a.action}
              className={a.action === "CLAIM" || a.action === "BEGIN_REVIEW" ? "app-primary-action" : "app-secondary-action"}
              disabled={!a.enabled || pending !== null}
              busy={pending === a.action}
              disabledReason={!a.enabled && a.blockedBy ? REVIEW_WORKFLOW_BLOCK_COPY[a.blockedBy] : null}
              data-evidence-review-action={a.action}
              data-enabled={a.enabled ? "true" : "false"}
              onClick={() => void start(a.action)}
            >
              {pending === a.action ? "Saving…" : REVIEW_WORKFLOW_ACTION_LABELS[a.action]}
            </ReasonedActionButton>
          ))}
      </div>
    </section>
  );
}
