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
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { statusTone } from "../../../../../components/ui/StatusBadge";

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
  /* The summary answers a different question from the session list, so a
     failure on one must not take the other with it. */
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyEvidenceId, setBusyEvidenceId] = useState<string | null>(null);
  /**
   * WHAT THE OPERATOR JUST DID, SAID OUT LOUD.
   *
   * Both actions here replaced the row in place from the server's response and
   * announced nothing. The status capsule changing from ACTIVE to ABANDONED is
   * the outcome, but it is not confirmation: a row that was already abandoned,
   * a click that missed, and a successful mutation all leave the same screen.
   * These are hand-offs — one takes an upload out of the automatic recovery
   * sweep, the other raises a warning security event against it — and an
   * operator is entitled to be told the hand-off happened.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm } = useConfirmAction();

useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    /*
      TWO SOURCES, TWO OUTCOMES.

      This was `Promise.all` behind one `.catch`, so a failure on either read
      left the page with no summary AND no session list. They answer different
      questions — the summary is the platform's thresholds and per-status
      counts, the list is the sessions in one status — and losing the counts
      because a filtered list failed is losing the only thing that would tell
      the operator which status to look at instead.
    */
    void Promise.allSettled([
      apiFetch(
        `/v1/reliability/summary?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/reliability/upload-sessions?teamId=${encodeURIComponent(teamId)}&status=${statusFilter}&limit=100`,
        { method: "GET" },
      ),
    ]).then(([summaryOut, listOut]) => {
      if (cancelled) return;
      if (summaryOut.status === "fulfilled") {
        setSummary(summaryOut.value as Summary);
        setSummaryError(null);
      } else {
        setSummary(null);
        setSummaryError(
          toSafeUserError(summaryOut.reason, {
            message: "The reliability summary could not be read.",
          }).message,
        );
      }
      if (listOut.status === "fulfilled") {
        setSessions((listOut.value as { sessions: Session[] }).sessions ?? []);
        setError(null);
      } else {
        setSessions(null);
        setError(
          toSafeUserError(listOut.reason, {
            message: "The upload-session list could not be read.",
          }).message,
        );
      }
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
    setNotice(null);
    setError(null);
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
      setNotice(
        `Upload session ${evidenceId.slice(0, 8)}… is marked abandoned. It no longer appears in the automatic recovery sweep.`,
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
    setNotice(null);
    setError(null);
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
      setNotice(
        `Upload session ${evidenceId.slice(0, 8)}… is marked for review and a warning security event has been recorded against it.`,
      );
    } catch (err) {
      setError(toSafeUserError(err, { message: "Could not request review." }).message);
    } finally {
      setBusyEvidenceId(null);
    }
  }

  /** The statuses that DO have rows, so the empty view can point at one. */
  const nonEmptyStatuses = useMemo(
    () =>
      summary
        ? STATUSES.filter((s) => s !== statusFilter && (summary.counts[s] ?? 0) > 0)
        : [],
    [summary, statusFilter],
  );

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
      {notice ? (
        <div className="apf-note" data-tone="done" role="status" data-reliability-notice>
          {notice}
        </div>
      ) : null}

      {/*
        A FAILED SUMMARY IS NOT A PERMANENT "LOADING…".

        The whole page sat behind `summary === null`, and `null` is also what a
        failed read leaves behind — so an operator whose summary request was
        refused or timed out watched "Loading…" forever, with no session list
        either. The two reads are now independent, and so are the two
        renderings: a summary that did not arrive says so, and the upload
        sessions below still render.
      */}
      {!teamId ? (
        <p className="apf-muted">Switch to a workspace to view reliability data.</p>
      ) : summary === null && summaryError === null ? (
        <p className="apf-muted">Loading…</p>
      ) : (
        <>
          {summaryError ? (
            <div
              className="apf-note"
              data-tone="critical"
              data-reliability-summary-error
            >
              {summaryError} Thresholds and per-status counts are unavailable;
              the upload sessions below were read separately and are unaffected.
            </div>
          ) : null}
          {summary && headlineCounts ? (
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
            <p className="adm-help" style={{ marginTop: 12 }}>
              Stalled threshold: {summary.thresholds.stalledMinutes} minutes
              · Abandoned threshold: {summary.thresholds.abandonedHours} hours
              · Max upload size: {formatBytes(summary.sizeLimits.maxUploadFileSizeBytes)}
              · Multipart threshold: {formatBytes(summary.sizeLimits.multipartThresholdBytes)}
              · Part size: {formatBytes(summary.sizeLimits.multipartPartSizeBytes)}
            </p>
          </section>
          ) : null}

          <section className="apf-section">
            <div className="apf-section-head">
              <h2 className="apf-section-title">Upload sessions</h2>
              {/* A bare `<select>` is a mystery until it is opened: the
                  options are lifecycle states (CREATED, PRESIGNED, STALLED…)
                  and nothing on the page said what they belonged to. The
                  accessible name is what a screen reader reads, and the
                  visible "Status" is what everybody else needs. */}
              <label className="app-field-label" htmlFor="reliability-status">
                Status
              </label>
              <select
                id="reliability-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="apf-control"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {/* The count is the summary's, so it is omitted rather
                        than shown as zero when the summary did not arrive. */}
                    {summary ? `${s} (${summary.counts[s] ?? 0})` : s}
                  </option>
                ))}
              </select>
            </div>
            {sessions === null ? (
              <p className="apf-muted">Loading…</p>
            ) : sessions.length === 0 ? (
              /*
                THE FILTERED-EMPTY STATE, WITH SOMEWHERE TO GO.

                A status is always selected here — there is no unfiltered view
                — so "Clear filters" would clear nothing. What an operator
                actually needs is the same thing a Clear button gives them
                elsewhere: one move back to a view that has rows. The summary
                already carries a count per status, so the page can name one
                instead of leaving them to open the dropdown and guess.
              */
              <div className="apf-note" data-tone="unknown" data-reliability-filtered-empty>
                <p style={{ margin: 0 }}>
                  No upload sessions are in {statusFilter} right now. That is a
                  measured zero for this status, not a failed read.
                </p>
                {nonEmptyStatuses.length > 0 ? (
                  <>
                  <p style={{ margin: "6px 0 0" }}>
                    Sessions do exist in other states:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    {nonEmptyStatuses.map((s) => (
                      <Button
                        key={s}
                        variant="secondary"
                        size="sm"
                        onClick={() => setStatusFilter(s)}
                      >
                        {s} ({summary?.counts[s] ?? 0})
                      </Button>
                    ))}
                  </div>
                  </>
                ) : (
                  <p style={{ margin: "6px 0 0" }}>
                    No upload session is in any state in this workspace, so
                    every status here is empty.
                  </p>
                )}
              </div>
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
                    <Badge tone={statusTone(s.status)}>{s.status}</Badge>
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
            {/* Queue policies come from the summary too, so when the summary
                did not arrive this section says so rather than rendering an
                empty list that reads as "no retry policy is configured". */}
            {!summary ? (
              <p className="apf-muted">
                Not read — the reliability summary, which carries these
                policies, could not be loaded.
              </p>
            ) : (
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
            )}
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
          color: tone === "warn" ? "var(--orange-500)" : "var(--ink-primary)",
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

const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };

