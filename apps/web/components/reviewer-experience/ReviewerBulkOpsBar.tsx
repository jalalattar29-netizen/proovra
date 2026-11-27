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
import { useCallback, useRef, useState, type ReactNode } from "react";

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

/**
 * F-34 (Review remediation 2026-11-27, BEHAVIOUR-SPEC §8) — what the last bulk
 * call did, as the bar reports it: the action's name, the per-item result,
 * and how to re-send ONLY the failed ids with the same action and note.
 */
export type BulkReport = {
  label: string;
  result: BulkResult;
  /** Re-sends only the failed ids; null when nothing failed. */
  retry: (() => Promise<void> | void) | null;
};

type RawBulkItem = {
  workflowId?: unknown;
  ok?: unknown;
  errorCode?: unknown;
  code?: unknown;
  denial?: unknown;
  message?: unknown;
};

/**
 * One reading of every bulk envelope the Review doors answer:
 * `{total, succeeded, failed, items[{workflowId, ok, errorCode, message}]}`
 * (reviewer-ops bulk, 200 or 207; reviewer bulk decide/code since F-37) and
 * the older `{total, succeeded, outcomes[{workflowId, ok, denial, code}]}`
 * (reviewer bulk assign). Counts are derived from the items when the body
 * omits them, so a partial batch can never read as a full success.
 */
export function normalizeBulkResponse(
  resp: unknown,
  sentIds: ReadonlyArray<string>,
  reasonLabel?: (code: string | undefined) => string | undefined,
): BulkResult {
  const r = (resp ?? {}) as {
    total?: unknown;
    succeeded?: unknown;
    failed?: unknown;
    items?: unknown;
    outcomes?: unknown;
  };
  const rawItems = (Array.isArray(r.items) ? r.items : Array.isArray(r.outcomes) ? r.outcomes : []) as RawBulkItem[];
  const items: BulkRowOutcome[] = rawItems
    .filter((i) => i && typeof i.workflowId === "string")
    .map((i) => {
      const ok = i.ok === true;
      const code =
        typeof i.errorCode === "string"
          ? i.errorCode
          : typeof i.code === "string"
            ? i.code
            : typeof i.denial === "string"
              ? i.denial
              : undefined;
      const message = typeof i.message === "string" && i.message.length > 0 ? i.message : reasonLabel?.(code);
      return ok
        ? { workflowId: i.workflowId as string, ok: true }
        : { workflowId: i.workflowId as string, ok: false, ...(code ? { errorCode: code } : {}), ...(message ? { message } : {}) };
    });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const total = num(r.total) ?? (items.length > 0 ? items.length : sentIds.length);
  const succeeded = num(r.succeeded) ?? items.filter((i) => i.ok).length;
  const failed = num(r.failed) ?? Math.max(0, total - succeeded);
  return { total, succeeded, failed, items };
}

/** The ids of a result that were not changed (only those that were sent). */
export function failedIdsOf(result: BulkResult, sentIds: ReadonlyArray<string>): string[] {
  const failed = new Set(result.items.filter((i) => !i.ok).map((i) => i.workflowId));
  // A body that counted failures but listed no items: every sent id that was
  // not reported ok stays failed (never silently dropped from the selection).
  if (failed.size === 0 && result.failed > 0) {
    const ok = new Set(result.items.filter((i) => i.ok).map((i) => i.workflowId));
    return sentIds.filter((id) => !ok.has(id));
  }
  return sentIds.filter((id) => failed.has(id));
}

/**
 * The selection after a bulk call: succeeded ids leave it, failed ids stay
 * selected, ids that were not part of the call are untouched.
 */
export function selectionAfterBulk(
  selection: ReadonlySet<string>,
  sentIds: ReadonlyArray<string>,
  result: BulkResult,
): Set<string> {
  const failed = new Set(failedIdsOf(result, sentIds));
  const next = new Set<string>();
  const sent = new Set(sentIds);
  selection.forEach((id) => {
    if (!sent.has(id) || failed.has(id)) next.add(id);
  });
  return next;
}

