"use client";

/**
 * Phase 13 — Enterprise review operations queue.
 *
 * Workflow-stage-driven view of all in-flight reviews in the workspace.
 * Sits next to the Phase 7 evidence-request queue at `/review` — that
 * one is the per-request triage surface; this one is the per-evidence
 * review-stage operations surface.
 *
 * Stages, SLA, escalation, decisions, and bulk actions follow the
 * canonical state machine in `@proovra/shared/review-operations`.
 *
 * Wording rule: approvals are "internal" only. The UI never claims
 * authenticity, admissibility, or proven truth.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { usePlatformContext, useTeamId } from "../../../../lib/platform-context";
// Closure verification Part C — Phase 13 review operations queue is a
// high-trust reviewer surface (REVIEWER_OPS_VIEW, ORGANIZATION_ONLY).
// Wrap in the canonical PageRouteGate so the UX layer matches the
// backend RBAC boundary.
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
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

const STAGES: Stage[] = [
  "QUEUED",
  "ASSIGNED",
  "IN_REVIEW",
  "NEEDS_MORE_INFO",
  "RESPONSE_RECEIVED",
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "ESCALATED",
  "REOPENED",
  "CLOSED",
];

type Workflow = {
  id: string;
  evidenceId: string;
  teamId: string | null;
  stage: Stage;
  approvedForGovernanceGate: boolean;
  priority: string;
  assignedToUserId: string | null;
  assignedAtUtc: string | null;
  reassignedAtUtc: string | null;
  dueAt: string | null;
  firstResponseDueAtUtc: string | null;
  completedAtUtc: string | null;
  slaStatus: string | null;
  escalationLevel: number;
  escalatedAtUtc: string | null;
  escalationReason: string | null;
  reopenCount: number;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type Counts = {
  byStage: Record<Stage, number>;
  overdue: number;
  dueSoon: number;
  unassigned: number;
  assignedToMe: number;
};

function ReviewOperationsPageBody() {
  const teamId = useTeamId();
  const meUserId = usePlatformContext().envelope?.user.id ?? null;
  const [counts, setCounts] = useState<Counts | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | "">("IN_REVIEW");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  
useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (stage) qs.set("stage", stage);
    if (unassignedOnly) qs.set("unassigned", "true");
    if (overdueOnly) qs.set("slaStatus", "OVERDUE");
    if (escalatedOnly) qs.set("escalated", "true");
    if (assignedToMe && meUserId) qs.set("assignedToUserId", meUserId);
    qs.set("limit", "100");

    Promise.all([
      apiFetch(
        `/v1/review-operations/queue-counts?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      apiFetch(`/v1/review-operations/queue?${qs.toString()}`, {
        method: "GET",
      }),
    ])
      .then(
        ([c, list]: [{ counts: Counts }, { workflows: Workflow[] }]) => {
          if (cancelled) return;
          setCounts(c.counts);
          setWorkflows(list.workflows ?? []);
          setSelected({});
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Could not load review queue." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    teamId,
    stage,
    unassignedOnly,
    overdueOnly,
    escalatedOnly,
    assignedToMe,
    meUserId,
  ]);

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((k) => selected[k]),
    [selected],
  );

  async function claim(evidenceId: string) {
    if (!teamId) return;
    setBusy(true);
    try {
      await apiFetch(
        `/v1/review-operations/evidence/${evidenceId}/claim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      // Refetch to reflect the change.
      setStage((s) => s);
      // Trigger reload by toggling state slightly.
      setSelected({ __reload: false });
      setSelected({});
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not claim." }).message);
    } finally {
      setBusy(false);
    }
  }

  async function bulkAction(
    action: "MARK_IN_REVIEW" | "ESCALATE" | "CLOSE" | "REQUEST_MORE_INFO",
  ) {
    if (!teamId || selectedIds.length === 0) return;
    let note: string | null = null;
    if (action === "ESCALATE" || action === "REQUEST_MORE_INFO") {
      note = window.prompt(
        action === "ESCALATE"
          ? "Reason for escalation (required)"
          : "What additional information is needed? (required)",
      );
      if (!note || note.trim().length === 0) return;
    }
    setBusy(true);
    try {
      const res: {
        result: {
          total: number;
          succeeded: number;
          failed: number;
          items: Array<{ evidenceId: string; ok: boolean; reason?: string }>;
        };
      } = await apiFetch(`/v1/review-operations/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          evidenceIds: selectedIds,
          action,
          note,
        }),
      });
      const r = res.result;
      alert(
        `${r.succeeded} succeeded · ${r.failed} failed (of ${r.total}).`,
      );
      setSelected({});
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Bulk action failed." }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Review operations</h1>
        <p style={mutedStyle}>
          Workflow-stage view of all in-flight reviews. Approvals here
          are internal review decisions only; they do not assert
          authenticity, admissibility, or proven truth.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view the queue.</p>
      ) : counts === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Headlines</h2>
            <div style={summaryGridStyle}>
              <Stat
                label="Assigned to me"
                value={String(counts.assignedToMe)}
              />
              <Stat label="Unassigned" value={String(counts.unassigned)} />
              <Stat
                label="Overdue"
                value={String(counts.overdue)}
                tone={counts.overdue > 0 ? "warn" : "neutral"}
              />
              <Stat label="Due soon" value={String(counts.dueSoon)} />
              <Stat label="Escalated" value={String(counts.byStage.ESCALATED)} />
              <Stat
                label="Approved (internal)"
                value={String(counts.byStage.APPROVED_INTERNAL)}
              />
            </div>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Queue</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  value={stage}
                  onChange={(e) => setStage(e.target.value as Stage | "")}
                  style={selectStyle}
                >
                  <option value="">All statuses</option>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s} ({counts.byStage[s]})
                    </option>
                  ))}
                </select>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={assignedToMe}
                    disabled={!meUserId}
                    onChange={(e) => setAssignedToMe(e.target.checked)}
                  />
                  Assigned to me
                </label>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={unassignedOnly}
                    onChange={(e) => setUnassignedOnly(e.target.checked)}
                  />
                  Unassigned
                </label>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={overdueOnly}
                    onChange={(e) => setOverdueOnly(e.target.checked)}
                  />
                  Overdue
                </label>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={escalatedOnly}
                    onChange={(e) => setEscalatedOnly(e.target.checked)}
                  />
                  Escalated
                </label>
              </div>
            </div>

            {selectedIds.length > 0 ? (
              <div style={bulkBarStyle}>
                <strong>{selectedIds.length}</strong> selected
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  disabled={busy}
                  onClick={() => bulkAction("MARK_IN_REVIEW")}
                >
                  Mark in review
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  disabled={busy}
                  onClick={() => bulkAction("REQUEST_MORE_INFO")}
                >
                  Request more info
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  disabled={busy}
                  onClick={() => bulkAction("ESCALATE")}
                >
                  Escalate
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  disabled={busy}
                  onClick={() => bulkAction("CLOSE")}
                >
                  Close
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  disabled={busy}
                  onClick={() => setSelected({})}
                >
                  Clear selection
                </button>
              </div>
            ) : null}

            {workflows === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : workflows.length === 0 ? (
              <p style={mutedStyle}>No items match the current filters.</p>
            ) : (
              <ul style={listStyle}>
                {workflows.map((w) => (
                  <li key={w.id} style={rowStyle}>
                    <input
                      type="checkbox"
                      checked={!!selected[w.evidenceId]}
                      onChange={(e) =>
                        setSelected((prev) => ({
                          ...prev,
                          [w.evidenceId]: e.target.checked,
                        }))
                      }
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link
                        href={`/evidence/${w.evidenceId}`}
                        style={{ fontWeight: 600, color: "#0f172a" }}
                      >
                        Evidence {w.evidenceId.slice(0, 8)}…
                      </Link>
                      <div style={mutedStyle}>
                        priority {w.priority}
                        {w.assignedToUserId
                          ? ` · assigned ${w.assignedToUserId.slice(0, 8)}…`
                          : " · unassigned"}
                        {w.dueAt
                          ? ` · due ${formatUserDate(w.dueAt)}`
                          : ""}
                        {w.escalationLevel > 0
                          ? ` · esc L${w.escalationLevel}`
                          : ""}
                        {w.reopenCount > 0
                          ? ` · reopened ${w.reopenCount}×`
                          : ""}
                      </div>
                    </div>
                    {w.slaStatus ? (
                      <span style={slaBadgeStyle(w.slaStatus)}>
                        {w.slaStatus}
                      </span>
                    ) : null}
                    <span style={stageBadgeStyle(w.stage)}>{w.stage}</span>
                    {!w.assignedToUserId ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        disabled={busy}
                        onClick={() => claim(w.evidenceId)}
                      >
                        Claim
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div style={statStyle}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "warn" ? "#b45309" : "#0f172a",
        }}
      >
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};
const statStyle: React.CSSProperties = {
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0",
};
const bulkBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  marginBottom: 12,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 14,
};
const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 13,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
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

function stageBadgeStyle(stage: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
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

function slaBadgeStyle(sla: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
  };
  if (sla === "BREACHED" || sla === "OVERDUE") {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fca5a5",
      color: "#991b1b",
    };
  }
  if (sla === "DUE_SOON") {
    return {
      ...base,
      background: "#fffbeb",
      borderColor: "#fcd34d",
      color: "#92400e",
    };
  }
  if (sla === "PAUSED") {
    return {
      ...base,
      background: "#f1f5f9",
      borderColor: "#cbd5e1",
      color: "#475569",
    };
  }
  return {
    ...base,
    background: "#f0fdf4",
    borderColor: "#86efac",
    color: "#166534",
  };
}

// Closure verification Part C — canonical PageRouteGate wrapper.
export default function ReviewOperationsPage() {
  return (
    <PageRouteGate routeId="review.operations">
      <ReviewOperationsPageBody />
    </PageRouteGate>
  );
}
