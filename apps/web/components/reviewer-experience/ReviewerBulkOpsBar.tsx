"use client";

/**
 * Phase 12 Point 4 — reviewer bulk operations.
 *
 * Multi-select bulk triage over the reviewer queue, wired to the
 * existing `POST /v1/reviewer-ops/reviews/bulk` endpoint. The backend
 * returns a 207 partial-success envelope with per-row outcomes; we
 * surface those outcomes so the reviewer sees exactly what succeeded
 * and what failed without re-fetching the queue blind.
 *
 * This capability was previously only reachable from the unmounted
 * `ReviewerCommandConsole`. It now lives on the canonical `/review`
 * Inbox (`ReviewInbox`, stage D), which owns the rows and the
 * selection set; this component owns the action bar, note gating, and
 * outcome reporting.
 *
 * Hard rules (carried over verbatim from the original surface):
 *   - No invented mutation semantics. Every action maps to one of the
 *     bounded `ReviewerOpsBulkAction` values the backend accepts.
 *   - Permission gating happens server-side (REVIEWER_OPS_ACT +
 *     `review.bulk` + adaptive-runtime + step-up gates). The UI never
 *     predicts denial; it surfaces server errors honestly.
 *   - TEAM-SPEC R1 — the bar is live only where the API serves bulk:
 *     the active workspace's plan includes the Team review tools AND the
 *     role holds the bulk capability (OWNER / ADMIN). The workspace KIND
 *     is never asked — a Team-entitled Personal Workspace gets the bar.
 *     Elsewhere it explains itself instead of disappearing.
 *   - Note-required actions (ESCALATE / PAUSE / REQUEST_INFO) do not
 *     submit without a note.
 */

import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../lib/feedback/plan-refusal";
import { AppListbox } from "../app-primitives/AppListbox";
import { useCallback, useState, type ReactNode } from "react";

import { apiFetch } from "../../lib/api";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  isStepUpCancelled,
  stepUpCancelMessage,
  type StepUpAction,
} from "../identity-security/StepUpModal";

/**
 * T-167 (stage B) — the caller's `useStepUpAction().runStepUpAction`. Bulk
 * close, priority, pause, request information and escalate are gated by the
 * bulk checkbox, session risk and the 4 h window; without the runner a
 * STEP_UP_REQUIRED or reauth_required here could not be satisfied.
 * Assignment is not step-up gated (T-036), but goes through the same runner
 * harmlessly (session trust refusals still surface).
 */
export type BulkStepUpRunner = <T>(action: StepUpAction<T>) => Promise<T>;

export type BulkAction =
  | "ASSIGN_TO_ME"
  | "PRIORITY_HIGH"
  | "PRIORITY_NORMAL"
  | "PRIORITY_URGENT"
  | "ESCALATE"
  | "PAUSE"
  | "REQUEST_INFO"
  | "CLOSE";

export type BulkRowOutcome = {
  workflowId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
};

export type BulkResult = {
  total: number;
  succeeded: number;
  failed: number;
  items: ReadonlyArray<BulkRowOutcome>;
};

