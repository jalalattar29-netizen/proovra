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

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";

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
    if (!teamId || busyEvidenceId !== null) return;
    const ok = await confirm({
      title: "Mark this upload as ABANDONED?",
      description: `Upload session for evidence ${evidenceId.slice(0, 8)}… in the active workspace is closed for good: no further pieces are accepted and it cannot be reopened. The evidence record itself is not deleted.`,
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
      // Into the page's own error region — an alert() is neither accessible
      // nor part of the shared feedback system.
      setError(toSafeUserError(err, { message: "Could not mark abandoned." }).message);
    } finally {
      setBusyEvidenceId(null);
    }
  }

  async function requestReview(evidenceId: string) {
    if (!teamId || busyEvidenceId !== null) return;
    // Escalates the upload into the review queue and raises a WARNING
    // security event for it — an operator hand-off, not a refresh.
    const ok = await confirm({
      title: "Send this upload for review?",
      description: `Upload session for evidence ${evidenceId.slice(0, 8)}… is marked REVIEW_REQUIRED in the active workspace and a warning security event is recorded. It stays out of the automatic recovery sweep until an operator resolves it.`,
      confirmLabel: "Request review",
      tone: "warning",
      testId: "reliability-request-review",
    });
    if (!ok) return;
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
      setError(toSafeUserError(err, { message: "Could not request review." }).message);
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
    <PageShell
      width="full"
      header={
        // THE EYEBROW SAID "Platform operations" ON A ONE-WORKSPACE PAGE.
        //
        // Its own subtitle said "for this workspace", and the API behind it
        // (`/v1/reliability/*`, `requireAdminMember`) answers for exactly one
        // workspace and refuses every other — including a platform operator
        // who is not a member. The label promised a platform blast radius for
        // a tenant-scoped surface, which is the most consequential thing a
        // scope banner can get wrong: an operator reading "platform" trusts
        // these counts to be the whole estate.
        <PageHeader
          eyebrow="Workspace operations"
          title="Reliability operations"
          subtitle={"Internal-only view of upload session health for the ACTIVE WORKSPACE — not a platform-wide total. Stalled, failed, and review-required uploads are NEVER auto-deleted. Operator actions move the session through the canonical state machine without mutating the underlying evidence row, custody chain, or stored bytes."}
        />
      }
    >

      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}

      {!teamId ? (
        <p className="apf-muted">Switch to a workspace to view reliability data.</p>
      ) : summary === null || headlineCounts === null ? (
        <p className="apf-muted">Loading…</p>
      ) : (
        <>
          <section className="apf-section">
            <h2 className="apf-section-title">Headlines</h2>
            <div className="apf-grid">
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

          <section className="apf-section">
            <div className="apf-section-head">
              <h2 className="apf-section-title">Upload sessions</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="apf-control"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s} ({summary.counts[s] ?? 0})
                  </option>
                ))}
              </select>
            </div>
            {sessions === null ? (
              <p className="apf-muted">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="apf-muted">No sessions in this state.</p>
            ) : (
              <ul style={listStyle}>
                {sessions.map((s) => (
                  <li key={s.id} className="apf-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        Evidence {s.evidenceId.slice(0, 8)}…
                        {s.isMultipart
                          ? ` · multipart ${s.completedPartCount}/${s.expectedPartCount ?? "?"}`
                          : ""}
                        {s.retryCount > 0 ? ` · retries ${s.retryCount}` : ""}
                      </div>
                      <div className="apf-muted">
                        last activity{" "}
                        {formatUserDateTime(s.lastActivityAtUtc)}
                        {s.failureReason ? ` · ${s.failureReason}` : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(s.status)}>{s.status}</span>
                    {!s.isTerminal && s.status !== "REVIEW_REQUIRED" ? (
                      <button
                        type="button"
                        className="apf-control"
                        disabled={busyEvidenceId === s.evidenceId}
                        onClick={() => requestReview(s.evidenceId)}
                      >
                        Request review
                      </button>
                    ) : null}
                    {!s.isTerminal ? (
                      <button
                        type="button"
                        className="apf-control"
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

          <section className="apf-section">
            <h2 className="apf-section-title">Queue policies</h2>
            <p className="apf-muted">
              Background workers retry with bounded exponential backoff. Failed
              jobs are retained for operator inspection.
            </p>
            <ul style={listStyle}>
              {summary.queuePolicies.map((q) => (
                <li key={q.queueName} className="apf-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{q.queueName}</div>
                    <div className="apf-muted">{q.notes}</div>
                  </div>
                  <div className="apf-muted">
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
    </PageShell>
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
    <div className="apf-stat">
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          // The product warning ink, not a literal amber - see `--tone-orange`.
          color: tone === "warn" ? "var(--orange-500, #EA580C)" : "var(--ink-primary)",
        }}
      >
        {value}
      </div>
      <div className="apf-muted">{label}</div>
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

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "var(--ink-muted)" };
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };

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
      background: "var(--success-subtle-bg)",
      borderColor: "var(--success-border)",
      color: "var(--success-strong)",
    };
  }
  if (
    status === "FAILED" ||
    status === "STALLED" ||
    status === "REVIEW_REQUIRED"
  ) {
    return {
      ...base,
      background: "var(--danger-subtle-bg)",
      borderColor: "var(--danger-border)",
      color: "var(--danger-strong)",
    };
  }
  if (status === "ABANDONED") {
    return {
      ...base,
      background: "var(--surface-muted)",
      borderColor: "var(--border-standard)",
      color: "var(--ink-secondary)",
    };
  }
  return {
    ...base,
    background: "var(--info-subtle-bg)",
    borderColor: "var(--info-border)",
    color: "var(--info)",
  };
}