/** A whole-request refusal as a person reads it (nothing was changed). */
export function bulkRequestErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { statusCode?: number; code?: string };
  if (isStepUpCancelled(err)) {
    return stepUpCancelMessage(err, "Nothing was changed: identity confirmation was cancelled.");
  }
  if (isPlanRefusal(e)) return `Nothing was changed: ${PLAN_REFUSAL_COPY}`;
  switch (e.code) {
    case "REVIEW_NOTE_REQUIRED":
      return "Nothing was changed: this action needs a short note. Add a note and apply it again.";
    case "validation_error":
      return "Nothing was changed: the request was not valid. Check the action and the note, then try again.";
    case "REVIEW_PERMISSION_DENIED":
    case "NOT_PERMITTED":
    case "FORBIDDEN":
      return "Nothing was changed: your role cannot do this bulk action in this workspace.";
    default:
      break;
  }
  if (e.statusCode === 403) {
    return "Nothing was changed: your role cannot do this bulk action in this workspace.";
  }
  if (e.statusCode === 429) return "Nothing was changed: too many requests. Wait a moment and try again.";
  return toSafeUserError(e, { message: "Nothing was changed: the bulk action could not be completed." }).message;
}

/**
 * F-34 — the bulk outcome. Counts in a polite live region; the failed rows by
 * name (evidence reference) with the server's reason; "Retry failed" re-sends
 * only those. An all-failed batch is an alert that says nothing was changed,
 * never a success line.
 */
export function BulkResultReport({
  report,
  rowLabel,
  busy,
}: {
  report: BulkReport | null;
  rowLabel?: (workflowId: string) => string;
  busy?: boolean;
}) {
  const result = report?.result ?? null;
  const failures = result ? result.items.filter((i) => !i.ok) : [];
  const allFailed = result !== null && result.total > 0 && result.succeeded === 0;
  const reasonSummary = Array.from(
    new Set(failures.map((f) => (f.message ?? "not changed").replace(/[.\s]+$/, ""))),
  ).join("; ");
  const summary =
    result === null || allFailed
      ? ""
      : `${report!.label}: ${result.succeeded} updated${result.failed > 0 ? ` · ${result.failed} not changed` : ""}`;
  return (
    <div className="review-bulk-report" data-reviewer-bulk-report={result ? (allFailed ? "failed" : result.failed > 0 ? "partial" : "ok") : "none"}>
      <p role="status" aria-live="polite" className="review-bulk-report__status" data-reviewer-bulk-status>
        {summary}
      </p>
      {allFailed ? (
        <p role="alert" className="app-alert app-alert--danger" data-reviewer-bulk-all-failed>
          Nothing was changed: {reasonSummary || "no review could be updated"}.
        </p>
      ) : null}
      {result && failures.length > 0 ? (
        <ul
          className="review-bulk-report__failures"
          data-reviewer-bulk-last-failures
          data-reviewer-bulk-last-total={result.total}
          data-reviewer-bulk-last-succeeded={result.succeeded}
          data-reviewer-bulk-last-failed={result.failed}
        >
          {failures.map((i) => (
            <li
              key={i.workflowId}
              data-reviewer-bulk-failed-workflow={i.workflowId}
              data-reviewer-bulk-failed-error-code={i.errorCode ?? ""}
            >
              {rowLabel ? rowLabel(i.workflowId) : "A review"}: {i.message ?? "not changed"}
            </li>
          ))}
        </ul>
      ) : null}
      {report?.retry && result && result.failed > 0 ? (
        <button
          type="button"
          className="app-secondary-action"
          data-reviewer-bulk-retry-failed
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void report.retry?.()}
        >
          Retry failed ({result.failed})
        </button>
      ) : null}
    </div>
  );
}

