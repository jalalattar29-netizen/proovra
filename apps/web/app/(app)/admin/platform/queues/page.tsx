"use client";

/**
 * Phase P2.4 — Queue operations console.
 *
 * Consumes the P2.3 backend:
 *
 *   GET  /v1/operations/queues
 *   GET  /v1/operations/queues/workers
 *   GET  /v1/operations/queues/replay-safety
 *   GET  /v1/operations/queues/:queueName/failed
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/retry
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/replay
 *   POST /v1/operations/queues/:queueName/jobs/:jobId/cancel
 *
 * Sections:
 *   1. Queue overview cards
 *   2. Worker health panel
 *   3. Selected-queue failed-jobs table with replay-safety badges
 *   4. Replay dialog: reason input, step-up modal (auto-surfaces),
 *      bounded outcome states
 *
 * Hard rules:
 *   * Replay button only renders for `safe` or `requires_step_up`.
 *   * `forbidden` shows an explicit refusal copy, NEVER a button.
 *   * Replay always requires a reason (≥1 char).
 *   * Step-up modal handled via `useStepUpAction`.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { AccessGate } from "../../../../../components/access/AccessGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  badgeStyle,
  cardStyle,
  formatDateTime,
  inputStyle,
  mutedStyle,
  primaryButtonStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  TOKENS,
} from "../../identity/ui-tokens";

type QueueInventoryItem = {
  queueName: string;
  label: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  stalledCount: number;
  health:
    | "healthy"
    | "degraded"
    | "outage"
    | "unconfigured"
    | "disabled"
    | "unknown";
  oldestWaitingAgeMs: number | null;
  /** Operator-readable reason when the queue is unconfigured / disabled. */
  disabledReason?: string | null;
};

type WorkerHealthRow = {
  queueName: string;
  status: "healthy" | "degraded" | "missing" | "unknown";
  lastActivityAtUtc: string | null;
  stalledCount: number;
  recommendedAction: string | null;
};

type ReplayCategory =
  | "safe"
  | "requires_step_up"
  | "forbidden"
  | "unknown";

type MatrixEntry = {
  queueName: string;
  jobKind: string;
  category: ReplayCategory;
  rationale: string;
};

type FailedJobItem = {
  jobId: string;
  jobName: string;
  failedAtUtc: string | null;
  attemptsMade: number;
  maxAttempts: number | null;
  failureReason: string;
  stackSnippet: string | null;
  safeRefs: {
    teamId: string | null;
    evidenceId: string | null;
    matterId: string | null;
  };
};

export default function OperationsQueuesPage() {
  return (
    <PageRouteGate routeId="platform.queue_ops">
      <OperationsQueuesContent />
    </PageRouteGate>
  );
}

