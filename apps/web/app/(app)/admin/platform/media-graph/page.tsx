"use client";

/**
 * Phase 31.7 + 32.6 — Media intelligence + investigation graph
 * operations console.
 *
 * PLATFORM operator surface that pins the Phase 31.6 queue counters/gauges
 * and the Phase 32.5 graph query counters onto a single dashboard. It is a
 * projection of the in-process metrics registry and adds no server route.
 *
 * ADM-013 PHASE 1 — "Workspace-internal" was wrong twice over, and the words
 * outlived the thing they described. The registry is PROCESS-GLOBAL: identical
 * for every tenant on the instance, reset on deploy. The page is registered
 * `requiredActiveSpace: "PLATFORM_ADMIN"`, so its readers were never a
 * workspace population. And since `1afd5e0f` the metric snapshot lives at
 * `GET /v1/admin/platform/metrics` behind `requirePlatformAdmin`, which is
 * what this page now reads. The `teamId` below is still real and still
 * load-bearing — it scopes the two MUTATIONS (reindex / backfill), which act on
 * one workspace — but it has nothing to do with the counters above them, and
 * the two must not be read as one scope.
 *
 * Hard rules:
 *   * Tone is operational only. We never say "tampered" / "fake" /
 *     "authentic" / "admissible" / "proves" / "confirms".
 *   * No fake counters. If a tile's underlying counter is missing
 *     from the snapshot, the tile renders "—" rather than zero.
 *     Operators can distinguish "no traffic yet" (zero) from
 *     "instrument missing" (—) via the snapshot freshness pill.
 *   * No storage internals, no team-private data, no PII.
 *   * Auto-refresh is bounded — 30 s polling, clamped, paused when
 *     the tab is hidden.
 */

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
type MetricsSnapshot = {
  uptimeSeconds: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
};

/**
 * The ENVELOPE, which this page was reading as if it were the snapshot.
 *
 * ADM-013 PHASE 1 — a defect found while migrating the URL, not caused by it.
 *
 * `/v1/ops/metrics` has always answered `{ metrics: snapshotMetrics() }`. This
 * page declared the response as `MetricsSnapshot` and then read
 * `snapshot.counters`, which on the real body is `undefined`. The tile
 * renderer treats a missing counter as "instrument missing" and prints an em
 * dash rather than a zero — deliberately, and it is the right behaviour — so
 * EVERY tile on this console has been printing "—" and the page looked like a
 * quiet platform instead of a broken read. A cast silenced the only thing that
 * would have said so.
 *
 * The platform endpoint keeps the same envelope and adds scope and sampling
 * facts, so unwrapping is the fix for both spellings.
 */
type MetricsEnvelope = {
  scope?: string;
  metrics: MetricsSnapshot;
  uptimeSeconds?: number;
  countersResetOnRestart?: boolean;
  sampledAtUtc?: string;
};

type Tile = {
  label: string;
  metric: string;
  kind: "counter" | "gauge";
  hint?: string;
  tone?: "ok" | "info" | "warn" | "danger";
};

const MEDIA_INTELLIGENCE_TILES: Tile[] = [
  {
    label: "Queue depth",
    metric: "media_intelligence_queue_depth",
    kind: "gauge",
    hint: "Sum of PENDING + PROCESSING runs.",
    tone: "info",
  },
  {
    label: "Pending runs",
    metric: "media_intelligence_runs_pending",
    kind: "gauge",
    hint: "Runs waiting for a worker pickup.",
  },
  {
    label: "Processing runs",
    metric: "media_intelligence_runs_processing",
    kind: "gauge",
    hint: "Runs currently held by a worker.",
  },
  {
    label: "Failed runs",
    metric: "media_intelligence_runs_failed",
    kind: "gauge",
    hint: "Runs that exhausted retries — awaiting operator review.",
    tone: "warn",
  },
  {
    label: "Oldest pending age (s)",
    metric: "media_intelligence_oldest_pending_age_seconds",
    kind: "gauge",
    hint: "Lifecycle age of the longest-waiting run.",
    tone: "warn",
  },
];

