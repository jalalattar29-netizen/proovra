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
 * console (`ReviewerConsole`), which owns the queue rows and the
 * selection set; this component owns the action bar, note gating, and
 * outcome reporting.
 *
 * Hard rules (carried over verbatim from the original surface):
 *   - No invented mutation semantics. Every action maps to one of the
 *     bounded `ReviewerOpsBulkAction` values the backend accepts.
 *   - Permission gating happens server-side (REVIEWER_OPS_ACT +
 *     `review.bulk` + adaptive-runtime + step-up gates). The UI never
 *     predicts denial; it surfaces server errors honestly.
 *   - The bar is disabled outside a team workspace — bulk reassignment
 *     is a team-only operation and the backend rejects it there.
 *   - Note-required actions (ESCALATE / PAUSE / REQUEST_INFO) do not
 *     submit without a note.
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

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
  isTeam,
  onClearSelection,
  onMutated,
  onResult,
}: {
  teamId: string | null;
  selection: ReadonlySet<string>;
  callerUserId: string | null;
  isTeam: boolean;
  onClearSelection: () => void;
  onMutated: () => void;
  onResult: (result: BulkResult | null) => void;
}) {
  const [noteAction, setNoteAction] = useState<BulkAction | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);

  const someSelected = selection.size > 0;
  // Personal-space envelopes carry a Team-shaped workspace id but are
  // not team-mutation-capable (reviewer mutations require team scope
  // server-side). Disable the bulk bar on personal so we don't ship
  // requests that will always 403.
  const bulkDisabled = !isTeam || !teamId;

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
        const resp = (await apiFetch("/v1/reviewer-ops/reviews/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })) as {
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
        if (e.statusCode === 400) {
          setError(
            toSafeUserError(e, {
              message: "Bulk request was rejected. Check the action + note.",
            }).message,
          );
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
    [bulkDisabled, callerUserId, onMutated, onResult, selection, teamId],
  );

  if (bulkDisabled) {
    return (
      <div
        data-reviewer-bulk-personal-banner
        data-reviewer-bulk-disabled="true"
        style={{ fontSize: 12, opacity: 0.8, margin: "0.4rem 0" }}
      >
        Bulk reviewer operations require a workspace. In personal space,
        open each workflow individually from the queue below.
      </div>
    );
  }

  if (!someSelected && !noteAction) {
    return (
      <div
        data-reviewer-bulk-hint
        data-reviewer-bulk-disabled="false"
        data-reviewer-bulk-selection-count={0}
        style={{ fontSize: 12, opacity: 0.7, margin: "0.4rem 0" }}
      >
        Select workflows to bulk-act.
      </div>
    );
  }

  return (
    <div
      data-reviewer-bulk-actions-bar
      data-reviewer-bulk-disabled="false"
      data-reviewer-bulk-selected-count={selection.size}
      data-reviewer-bulk-selection-count={selection.size}
      style={bulkBarStyle}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 12 }}>Bulk actions:</strong>
        <button
          type="button"
          disabled={submitting || selection.size === 0 || !callerUserId}
          onClick={() => void submitBulk("ASSIGN_TO_ME")}
          data-reviewer-bulk-action="ASSIGN_TO_ME"
          style={bulkBtnStyle}
          title={
            callerUserId
              ? "Assign every selected workflow to your account."
              : "Caller identity not yet resolved; refresh and retry."
          }
        >
          Assign to me
        </button>
        <button
          type="button"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_HIGH")}
          data-reviewer-bulk-action="PRIORITY_HIGH"
          style={bulkBtnStyle}
        >
          Mark HIGH
        </button>
        <button
          type="button"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_NORMAL")}
          data-reviewer-bulk-action="PRIORITY_NORMAL"
          style={bulkBtnStyle}
        >
          Mark NORMAL
        </button>
        <button
          type="button"
          disabled={submitting || selection.size === 0}
          onClick={() => void submitBulk("PRIORITY_URGENT")}
          data-reviewer-bulk-action="PRIORITY_URGENT"
          style={bulkBtnStyle}
        >
          Mark URGENT
        </button>
        <span
          aria-hidden="true"
          style={{
            width: 1,
            height: 22,
            background: "rgba(127,127,127,0.3)",
            margin: "0 4px",
          }}
        />
        <select
          data-reviewer-bulk-note-action
          value={noteAction ?? ""}
          onChange={(e) => {
            const v = e.target.value as BulkAction | "";
            setNoteAction(v === "" ? null : v);
          }}
          disabled={submitting}
          style={{ fontSize: 12 }}
          aria-label="Bulk action requiring a note"
        >
          <option value="">— with note —</option>
          <option value="ESCALATE">Escalate</option>
          <option value="PAUSE">Pause</option>
          <option value="REQUEST_INFO">Request info</option>
          <option value="CLOSE">Close</option>
        </select>
        {noteAction ? (
          <>
            <input
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Short note (required for escalate/pause/request-info)"
              data-reviewer-bulk-note-input
              disabled={submitting}
              maxLength={1000}
              style={{
                fontSize: 12,
                flex: "1 1 220px",
                padding: "0.25rem 0.4rem",
              }}
            />
            <button
              type="button"
              disabled={
                submitting ||
                selection.size === 0 ||
                ((noteAction === "ESCALATE" ||
                  noteAction === "PAUSE" ||
                  noteAction === "REQUEST_INFO") &&
                  noteText.trim().length === 0)
              }
              onClick={() => void submitBulk(noteAction, noteText)}
              data-reviewer-bulk-action="WITH_NOTE_APPLY"
              data-reviewer-bulk-note-action-target={noteAction}
              style={bulkBtnPrimaryStyle}
            >
              Apply {noteAction}
            </button>
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            onClearSelection();
            setLastResult(null);
            onResult(null);
          }}
          disabled={submitting || selection.size === 0}
          data-reviewer-bulk-action="CLEAR_SELECTION"
          style={bulkBtnStyle}
        >
          Clear
        </button>
      </div>
      {error ? (
        <div
          role="alert"
          data-reviewer-bulk-error
          style={{ marginTop: 6, fontSize: 12, color: "#d44" }}
        >
          {error}
        </div>
      ) : null}
      {lastResult ? (
        <div
          data-reviewer-bulk-last-result
          data-reviewer-bulk-last-total={lastResult.total}
          data-reviewer-bulk-last-succeeded={lastResult.succeeded}
          data-reviewer-bulk-last-failed={lastResult.failed}
          style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}
        >
          Last bulk result: {lastResult.succeeded}/{lastResult.total} succeeded
          {lastResult.failed > 0 ? `, ${lastResult.failed} failed` : ""}.
          {lastResult.failed > 0 && lastResult.items.length > 0 ? (
            <ul
              data-reviewer-bulk-last-failures
              style={{ margin: "4px 0 0", paddingLeft: "1.2rem", fontSize: 12 }}
            >
              {lastResult.items
                .filter((i) => !i.ok)
                .map((i) => (
                  <li
                    key={i.workflowId}
                    data-reviewer-bulk-failed-workflow={i.workflowId}
                    data-reviewer-bulk-failed-error-code={i.errorCode ?? ""}
                  >
                    {i.workflowId.slice(0, 8)}…: {i.errorCode ?? "error"}{" "}
                    {i.message ? `— ${i.message}` : ""}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const bulkBarStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  border: "1px solid rgba(99,102,241,0.4)",
  borderRadius: 6,
  background: "rgba(99,102,241,0.06)",
  margin: "0.5rem 0",
};

const bulkBtnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "0.25rem 0.55rem",
  border: "1px solid currentColor",
  borderRadius: 4,
  background: "transparent",
  cursor: "pointer",
};

const bulkBtnPrimaryStyle: React.CSSProperties = {
  ...bulkBtnStyle,
  background: "rgba(99,102,241,0.18)",
  fontWeight: 600,
};
