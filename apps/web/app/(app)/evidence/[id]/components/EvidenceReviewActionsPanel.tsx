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
      setError(e?.message ?? "Could not claim.");
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
          body: JSON.stringify({
            teamId,
            decision,
            note,
            ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
          }),
        },
      );
      onChanged?.();
    } catch (err) {
      const e = err as { message?: string };
      setError(e?.message ?? "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={panelStyle}>
      <header style={headerStyle}>
        <div>
          <div style={kickerStyle}>Review actions</div>
          <h3 style={titleStyle}>Internal review decisions</h3>
          <p style={mutedStyle}>
            Internal-only actions. Decisions and notes stay in the
            workspace and are never shared with public verify, external
            contributors, or the report.
          </p>
        </div>
      </header>

      {error ? <div style={errorStyle}>{error}</div> : null}

      <div style={metaRowStyle}>
        <span style={badgeStyle(stage)}>{stage}</span>
        {assignedToUserId ? (
          <span style={mutedStyle}>
            assigned to {isMine ? "you" : `${assignedToUserId.slice(0, 8)}…`}
          </span>
        ) : (
          <span style={mutedStyle}>unassigned</span>
        )}
      </div>

      <div style={actionRowStyle}>
        {canClaim ? (
          <button
            type="button"
            style={primaryButtonStyle}
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
              style={enabled ? secondaryButtonStyle : disabledButtonStyle}
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

const panelStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const headerStyle: React.CSSProperties = {
  marginBottom: 12,
};
const kickerStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#94a3b8",
  fontWeight: 600,
};
const titleStyle: React.CSSProperties = {
  margin: "4px 0 4px 0",
  fontSize: 16,
  fontWeight: 600,
  color: "#0f172a",
};
const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };
const errorStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 8,
};
const metaRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const disabledButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  opacity: 0.45,
  cursor: "not-allowed",
};

function badgeStyle(stage: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (stage === "APPROVED_INTERNAL") {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  if (
    stage === "REJECTED_INSUFFICIENT" ||
    stage === "ESCALATED" ||
    stage === "NEEDS_MORE_INFO"
  ) {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fca5a5",
      color: "#991b1b",
    };
  }
  if (stage === "CLOSED") {
    return {
      ...base,
      background: "#f1f5f9",
      borderColor: "#cbd5e1",
      color: "#475569",
    };
  }
  return {
    ...base,
    background: "#eff6ff",
    borderColor: "#93c5fd",
    color: "#1e40af",
  };
}