const MEDIA_INTELLIGENCE_COUNTERS: Tile[] = [
  {
    label: "Enqueued (total)",
    metric: "media_intelligence_enqueue_total",
    kind: "counter",
  },
  {
    label: "Enqueue failed (total)",
    metric: "media_intelligence_enqueue_failed_total",
    kind: "counter",
    tone: "warn",
  },
  {
    label: "Processor started",
    metric: "media_intelligence_processor_started_total",
    kind: "counter",
  },
  {
    label: "Processor completed",
    metric: "media_intelligence_processor_completed_total",
    kind: "counter",
    tone: "ok",
  },
  {
    label: "Processor failed",
    metric: "media_intelligence_processor_failed_total",
    kind: "counter",
    tone: "warn",
  },
  {
    label: "Processor deferred",
    metric: "media_intelligence_processor_deferred_total",
    kind: "counter",
    hint: "Reserved job kinds drained cleanly.",
  },
  {
    label: "DLQ (total)",
    metric: "media_intelligence_dlq_total",
    kind: "counter",
    tone: "danger",
    hint: "Jobs that hit max attempts and parked.",
  },
  {
    label: "Run dismissed (operator)",
    metric: "media_intelligence_run_dismissed_total",
    kind: "counter",
  },
  {
    label: "Signals created",
    metric: "media_signal_created_total",
    kind: "counter",
  },
  {
    label: "Signals acknowledged",
    metric: "media_signal_acknowledged_total",
    kind: "counter",
  },
];

const GRAPH_TILES: Tile[] = [
  {
    label: "Nodes created (total)",
    metric: "graph_node_created_total",
    kind: "counter",
  },
  {
    label: "Edges created (total)",
    metric: "graph_edge_created_total",
    kind: "counter",
  },
  {
    label: "Edges removed (total)",
    metric: "graph_edge_removed_total",
    kind: "counter",
  },
  {
    label: "Reconcile started",
    metric: "graph_reconcile_started_total",
    kind: "counter",
  },
  {
    label: "Reconcile completed",
    metric: "graph_reconcile_completed_total",
    kind: "counter",
    tone: "ok",
  },
  {
    label: "Reconcile failed",
    metric: "graph_reconcile_failed_total",
    kind: "counter",
    tone: "warn",
  },
  {
    label: "Query (total)",
    metric: "graph_query_total",
    kind: "counter",
  },
  {
    label: "Query denied",
    metric: "graph_query_denied_total",
    kind: "counter",
    tone: "warn",
  },
  {
    label: "Case subgraph loaded",
    metric: "graph_case_subgraph_loaded_total",
    kind: "counter",
  },
  {
    label: "Search executed",
    metric: "graph_search_executed_total",
    kind: "counter",
  },
  {
    label: "Timeline executed",
    metric: "graph_timeline_executed_total",
    kind: "counter",
  },
];

type ActionResult =
  | { kind: "idle" }
  | { kind: "pending"; label: string }
  | { kind: "success"; label: string; detail: string }
  | { kind: "error"; label: string; detail: string };

// Phase 38.15 — wrap in canonical PageRouteGate.
export default function MediaGraphOpsPage() {
  return (
    <PageRouteGate routeId="platform.media_graph">
      <MediaGraphOpsPageInner />
    </PageRouteGate>
  );
}

function MediaGraphOpsPageInner() {
  const teamId = useTeamId();
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryRunId, setRetryRunId] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult>({
    kind: "idle",
  });

  
useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        // ADM-013 PHASE 1 — the canonical platform namespace. `/v1/ops/metrics`
        // returns the same payload behind the same gate and is retained only
        // as a compatibility spelling with no product consumer.
        const res = (await apiFetch("/v1/admin/platform/metrics", {
          method: "GET",
        })) as MetricsEnvelope;
        // Unwrap. See the MetricsEnvelope note: reading the envelope as the
        // snapshot is what made every tile render an em dash.
        if (!res?.metrics?.counters || !res?.metrics?.gauges) {
          throw new Error("metrics_envelope_unrecognised");
        }
        if (!cancelled) {
          setSnapshot(res.metrics);
          setLastFetchAt(Date.now());
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("metrics_unavailable");
        }
      }
    };

    void load();
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Phase 31.9 — bounded operator actions. Each handler:
  //   * requires teamId (no-op when unavailable);
  //   * surfaces success/error in a bounded ActionResult state;
  //   * NEVER throws to the caller — every failure lands in the
  //     ActionResult.error branch with a stable detail string.
  const { confirm } = useConfirmAction();

  const runRetry = async () => {
    if (actionResult?.kind === "pending") return;
    if (!teamId) {
      setActionResult({
        kind: "error",
        label: "Retry",
        detail: "Workspace context unavailable.",
      });
      return;
    }
    const trimmed = retryRunId.trim();
    if (!trimmed) {
      setActionResult({
        kind: "error",
        label: "Retry",
        detail: "Provide a job id (deterministic mi-<kind>-<evidenceId> form).",
      });
      return;
    }
    // A requeue runs the job's side effects again. Named before it runs.
    const ok = await confirm({
      title: "Requeue this media-intelligence job?",
      description: `Job ${trimmed} is placed back on its queue and runs again from the start. This queue is platform-wide, so the job may belong to any workspace on this deployment. If it had already completed elsewhere, its work is repeated.`,
      confirmLabel: "Requeue job",
      tone: "warning",
      testId: "media-graph-retry",
    });
    if (!ok) return;
    setActionResult({ kind: "pending", label: "Retry" });
    try {
      const res = (await apiFetch(
        `/v1/ops/media-intelligence/runs/${encodeURIComponent(trimmed)}/retry`,
        {
          method: "POST",
          body: JSON.stringify({ teamId }),
        },
      )) as { runId: string; retried: boolean };
      setActionResult({
        kind: "success",
        label: "Retry",
        detail: `Job ${res.runId} requeued.`,
      });
    } catch (err) {
      // The sanctioned error path: never a raw error message.
      setActionResult({
        kind: "error",
        label: "Retry",
        detail: toSafeUserError(err, { message: "The job was not requeued." }).message,
      });
    }
  };

  const runReplayDlq = async () => {
    if (actionResult?.kind === "pending") return;
    if (!teamId) {
      setActionResult({
        kind: "error",
        label: "Replay DLQ",
        detail: "Workspace context unavailable.",
      });
      return;
    }
    const ok = await confirm({
      title: "Replay the media-intelligence dead-letter queue?",
      description:
        "This queue is PLATFORM-WIDE. Up to 50 dead-lettered media-intelligence jobs are placed back on their queues and run again — across every workspace on this deployment, not only the one you are standing in. Jobs the replay-safety matrix refuses are skipped and reported; jobs that run again repeat their side effects.",
      confirmLabel: "Replay up to 50 jobs",
      tone: "warning",
      testId: "media-graph-replay-dlq",
    });
    if (!ok) return;
    setActionResult({ kind: "pending", label: "Replay DLQ" });
    try {
      const res = (await apiFetch(
        `/v1/ops/media-intelligence/dlq/replay`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, maxJobs: 50 }),
        },
      )) as { attempted: number; retried: number; skipped: number };
      setActionResult({
        kind: "success",
        label: "Replay DLQ",
        detail: `${res.retried} of ${res.attempted} attempted jobs requeued (${res.skipped} skipped).`,
      });
    } catch (err) {
      setActionResult({
        kind: "error",
        label: "Replay DLQ",
        detail: toSafeUserError(err, { message: "The dead-letter queue was not replayed." })
          .message,
      });
    }
  };

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  const pageHeader = (
    <PageHeader
      eyebrow="Platform operations"
      title="Media intelligence & graph operations"
      subtitle={"Live counters and gauges for the media-intelligence async queue and the investigation graph query surfaces."}
      secondaryActions={
        <>
          <span style={freshnessPillStyle(error, ageSeconds)}>
          {error
          ? "metrics unavailable"
          : ageSeconds == null
          ? "loading…"
          : `updated ${ageSeconds}s ago`}
          </span>
        </>
      }
    />
  );

  return (
    <PageShell width="full" header={pageHeader}>

      {error ? (
        <p className="apf-note" data-tone="critical">
          Metrics endpoint did not respond. Tiles below show the most
          recent successful snapshot if one was captured this session.
        </p>
      ) : null}

      <section className="apf-section">
        <h2 className="apf-section-title">Run lifecycle</h2>
        <TileGrid tiles={MEDIA_INTELLIGENCE_TILES} snapshot={snapshot} />
      </section>

      <section className="apf-section">
        <h2 className="apf-section-title">Queue + processor counters</h2>
        <TileGrid tiles={MEDIA_INTELLIGENCE_COUNTERS} snapshot={snapshot} />
      </section>

      <section className="apf-section">
        <h2 className="apf-section-title">Investigation graph</h2>
        <TileGrid tiles={GRAPH_TILES} snapshot={snapshot} />
      </section>

      <section className="apf-section">
        <h2 className="apf-section-title">Operator actions</h2>
        <div className="apf-section">
          <div className="apf-row">
            <div className="apf-stat-label">
              <div className="apf-section-title">Retry one job</div>
              <div className="apf-stat-hint">
                Requeues a specific failed BullMQ job. The id is the
                deterministic <code>mi-&lt;kind&gt;-&lt;evidenceId&gt;</code>
                form emitted by the producer.
              </div>
            </div>
            <div style={actionControlStyle}>
              <input
                type="text"
                value={retryRunId}
                placeholder="mi-extract_exif-<uuid>"
                aria-label="Failed job id to retry"
                onChange={(e) => setRetryRunId(e.target.value)}
                className="apf-control"
              />
              <button
                type="button"
                onClick={() => {
                  void runRetry();
                }}
                disabled={actionResult.kind === "pending" || !teamId}
                style={primaryButtonStyle(
                  actionResult.kind === "pending" || !teamId,
                )}
              >
                {actionResult.kind === "pending" && actionResult.label === "Retry"
                  ? "Retrying…"
                  : "Retry"}
              </button>
            </div>
          </div>

          <div className="apf-row" />

          <div className="apf-row">
            <div className="apf-stat-label">
              <div className="apf-section-title">Replay DLQ</div>
              <div className="apf-stat-hint">
                Walks up to 50 failed jobs and requeues each. Bounded by
                the server. Operator audit is recorded.
              </div>
            </div>
            <div style={actionControlStyle}>
              <button
                type="button"
                onClick={() => {
                  void runReplayDlq();
                }}
                disabled={actionResult.kind === "pending" || !teamId}
                style={primaryButtonStyle(
                  actionResult.kind === "pending" || !teamId,
                )}
              >
                {actionResult.kind === "pending" &&
                actionResult.label === "Replay DLQ"
                  ? "Replaying…"
                  : "Replay DLQ"}
              </button>
            </div>
          </div>

          {actionResult.kind !== "idle" &&
          actionResult.kind !== "pending" ? (
            <div
              style={
                actionResult.kind === "success"
                  ? actionResultSuccessStyle
                  : actionResultErrorStyle
              }
              role="status"
            >
              <strong>{actionResult.label}:</strong> {actionResult.detail}
            </div>
          ) : null}

          {!teamId ? (
            <div style={actionResultErrorStyle} role="status">
              Workspace context is loading. Buttons enable once a workspace
              is selected.
            </div>
          ) : null}
        </div>
      </section>

      <p className="apf-muted">
        Numbers are advisory operational telemetry. They do not classify
        the recorded material and they do not establish legal weight; the
        canonical custody record remains the authoritative integrity
        artifact.
      </p>
    </PageShell>
  );
}