export function ReviewerBulkOpsBar({
  teamId,
  selection,
  callerUserId,
  enabled,
  onClearSelection,
  onMutated,
  onResult,
  runStepUpAction,
  extraActions,
  rowLabel,
}: {
  /**
   * Stage D (T-065) — the Inbox adds its own bulk controls (assign to a chosen
   * reviewer, coded-value tags) to this one bar instead of a second bar.
   */
  extraActions?: ReactNode;
  /** T-084 — how a failed row is named (an evidence reference), never an id fragment. */
  rowLabel?: (workflowId: string) => string;
  teamId: string | null;
  selection: ReadonlySet<string>;
  /** T-167 — the page's step-up runner (its StepUpModal hosts the dialog). */
  runStepUpAction?: BulkStepUpRunner;
  callerUserId: string | null;
  /** Plan feature + role capability, decided by the caller (never workspace kind). */
  enabled: boolean;
  onClearSelection: () => void;
  onMutated: () => void;
  onResult: (result: BulkResult | null) => void;
}) {
  const [noteAction, setNoteAction] = useState<BulkAction | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { confirm: confirmAction } = useConfirmAction();
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);

  const someSelected = selection.size > 0;
  // TEAM-SPEC R1 — eligibility is the caller's `enabled` (effective plan +
  // role capability). Without it every submit would be refused, so the bar
  // explains itself instead of offering actions.
  const bulkDisabled = !enabled || !teamId;

  const submitBulk = useCallback(
    async (action: BulkAction, note?: string) => {
      if (bulkDisabled || !teamId) {
        setError("Bulk operations require a workspace.");
        return;
      }
      if (selection.size === 0) {
        setError("Select at least one workflow first.");
        return;
      }
      const workflowIds = Array.from(selection);

      // Map UI action → backend action + payload.
      const requiresNote =
        action === "ESCALATE" ||
        action === "PAUSE" ||
        action === "REQUEST_INFO";
      if (requiresNote && (!note || note.trim().length === 0)) {
        setError("A short note is required for that action.");
        return;
      }
      if (action === "ASSIGN_TO_ME" && !callerUserId) {
        setError(
          "Could not identify the caller for assign-to-me. Reload and retry.",
        );
        return;
      }

      const bodyAction = action === "ASSIGN_TO_ME" ? "ASSIGN" : action;
      const body: Record<string, unknown> = {
        teamId,
        workflowIds,
        action: bodyAction,
      };
      if (action === "ASSIGN_TO_ME") {
        body.assignedToUserId = callerUserId;
      }
      if (requiresNote || action === "CLOSE") {
        // CLOSE also accepts a note; if the operator provided one we
        // forward it, otherwise the backend will validate.
        if (note && note.trim().length > 0) body.note = note.trim();
      }

      setSubmitting(true);
      setError(null);
      setLastResult(null);
      onResult(null);
      try {
        const send = (headers?: Record<string, string>) =>
          apiFetch("/v1/reviewer-ops/reviews/bulk", {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(body),
          });
        const resp = (await (runStepUpAction ? runStepUpAction(send) : send())) as {
          total?: number;
          succeeded?: number;
          failed?: number;
          items?: ReadonlyArray<BulkRowOutcome>;
        };
        const result: BulkResult = {
          total: resp.total ?? workflowIds.length,
          succeeded: resp.succeeded ?? 0,
          failed: resp.failed ?? 0,
          items: resp.items ?? [],
        };
        setLastResult(result);
        onResult(result);
        // Refresh the queue so it reflects the post-mutation state. The
        // selection is deliberately preserved so the operator can see
        // which rows just changed; rows the bulk action closed fall out
        // of the queue naturally on reload.
        onMutated();
        setNoteAction(null);
        setNoteText("");
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (isStepUpCancelled(err)) {
          setError(stepUpCancelMessage(err, "Nothing was changed: identity confirmation was cancelled."));
        } else if (e.statusCode === 400) {
          setError(
            toSafeUserError(e, {
              message: "Bulk request was rejected. Check the action + note.",
            }).message,
          );
        } else if (isPlanRefusal(e)) {
          // PRO-R2-14 — the plan, not a permission.
          setError(PLAN_REFUSAL_COPY);
        } else if (e.statusCode === 403) {
          setError(
            "Permission denied. Bulk mutation requires REVIEWER_OPS_ACT in this team.",
          );
        } else if (e.statusCode === 429) {
          setError("Rate-limited. Slow down and retry shortly.");
        } else {
          setError(
            toSafeUserError(e, { message: "Bulk submit failed." }).message,
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [bulkDisabled, callerUserId, onMutated, onResult, runStepUpAction, selection, teamId],
  );

  // TEAM-UI-SPEC §1/§4 — every bar control is secondary (the confirm dialog
  // owns the one primary); the container is an inner surface, no inline palette.
  if (bulkDisabled) {
    return (
      <p
        className="app-field-help"
        data-reviewer-bulk-unavailable-banner
        data-reviewer-bulk-disabled="true"
      >
        Bulk review actions are available to workspace owners and admins on
        the Team plan. Open each review individually from the list below.
      </p>
    );
  }

  if (!someSelected && !noteAction) {
    return (
      <p
        className="app-field-help"
        data-reviewer-bulk-hint
        data-reviewer-bulk-disabled="false"
        data-reviewer-bulk-selection-count={0}
      >
        Select workflows to bulk-act.
      </p>
    );
  }

  return (
    <div
      className="app-inner-surface"
      data-reviewer-bulk-actions-bar
      data-reviewer-bulk-disabled="false"
      data-reviewer-bulk-selected-count={selection.size}
      data-reviewer-bulk-selection-count={selection.size}
    >
      <div className="review-toolbar">
        <strong className="review-toolbar__label">
          {selection.size} selected
        </strong>
        <button
          type="button"
          className="app-secondary-action"
          disabled={submitting || selection.size === 0 || !callerUserId}
          onClick={() => void submitBulk("ASSIGN_TO_ME")}
          data-reviewer-bulk-action="ASSIGN_TO_ME"
          title={
            callerUserId
              ? "Assign every selected workflow to your account."
              : "Caller identity not yet resolved; refresh and retry."
          }
        >
          Assign to me
        </button>
        {extraActions}
        <button
          type="button"
          className="app-secondary-action"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_HIGH")}
          data-reviewer-bulk-action="PRIORITY_HIGH"
        >
          Mark high
        </button>
        <button
          type="button"
          className="app-secondary-action"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_NORMAL")}
          data-reviewer-bulk-action="PRIORITY_NORMAL"
        >
          Mark normal
        </button>
        <button
          type="button"
          className="app-secondary-action"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_URGENT")}
          data-reviewer-bulk-action="PRIORITY_URGENT"
        >
          Mark urgent
        </button>
        <AppListbox
          value={noteAction ?? ""}
          options={[
            { value: "", label: "— with note —" },
            { value: "ESCALATE", label: "Escalate" },
            { value: "PAUSE", label: "Pause" },
            { value: "REQUEST_INFO", label: "Request info" },
            { value: "CLOSE", label: "Close" },
          ]}
          onChange={(next) => {
            const v = next as BulkAction | "";
            setNoteAction(v === "" ? null : v);
          }}
          disabled={submitting}
          ariaLabel={"Bulk action requiring a note"}
          triggerProps={{ "data-reviewer-bulk-note-action": "" }}
        />
        {noteAction ? (
          <>
            <input
              type="text"
              className="app-input"
              aria-label="Note for the bulk action"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Short note (required for escalate, pause and request info)"
              data-reviewer-bulk-note-input
              disabled={submitting}
              maxLength={1000}
            />
            <button
              type="button"
              className="app-secondary-action"
              disabled={
                submitting ||
                selection.size === 0 ||
                ((noteAction === "ESCALATE" ||
                  noteAction === "PAUSE" ||
                  noteAction === "REQUEST_INFO") &&
                  noteText.trim().length === 0)
              }
              onClick={() => {
                // PRO-R2-11 — a bulk move of every selected review asks first.
                void confirmAction({
                  title: `Apply ${NOTE_ACTION_LABEL[noteAction]} to ${selection.size} reviews?`,
                  description: "The action is applied to every selected review.",
                  confirmLabel: `Apply ${NOTE_ACTION_LABEL[noteAction]}`,
                  tone: noteAction === "CLOSE" ? "danger" : "warning",
                }).then((ok) => {
                  if (ok) void submitBulk(noteAction, noteText);
                });
              }}
              data-reviewer-bulk-action="WITH_NOTE_APPLY"
              data-reviewer-bulk-note-action-target={noteAction}
            >
              Apply {NOTE_ACTION_LABEL[noteAction]}
            </button>
          </>
        ) : null}
        <span className="review-toolbar__spacer" />
        <button
          type="button"
          className="app-ghost-action"
          onClick={() => {
            onClearSelection();
            setLastResult(null);
            onResult(null);
          }}
          disabled={submitting || selection.size === 0}
          data-reviewer-bulk-action="CLEAR_SELECTION"
        >
          Clear
        </button>
      </div>
      {error ? (
        <p role="alert" className="app-field-error review-toolbar" data-reviewer-bulk-error>
          {error}
        </p>
      ) : null}
      {lastResult ? (
        <div
          className="app-field-help review-toolbar"
          data-reviewer-bulk-last-result
          data-reviewer-bulk-last-total={lastResult.total}
          data-reviewer-bulk-last-succeeded={lastResult.succeeded}
          data-reviewer-bulk-last-failed={lastResult.failed}
        >
          Last bulk result: {lastResult.succeeded}/{lastResult.total} succeeded
          {lastResult.failed > 0 ? `, ${lastResult.failed} failed` : ""}.
          {lastResult.failed > 0 && lastResult.items.length > 0 ? (
            <ul data-reviewer-bulk-last-failures>
              {lastResult.items
                .filter((i) => !i.ok)
                .map((i) => (
                  <li
                    key={i.workflowId}
                    data-reviewer-bulk-failed-workflow={i.workflowId}
                    data-reviewer-bulk-failed-error-code={i.errorCode ?? ""}
                  >
                    {rowLabel ? rowLabel(i.workflowId) : "A review"}: {i.message ?? "not applied"}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const NOTE_ACTION_LABEL: Record<BulkAction, string> = {
  ASSIGN_TO_ME: "assign to me",
  PRIORITY_HIGH: "high priority",
  PRIORITY_NORMAL: "normal priority",
  PRIORITY_URGENT: "urgent priority",
  ESCALATE: "escalate",
  PAUSE: "pause",
  REQUEST_INFO: "request info",
  CLOSE: "close",
};