function OperationsQueuesContent() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [queues, setQueues] = useState<QueueInventoryItem[] | null>(null);
  const [workers, setWorkers] = useState<WorkerHealthRow[] | null>(null);
  const [matrix, setMatrix] = useState<MatrixEntry[] | null>(null);
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
  const [failedJobs, setFailedJobs] = useState<FailedJobItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [replayReason, setReplayReason] = useState("");
  const [replayTarget, setReplayTarget] = useState<{
    jobId: string;
    jobName: string;
    category: ReplayCategory;
  } | null>(null);

  const loadAll = useCallback(() => {
    if (!teamId) return;
    setError(null);
    Promise.all([
      apiFetch(`/v1/operations/queues?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(
        `/v1/operations/queues/workers?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/operations/queues/replay-safety?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
    ])
      .then(([qRes, wRes, mRes]) => {
        setQueues((qRes as { queues: QueueInventoryItem[] }).queues ?? []);
        setWorkers((wRes as { workers: WorkerHealthRow[] }).workers ?? []);
        setMatrix((mRes as { matrix: MatrixEntry[] }).matrix ?? []);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load queue operations." }).message),
      );
  }, [teamId]);

  const loadFailed = useCallback(
    (queueName: string) => {
      if (!teamId) return;
      setFailedJobs(null);
      apiFetch(
        `/v1/operations/queues/${encodeURIComponent(
          queueName,
        )}/failed?teamId=${encodeURIComponent(teamId)}&limit=50`,
        { method: "GET" },
      )
        .then((r: { jobs: FailedJobItem[] }) => setFailedJobs(r.jobs ?? []))
        .catch((err: { message?: string }) =>
          setError(toSafeUserError(err, { message: "Could not load failed jobs." }).message),
        );
    },
    [teamId],
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (selectedQueue) loadFailed(selectedQueue);
  }, [selectedQueue, loadFailed]);

  const categoryFor = useCallback(
    (queueName: string, jobName: string): ReplayCategory => {
      if (!matrix) return "unknown";
      const e = matrix.find(
        (m) => m.queueName === queueName && m.jobKind === jobName,
      );
      return e?.category ?? "unknown";
    },
    [matrix],
  );

  const performReplay = useCallback(
    async (action: "retry" | "replay") => {
      if (!teamId || !selectedQueue || !replayTarget) return;
      if (replayReason.trim().length === 0) {
        setError("Operator reason is required.");
        return;
      }
      setBusyJobId(replayTarget.jobId);
      setError(null);
      setSuccess(null);
      try {
        if (action === "replay" && replayTarget.category === "requires_step_up") {
          await stepUp.runStepUpAction(async (headers) => {
            return await apiFetch(
              `/v1/operations/queues/${encodeURIComponent(
                selectedQueue,
              )}/jobs/${encodeURIComponent(replayTarget.jobId)}/replay`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(headers ?? {}),
                },
                body: JSON.stringify({
                  teamId,
                  reason: replayReason.trim(),
                  expectedJobName: replayTarget.jobName,
                }),
              },
            );
          });
        } else {
          await apiFetch(
            `/v1/operations/queues/${encodeURIComponent(
              selectedQueue,
            )}/jobs/${encodeURIComponent(replayTarget.jobId)}/${action}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                teamId,
                reason: replayReason.trim(),
                expectedJobName: replayTarget.jobName,
              }),
            },
          );
        }
        setSuccess(`Job ${action} recorded.`);
        setReplayTarget(null);
        setReplayReason("");
        loadFailed(selectedQueue);
        loadAll();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — no replay was performed.");
        } else {
          setError(
            toSafeUserError(err, { message: `${action} failed.` }).message,
          );
        }
      } finally {
        setBusyJobId(null);
      }
    },
    [teamId, selectedQueue, replayTarget, replayReason, stepUp, loadFailed, loadAll],
  );

  const pageHeader = (
    <PageHeader
      eyebrow="Platform operations"
      title="Queue Operations"
      subtitle={"Inspect queues, triage failed jobs, replay safe jobs, and detect worker degradation. The replay-safety matrix below enforces what kinds of jobs may be replayed; destructive job kinds are hard-refused."}
      secondaryActions={
        <>
          <button type="button" className="apf-control" onClick={loadAll}>
          Refresh
          </button>
        </>
      }
    />
  );

  if (!teamId) {
    return (
      <PageShell width="full" header={pageHeader}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Queue Operations"
          headline="Switch to a workspace to operate queues"
          reason="Queue operations are audit-attributed to the workspace you operate from."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="queue-ops-no-workspace"
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="full" header={pageHeader} data-testid="operations-queues-root">

      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      <QueueOverviewCards
        queues={queues}
        selectedQueue={selectedQueue}
        onSelect={setSelectedQueue}
      />

      <WorkerHealthPanel workers={workers} />

      {selectedQueue ? (
        <FailedJobsPanel
          queueName={selectedQueue}
          jobs={failedJobs}
          categoryFor={categoryFor}
          onPickReplay={(j, category) => {
            setReplayTarget({
              jobId: j.jobId,
              jobName: j.jobName,
              category,
            });
            setReplayReason("");
          }}
          busyJobId={busyJobId}
        />
      ) : null}

      {replayTarget ? (
        <ReplayDialog
          target={replayTarget}
          reason={replayReason}
          onReasonChange={setReplayReason}
          onCancel={() => {
            setReplayTarget(null);
            setReplayReason("");
          }}
          onRetry={() => performReplay("retry")}
          onReplay={() => performReplay("replay")}
          busy={busyJobId !== null}
        />
      ) : null}

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

function healthBadge(h: QueueInventoryItem["health"]) {
  if (h === "healthy")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (h === "degraded")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (h === "outage")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  if (h === "disabled")
    return badgeStyle({ bg: "#f5f5f4", fg: "#57534e", border: "#d6d3d1" });
  return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
}

function QueueOverviewCards({
  queues,
  selectedQueue,
  onSelect,
}: {
  queues: QueueInventoryItem[] | null;
  selectedQueue: string | null;
  onSelect: (q: string) => void;
}) {
  if (queues === null) {
    return (
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <p className="apf-muted">Loading queues…</p>
      </section>
    );
  }
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 8,
        marginTop: 16,
      }}
      data-testid="queue-overview"
    >
      {queues.map((q) => {
        const isSelected = selectedQueue === q.queueName;
        return (
          <button
            key={q.queueName}
            type="button"
            onClick={() => onSelect(q.queueName)}
            style={{
              ...cardStyle,
              cursor: "pointer",
              textAlign: "left",
              border: isSelected
                ? `2px solid ${TOKENS.accent}`
                : `1px solid ${TOKENS.border}`,
              background: TOKENS.surface,
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong style={{ fontSize: 13 }}>{q.label}</strong>
              <span style={healthBadge(q.health)}>{q.health}</span>
            </div>
            <div style={{ ...mutedStyle, marginTop: 6, fontSize: 11 }}>
              {q.queueName}
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
                marginTop: 8,
                fontSize: 12,
              }}
            >
              <span>
                <strong>{q.counts.waiting}</strong> waiting
              </span>
              <span>
                <strong>{q.counts.active}</strong> active
              </span>
              <span
                style={{
                  color: q.counts.failed > 0 ? "#991b1b" : TOKENS.inkMuted,
                }}
              >
                <strong>{q.counts.failed}</strong> failed
              </span>
              {q.stalledCount > 0 ? (
                <span style={{ color: "#991b1b" }}>
                  <strong>{q.stalledCount}</strong> stalled
                </span>
              ) : null}
            </div>
          </button>
        );
      })}
    </section>
  );
}

function WorkerHealthPanel({ workers }: { workers: WorkerHealthRow[] | null }) {
  if (workers === null) return null;
  const degradedOrMissing = workers.filter(
    (w) => w.status === "degraded" || w.status === "missing",
  );
  if (degradedOrMissing.length === 0) {
    return (
      <section
        style={{
          ...cardStyle,
          marginTop: 12,
          background: "#ecfdf5",
          border: "1px solid #a7f3d0",
        }}
      >
        <span style={{ fontSize: 13, color: "#065f46" }}>
          All workers reporting healthy.
        </span>
      </section>
    );
  }
  return (
    <section
      style={{ ...cardStyle, marginTop: 12 }}
      data-testid="worker-health"
    >
      <h3 className="apf-section-title">Worker health</h3>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Queue</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Stalled</th>
            <th style={thStyle}>Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {degradedOrMissing.map((w) => (
            <tr key={w.queueName}>
              <td style={tdStyle}>
                <code style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {w.queueName}
                </code>
              </td>
              <td style={tdStyle}>
                <span
                  style={badgeStyle(
                    w.status === "missing"
                      ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
                      : { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
                  )}
                >
                  {w.status}
                </span>
              </td>
              <td style={tdStyle}>{w.stalledCount}</td>
              <td style={tdStyle}>
                <span style={{ fontSize: 12 }}>
                  {w.recommendedAction ?? "—"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function categoryBadge(c: ReplayCategory) {
  if (c === "safe")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (c === "requires_step_up")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (c === "forbidden")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
}

function FailedJobsPanel({
  queueName,
  jobs,
  categoryFor,
  onPickReplay,
  busyJobId,
}: {
  queueName: string;
  jobs: FailedJobItem[] | null;
  categoryFor: (queueName: string, jobName: string) => ReplayCategory;
  onPickReplay: (j: FailedJobItem, category: ReplayCategory) => void;
  busyJobId: string | null;
}) {
  return (
    <section
      style={{ ...cardStyle, marginTop: 12, padding: 0 }}
      data-testid="failed-jobs-panel"
    >
      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${TOKENS.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 14 }}>Failed jobs · {queueName}</strong>
      </div>
      {jobs === null ? (
        <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
      ) : jobs.length === 0 ? (
        <p style={{ ...mutedStyle, padding: 24 }}>
          No failed jobs in this queue.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Job id</th>
              <th style={thStyle}>Job name</th>
              <th style={thStyle}>Replay safety</th>
              <th style={thStyle}>Failed</th>
              <th style={thStyle}>Attempts</th>
              <th style={thStyle}>Reason</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const cat = categoryFor(queueName, j.jobName);
              const disabled = cat === "forbidden" || cat === "unknown";
              return (
                <tr key={j.jobId}>
                  <td style={tdStyle}>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {j.jobId.slice(0, 18)}
                      {j.jobId.length > 18 ? "…" : ""}
                    </code>
                  </td>
                  <td style={tdStyle}>{j.jobName}</td>
                  <td style={tdStyle}>
                    <span style={categoryBadge(cat)}>{cat}</span>
                  </td>
                  <td style={tdStyle}>
                    <span className="apf-muted">
                      {formatDateTime(j.failedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {j.attemptsMade}
                    {j.maxAttempts ? ` / ${j.maxAttempts}` : ""}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: TOKENS.inkMuted,
                      }}
                    >
                      {j.failureReason}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {disabled ? (
                      <span style={{ ...mutedStyle, fontSize: 11 }}>
                        {cat === "forbidden"
                          ? "Forbidden — diagnose via audit center"
                          : "Unknown kind — refused"}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="apf-control"
                        disabled={busyJobId !== null}
                        onClick={() => onPickReplay(j, cat)}
                      >
                        Replay…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ReplayDialog({
  target,
  reason,
  onReasonChange,
  onCancel,
  onRetry,
  onReplay,
  busy,
}: {
  target: { jobId: string; jobName: string; category: ReplayCategory };
  reason: string;
  onReasonChange: (s: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onReplay: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-label="Replay job"
      data-testid="replay-dialog"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        width: 420,
        background: TOKENS.surface,
        border: `1px solid ${TOKENS.borderStrong}`,
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(15,23,42,0.15)",
        padding: 16,
        zIndex: 60,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 14 }}>Replay job</strong>
        <button type="button" className="apf-control" onClick={onCancel}>
          Close
        </button>
      </header>
      <p style={{ ...mutedStyle, marginTop: 8 }}>
        <code style={{ fontFamily: "monospace", fontSize: 11 }}>
          {target.jobName} · {target.jobId.slice(0, 24)}
        </code>
        <span style={{ marginLeft: 8 }}>
          <span style={categoryBadge(target.category)}>{target.category}</span>
        </span>
      </p>
      <label style={{ display: "block", marginTop: 8, fontSize: 12 }}>
        Operator reason (required)
        <input
          style={{ ...inputStyle, marginTop: 4 }}
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          placeholder="e.g. upstream API recovered; investigated incident XYZ"
          data-testid="replay-reason"
        />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="apf-control"
          onClick={onRetry}
          disabled={busy || reason.trim().length === 0}
        >
          {busy ? "Retrying…" : "Retry attempt"}
        </button>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={onReplay}
          disabled={busy || reason.trim().length === 0}
        >
          {busy
            ? "Replaying…"
            : target.category === "requires_step_up"
              ? "Replay (step-up)"
              : "Replay"}
        </button>
      </div>
      {target.category === "requires_step_up" ? (
        <p style={{ ...mutedStyle, marginTop: 8 }}>
          ⚠ This job kind requires step-up confirmation before the replay
          executes.
        </p>
      ) : null}
    </div>
  );
}