function TileGrid({
  tiles,
  snapshot,
}: {
  tiles: Tile[];
  snapshot: MetricsSnapshot | null;
}) {
  return (
    <ul className="apf-grid">
      {tiles.map((t) => {
        const present =
          snapshot != null &&
          (t.kind === "counter" ? t.metric in snapshot.counters : t.metric in snapshot.gauges);
        const value = present
          ? t.kind === "counter"
            ? snapshot!.counters[t.metric]!
            : snapshot!.gauges[t.metric]!
          : null;
        return (
          <li key={t.metric} style={tileStyle(t.tone)}>
            <div className="apf-stat-label">{t.label}</div>
            <div className="apf-stat-value">
              {value == null ? "—" : formatNumber(value)}
            </div>
            <div className="apf-stat-label" title={t.hint}>
              {t.metric}
              {t.kind === "gauge" ? " (gauge)" : ""}
            </div>
            {t.hint ? <div className="apf-stat-hint">{t.hint}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Styles — inline, dense, enterprise. Matches the Operations Center
// (apps/web/app/(app)/ops/page.tsx) visual register.
// ---------------------------------------------------------------------------





function freshnessPillStyle(
  err: string | null,
  ageSeconds: number | null,
): React.CSSProperties {
  let bg = "#eff6ff";
  let border = "#bfdbfe";
  let color = "#1e40af";
  if (err) {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  } else if (ageSeconds != null && ageSeconds > 120) {
    bg = "#fffbeb";
    border = "#fcd34d";
    color = "#92400e";
  }
  return {
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}





function tileStyle(
  tone: Tile["tone"] | undefined,
): React.CSSProperties {
  const palette: Record<NonNullable<Tile["tone"]>, [string, string]> = {
    ok: ["#ecfdf5", "#bbf7d0"],
    info: ["#eff6ff", "#bfdbfe"],
    warn: ["#fffbeb", "#fcd34d"],
    danger: ["#fef2f2", "#fca5a5"],
  };
  const [bg, border] = tone ? palette[tone] : ["#ffffff", "#e5e7eb"];
  return {
    border: `1px solid ${border}`,
    background: bg,
    borderRadius: 8,
    padding: 12,
  };
}






// ---------------------------------------------------------------------------
// Phase 31.9 — operator action panel styles
// ---------------------------------------------------------------------------







const actionControlStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: 8,
  alignItems: "center",
  flex: "1 1 280px",
  minWidth: 240,
};


function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    // 44px touch floor (matrix measured 32px), matching the shared
    // identity/ui-tokens button raise.
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    fontSize: 12,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #0f172a",
    background: disabled ? "#94a3b8" : "#0f172a",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

const actionResultSuccessStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  color: "#166534",
  borderRadius: 6,
};

const actionResultErrorStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  color: "#991b1b",
  borderRadius: 6,
};
