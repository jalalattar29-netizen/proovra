"use client";

/**
 * Phase 13.5 — Compact enterprise review actions panel.
 *
 * Surfaces the Phase 13 decision endpoints next to the existing
 * Reviewer Workflow card. Internal-only — review notes never leave
 * the workspace. The API also enforces stage transitions, so if the
 * UI offers an invalid action the server will reject it.
 *
 * Wording is operational: "internal review approved", "rejected as
 * insufficient", "needs more information". No claims of authenticity,
 * admissibility, or proven truth.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useState } from "react";

import { apiFetch } from "../../../../../lib/api";

type Stage =
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_MORE_INFO"
  | "RESPONSE_RECEIVED"
  | "APPROVED_INTERNAL"
  | "REJECTED_INSUFFICIENT"
  | "ESCALATED"
  | "REOPENED"
  | "CLOSED";

type Decision =
  | "APPROVE_INTERNAL"
  | "REQUEST_MORE_INFO"
  | "REJECT_INSUFFICIENT"
  | "ESCALATE"
  | "REOPEN"
  | "CLOSE";

const ALLOWED_TRANSITIONS: Record<Stage, ReadonlyArray<Stage>> = {
  QUEUED: ["ASSIGNED", "IN_REVIEW", "ESCALATED", "CLOSED"],
  ASSIGNED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED", "QUEUED", "CLOSED"],
  IN_REVIEW: [
    "NEEDS_MORE_INFO",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "ESCALATED",
    "ASSIGNED",
    "CLOSED",
  ],
  NEEDS_MORE_INFO: [
    "RESPONSE_RECEIVED",
    "IN_REVIEW",
    "ESCALATED",
    "REJECTED_INSUFFICIENT",
    "CLOSED",
  ],
  RESPONSE_RECEIVED: [
    "IN_REVIEW",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "NEEDS_MORE_INFO",
    "ESCALATED",
    "CLOSED",
  ],
  APPROVED_INTERNAL: ["REOPENED", "CLOSED"],
  REJECTED_INSUFFICIENT: ["REOPENED", "CLOSED"],
  ESCALATED: [
    "IN_REVIEW",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "NEEDS_MORE_INFO",
    "CLOSED",
  ],
  REOPENED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED"],
  CLOSED: ["REOPENED"],
};

const DECISION_TARGET: Record<Decision, Stage> = {
  APPROVE_INTERNAL: "APPROVED_INTERNAL",
  REQUEST_MORE_INFO: "NEEDS_MORE_INFO",
  REJECT_INSUFFICIENT: "REJECTED_INSUFFICIENT",
  ESCALATE: "ESCALATED",
  REOPEN: "REOPENED",
  CLOSE: "CLOSED",
};

const DECISION_REQUIRES_NOTE: ReadonlySet<Decision> = new Set([
  "REJECT_INSUFFICIENT",
  "ESCALATE",
  "REOPEN",
]);

const DECISION_LABEL: Record<Decision, string> = {
  APPROVE_INTERNAL: "Approve (internal review)",
  REQUEST_MORE_INFO: "Request more information",
  REJECT_INSUFFICIENT: "Reject as insufficient",
  ESCALATE: "Escalate",
  REOPEN: "Reopen",
  CLOSE: "Close",
};

function mapStatusToStage(status: string | null | undefined): Stage {
  if (!status) return "QUEUED";
  if (status === "NOT_STARTED") return "QUEUED";
  if (status === "NEEDS_INFO") return "NEEDS_MORE_INFO";
  if (status === "READY_FOR_EXTERNAL_REVIEW") return "APPROVED_INTERNAL";
  return status as Stage;
}

export function EvidenceReviewActionsPanel({
  evidenceId,
  teamId,
  currentStatus,
  assignedToUserId,
  currentUserId,
  onChanged,
}: {
  evidenceId: string;
  teamId: string | null;
  currentStatus: string | null;
  assignedToUserId: string | null;
  currentUserId: string | null;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = mapStatusToStage(currentStatus);
  const allowed = ALLOWED_TRANSITIONS[stage] ?? [];

  const canClaim = !!(teamId && !assignedToUserId && stage !== "CLOSED");
  const isMine = !!(
    currentUserId &&
    assignedToUserId &&
    assignedToUserId === currentUserId
  );

  async function claim() {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `/v1/review-operations/evidence/${evidenceId}/claim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      onChanged?.();
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Could not claim." }).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: Decision) {
    if (!teamId) return;
    const target = DECISION_TARGET[decision];
    if (!allowed.includes(target)) {
      // UI guard — server still validates.
      setError(`Cannot ${DECISION_LABEL[decision].toLowerCase()} from ${stage}.`);
      return;
    }
    let note: string | null = null;
    if (DECISION_REQUIRES_NOTE.has(decision)) {
      const label =
        decision === "ESCALATE"
          ? "Escalation reason"
          : decision === "REJECT_INSUFFICIENT"
            ? "Reason for rejection"
            : "Reason for reopening";
      const input = window.prompt(`${label} (required, internal only)`);
      if (!input || input.trim().length === 0) return;
      note = input.trim();
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `/v1/review-operations/evidence/${evidenceId}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // PHASE 12 POINT 4 PASS C5 — the workspace subject is DERIVED from
          // the record by the server; the browser does not name the tenant.
          body: JSON.stringify({
            decision,
            note,
            ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
          }),
        },
      );
      onChanged?.();
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Decision failed." }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="evd-panel">
      <header className="evd-header">
        <div>
          <div className="evd-kicker">Review actions</div>
          <h3 className="evd-title">Internal review decisions</h3>
          <p className="evd-muted">
            Internal-only actions. Decisions and notes stay in the
            workspace and are never shared with public verify, external
            contributors, or the report.
          </p>
        </div>
      </header>

      {error ? <div className="evd-error">{error}</div> : null}

      <div className="evd-actions">
        <span className="app-status-badge" data-tone={stageTone(stage)}>
          {stage}
        </span>
        {assignedToUserId ? (
          <span className="evd-muted">
            assigned to {isMine ? "you" : `${assignedToUserId.slice(0, 8)}…`}
          </span>
        ) : (
          <span className="evd-muted">unassigned</span>
        )}
      </div>

      <div className="evd-actions evd-actions--top">
        {canClaim ? (
          <button
            type="button"
            className="app-primary-action"
            disabled={busy}
            onClick={claim}
          >
            Claim review
          </button>
        ) : null}
        {(
          [
            "APPROVE_INTERNAL",
            "REQUEST_MORE_INFO",
            "REJECT_INSUFFICIENT",
            "ESCALATE",
            "REOPEN",
            "CLOSE",
          ] as Decision[]
        ).map((d) => {
          const target = DECISION_TARGET[d];
          const enabled = allowed.includes(target);
          return (
            <button
              key={d}
              type="button"
              className="app-secondary-action"
              disabled={busy || !enabled}
              onClick={() => decide(d)}
              title={enabled ? "" : `Not available from ${stage}`}
            >
              {DECISION_LABEL[d]}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Styles — kept inline + minimal to match the existing evidence-detail
// pattern. No new design tokens introduced.
// -----------------------------------------------------------------------------


/**
 * Reviewer stage -> canonical badge tone. The previous helper built a raw
 * palette per stage (a green ground, border and ink); the canonical
 * app-status-badge already owns that vocabulary, so this only names the tone.
 * The stage groupings are unchanged.
 */
function stageTone(stage: string): "green" | "red" | "amber" | "blue" | "slate" {
  if (stage === "APPROVED_INTERNAL") return "green";
  if (
    stage === "REJECTED_INSUFFICIENT" ||
    stage === "ESCALATED" ||
    stage === "NEEDS_MORE_INFO"
  ) {
    return "red";
  }
  if (stage === "IN_REVIEW" || stage === "READY_FOR_EXTERNAL_REVIEW") return "blue";
  if (stage === "NOT_STARTED") return "slate";
  return "amber";
}