export function ReviewerBulkOpsBar({
  teamId,
  selection,
  callerUserId,
  enabled,
  onClearSelection,
  onSelectionChange,
  onMutated,
  onResult,
  runStepUpAction,
  extraActions,
  rowLabel,
  hasRows = true,
  report: controlledReport,
  onReport,
  busy: externalBusy = false,
}: {
  /**
   * F-34 — set the selection after a bulk call (failed ids stay selected,
   * succeeded ids leave it). Without it the bar clears the selection only
   * when every item succeeded.
   */
  onSelectionChange?: (next: ReadonlySet<string>) => void;
  /** F-30 — the "Select … to bulk-act" hint shows only when rows exist. */
  hasRows?: boolean;
  /**
   * F-34 — the report shown in the bar's live region. When given, the caller
   * owns it (the Inbox's own tag / assign calls report here too); the bar
   * publishes its own results through `onReport`.
   */
  report?: BulkReport | null;
  onReport?: (report: BulkReport | null) => void;
  /** A caller-run bulk call (tag / assign) is in flight. */
  busy?: boolean;
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
  const [ownReport, setOwnReport] = useState<BulkReport | null>(null);
  const report = controlledReport !== undefined ? controlledReport : ownReport;
  const publishReport = useCallback(
    (next: BulkReport | null) => {
      setOwnReport(next);
      onReport?.(next);
    },
    [onReport],
  );

  // The CURRENT selection, read when a (retried) call settles, so a retry
  // never re-selects rows an earlier round already updated.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const someSelected = selection.size > 0;
  // TEAM-SPEC R1 — eligibility is the caller's `enabled` (effective plan +
  // role capability). Without it every submit would be refused, so the bar
  // explains itself instead of offering actions.
  const bulkDisabled = !enabled || !teamId;
  const busy = submitting || externalBusy;

  const submitBulk = useCallback(
    async (action: BulkAction, note?: string, onlyIds?: ReadonlyArray<string>) => {
      if (bulkDisabled || !teamId) {
        setError("Bulk operations require a workspace.");
        return;
      }
      const workflowIds = onlyIds ? Array.from(onlyIds) : Array.from(selection);
      if (workflowIds.length === 0) {
        setError("Select at least one review first.");
        return;
      }

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
      publishReport(null);
      onResult(null);
      try {
        const send = (headers?: Record<string, string>) =>
          apiFetch("/v1/reviewer-ops/reviews/bulk", {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(body),
          });
        // 200 (all applied) and 207 (partial / none) carry the same body.
        const resp = await (runStepUpAction ? runStepUpAction(send) : send());
        const result = normalizeBulkResponse(resp, workflowIds);
        const failedIds = failedIdsOf(result, workflowIds);
        publishReport({
          label: ACTION_REPORT_LABEL[action],
          result,
          // Retry re-sends ONLY the failed ids, with the same action and note.
          retry: failedIds.length > 0 ? () => submitBulk(action, note, failedIds) : null,
        });
        onResult(result);
        // F-34 — succeeded rows leave the selection, failed rows stay
        // selected so Retry (or another action) applies to exactly them.
        if (onSelectionChange) onSelectionChange(selectionAfterBulk(selectionRef.current, workflowIds, result));
        else if (failedIds.length === 0) onClearSelection();
        onMutated();
        if (failedIds.length === 0) {
          setNoteAction(null);
          setNoteText("");
        }
      } catch (err) {
        // PRO-R2-14 — the plan, not a permission; every refusal says that
        // nothing was changed and why (note required, invalid, role).
        setError(bulkRequestErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [bulkDisabled, callerUserId, onClearSelection, onMutated, onResult, onSelectionChange, publishReport, runStepUpAction, selection, teamId],
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

  const reportView = <BulkResultReport report={report} rowLabel={rowLabel} busy={busy} />;

  if (!someSelected && !noteAction) {
    // F-30 — the hint only where there is something to select; F-34 — the
    // last outcome stays readable after every row left the selection.
    return (
      <div className="review-bulk-idle" data-reviewer-bulk-idle>
        {hasRows ? (
          <p
            className="app-field-help"
            data-reviewer-bulk-hint
            data-reviewer-bulk-disabled="false"
            data-reviewer-bulk-selection-count={0}
          >
            Select workflows to bulk-act.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="app-field-error" data-reviewer-bulk-error>
            {error}
          </p>
        ) : null}
        {reportView}
      </div>
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
          disabled={busy || selection.size === 0 || !callerUserId}
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
          disabled={busy || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_HIGH")}
          data-reviewer-bulk-action="PRIORITY_HIGH"
        >
          Mark high
        </button>
        <button
          type="button"
          className="app-secondary-action"
          disabled={busy || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_NORMAL")}
          data-reviewer-bulk-action="PRIORITY_NORMAL"
        >
          Mark normal
        </button>
        <button
          type="button"
          className="app-secondary-action"
          disabled={busy || selection.size === 0}
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
                busy ||
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
            publishReport(null);
            onResult(null);
          }}
          disabled={busy || selection.size === 0}
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
      {reportView}
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

/** How a bar action names itself in the outcome line ("Mark high: 3 updated"). */
const ACTION_REPORT_LABEL: Record<BulkAction, string> = {
  ASSIGN_TO_ME: "Assign to me",
  PRIORITY_HIGH: "Mark high",
  PRIORITY_NORMAL: "Mark normal",
  PRIORITY_URGENT: "Mark urgent",
  ESCALATE: "Escalate",
  PAUSE: "Pause",
  REQUEST_INFO: "Request info",
  CLOSE: "Close",
};
