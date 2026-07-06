"use client";

/**
 * Phase 12 — Reliability operations console.
 *
 * Authenticated OWNER/ADMIN visibility into the upload pipeline:
 *   - UploadSession status counts (CREATED / PRESIGNED / UPLOADING /
 *     PARTIAL / VERIFYING / COMPLETED / FAILED / STALLED / ABANDONED /
 *     REVIEW_REQUIRED).
 *   - Stalled / failed / review_required session lists with safe
 *     operator actions (mark abandoned / request review).
 *   - Queue policy summary (retry counts + DLQ for each queue).
 *
 * Recovery semantics:
 *   - Buttons NEVER delete an evidence row, mutate a hash, or fake
 *     completion. They only move the operations-side session through
 *     the canonical state machine.
 *   - REVIEW_REQUIRED is the safe fallback when an operator wants a
 *     human to look at an inconsistent state.
 *
 * Public verify, external intake, and report-v2 do NOT read these.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

type Counts = Record<string, number>;

type Thresholds = {
  stalledMinutes: number;
  abandonedHours: number;
};

type SizeLimits = {
  maxUploadFileSizeBytes: number;
  multipartThresholdBytes: number;
  multipartPartSizeBytes: number;
};

type QueuePolicy = {
  queueName: string;
  attempts: number;
  backoffInitialMs: number;
  backoffType: string;
  retainFailed: boolean;
  deadLetterQueue: string | null;
  notes: string;
};

type Summary = {
  counts: Counts;
  thresholds: Thresholds;
  sizeLimits: SizeLimits;
  queuePolicies: QueuePolicy[];
};

type Session = {
  id: string;
  evidenceId: string;
  teamId: string | null;
  status: string;
  isMultipart: boolean;
  expectedPartCount: number | null;
  completedPartCount: number;
  retryCount: number;
  failureReason: string | null;
  lastActivityAtUtc: string;
  stalledAtUtc: string | null;
  abandonedAtUtc: string | null;
  completedAtUtc: string | null;
  isTerminal: boolean;
  createdAt: string;
  updatedAt: string;
};

const STATUSES = [
  "CREATED",
  "PRESIGNED",
  "UPLOADING",
  "PARTIAL",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "STALLED",
  "ABANDONED",
  "REVIEW_REQUIRED",
] as const;

// Phase 38.15 — wrap in canonical PageRouteGate.
export default function ReliabilityPage() {
  return (
    <PageRouteGate routeId="platform.reliability">
      <ReliabilityPageInner />
    </PageRouteGate>
  );
}

function ReliabilityPageInner() {
  const teamId = useTeamId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("STALLED");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyEvidenceId, setBusyEvidenceId] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    Promise.all([
      apiFetch(
        `/v1/reliability/summary?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/reliability/upload-sessions?teamId=${encodeURIComponent(teamId)}&status=${statusFilter}&limit=100`,
        { method: "GET" },
      ),
    ])
      .then(
        ([s, list]: [Summary, { sessions: Session[] }]) => {
          if (cancelled) return;
          setSummary(s);
          setSessions(list.sessions ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Could not load reliability data." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, statusFilter]);

  async function markAbandoned(evidenceId: string) {
    if (!teamId) return;
    const ok = await confirm({
      title: "Mark this upload as ABANDONED?",
      description:
        "This is a terminal operator action. The upload session will be closed and no further pieces will be accepted.",
      confirmLabel: "Mark abandoned",
      tone: "warning",
      testId: "reliability-mark-abandoned",
    });
    if (!ok) return;
    setBusyEvidenceId(evidenceId);
    try {
      const res: { session: Session } = await apiFetch(
        `/v1/reliability/upload-sessions/${evidenceId}/mark-abandoned`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setSessions((prev) =>
        prev ? prev.map((s) => (s.evidenceId === evidenceId ? res.session : s)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not mark abandoned." }).message);
    } finally {
      setBusyEvidenceId(null);
    }
  }

  async function requestReview(evidenceId: string) {
    if (!teamId) return;
    setBusyEvidenceId(evidenceId);
    try {
      const res: { session: Session } = await apiFetch(
        `/v1/reliability/upload-sessions/${evidenceId}/request-review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      setSessions((prev) =>
        prev ? prev.map((s) => (s.evidenceId === evidenceId ? res.session : s)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not request review." }).message);
    } finally {
      setBusyEvidenceId(null);
    }
  }

  const headlineCounts = useMemo(() => {
    if (!summary) return null;
    return {
      active:
        (summary.counts.CREATED ?? 0) +
        (summary.counts.PRESIGNED ?? 0) +
        (summary.counts.UPLOADING ?? 0) +
        (summary.counts.PARTIAL ?? 0) +
        (summary.counts.VERIFYING ?? 0),
      stalled: summary.counts.STALLED ?? 0,
      reviewRequired: summary.counts.REVIEW_REQUIRED ?? 0,
      failed: summary.counts.FAILED ?? 0,
      completed: summary.counts.COMPLETED ?? 0,
      abandoned: summary.counts.ABANDONED ?? 0,
    };
  }, [summary]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Reliability operations</h1>
        <p style={mutedStyle}>
          Internal-only view of upload session health for this workspace.
          Stalled, failed, and review-required uploads are NEVER auto-deleted.
          Operator actions move the session through the canonical state
          machine without mutating the underlying evidence row, custody chain,
          or stored bytes.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view reliability data.</p>
      ) : summary === null || headlineCounts === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Headlines</h2>
            <div style={summaryGridStyle}>
              <Stat label="Active" value={String(headlineCounts.active)} />
              <Stat
                label="Stalled"
                value={String(headlineCounts.stalled)}
                tone={headlineCounts.stalled > 0 ? "warn" : "neutral"}
              />
              <Stat
                label="Review required"
                value={String(headlineCounts.reviewRequired)}
                tone={headlineCounts.reviewRequired > 0 ? "warn" : "neutral"}
              />
              <Stat label="Failed" value={String(headlineCounts.failed)} />
              <Stat label="Completed" value={String(headlineCounts.completed)} />
              <Stat label="Abandoned" value={String(headlineCounts.abandoned)} />
            </div>
            <p style={{ ...mutedStyle, marginTop: 12 }}>
              Stalled threshold: {summary.thresholds.stalledMinutes} minutes
              · Abandoned threshold: {summary.thresholds.abandonedHours} hours
              · Max upload size: {formatBytes(summary.sizeLimits.maxUploadFileSizeBytes)}
              · Multipart threshold: {formatBytes(summary.sizeLimits.multipartThresholdBytes)}
              · Part size: {formatBytes(summary.sizeLimits.multipartPartSizeBytes)}
            </p>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Upload sessions</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={selectStyle}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s} ({summary.counts[s] ?? 0})
                  </option>
                ))}
              </select>
            </div>
            {sessions === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : sessions.length === 0 ? (
              <p style={mutedStyle}>No sessions in this state.</p>
            ) : (
              <ul style={listStyle}>
                {sessions.map((s) => (
                  <li key={s.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        Evidence {s.evidenceId.slice(0, 8)}…
                        {s.isMultipart
                          ? ` · multipart ${s.completedPartCount}/${s.expectedPartCount ?? "?"}`
                          : ""}
                        {s.retryCount > 0 ? ` · retries ${s.retryCount}` : ""}
                      </div>
                      <div style={mutedStyle}>
                        last activity{" "}
                        {formatUserDateTime(s.lastActivityAtUtc)}
                        {s.failureReason ? ` · ${s.failureReason}` : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(s.status)}>{s.status}</span>
                    {!s.isTerminal && s.status !== "REVIEW_REQUIRED" ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        disabled={busyEvidenceId === s.evidenceId}
                        onClick={() => requestReview(s.evidenceId)}
                      >
                        Request review
                      </button>
                    ) : null}
                    {!s.isTerminal ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        disabled={busyEvidenceId === s.evidenceId}
                        onClick={() => markAbandoned(s.evidenceId)}
                      >
                        Mark abandoned
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Queue policies</h2>
            <p style={mutedStyle}>
              Background workers retry with bounded exponential backoff. Failed
              jobs are retained for operator inspection.
            </p>
            <ul style={listStyle}>
              {summary.queuePolicies.map((q) => (
                <li key={q.queueName} style={rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{q.queueName}</div>
                    <div style={mutedStyle}>{q.notes}</div>
                  </div>
                  <div style={mutedStyle}>
                    {q.attempts} attempts · {q.backoffType} backoff from{" "}
                    {Math.round(q.backoffInitialMs / 1000)}s
                    {q.deadLetterQueue
                      ? ` · DLQ: ${q.deadLetterQueue}`
                      : ""}
                  </div>
                </li>
              ))}
            </ul>
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
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

function statusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
  };
  if (status === "COMPLETED") {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  if (
    status === "FAILED" ||
    status === "STALLED" ||
    status === "REVIEW_REQUIRED"
  ) {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fca5a5",
      color: "#991b1b",
    };
  }
  if (status === "ABANDONED") {
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
