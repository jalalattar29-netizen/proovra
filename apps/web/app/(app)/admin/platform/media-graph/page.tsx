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

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { IdentifierText } from "../../../../../components/ui/IdentifierText";
import { ResultCount } from "../../../../../components/ui/ResultCount";
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

/**
 * One row of `GET /v1/ops/media-intelligence/runs`.
 *
 * `runId` and `jobId` are separate fields on purpose — see `runDismiss`. They
 * happen to be derivable from one another today (`mi-run-<runId>`), and a UI
 * that relied on that would break silently the day the prefix moved.
 */
type MediaRun = {
  runId: string;
  jobId: string;
  teamId: string;
  evidenceId: string;
  kind: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  completedAtUtc: string | null;
};

type RunListEnvelope = {
  scope?: string;
  limit: number;
  hasMore: boolean;
  runs: MediaRun[];
};

/** What the run list currently knows, which is not the same as what it holds. */
type RunsState =
  | { kind: "loading" }
  | { kind: "ok"; hasMore: boolean }
  | { kind: "failed"; detail: string };

const RUN_STATUS_FILTERS = [
  "FAILED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "DISMISSED",
] as const;
type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

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

/**
 * WHY THE METRICS READ DID NOT ANSWER — WHICH IS THREE DIFFERENT FACTS.
 *
 * This was one string, `"metrics_unavailable"`, written from a `catch {}` that
 * did not even bind the error. So an operator refused the platform metrics
 * scope, an operator whose deployment ships no metrics endpoint, and an
 * operator hitting a five-hundred all read the same sentence: "Metrics
 * endpoint did not respond." Two of those three are wrong, and the first is
 * the one that matters — it tells someone to chase an outage that does not
 * exist instead of asking for the scope they are missing.
 *
 *   denied       the platform refused this operator. Nothing is broken and
 *                retrying will return the same answer.
 *   unrecognised the endpoint answered, but not with a metrics snapshot this
 *                console knows how to read. A deployment mismatch, not a fault.
 *   error        anything else, through the sanctioned safe path.
 */
type MetricsFailure = {
  kind: "denied" | "unrecognised" | "error";
  message: string;
};

function classifyMetricsFailure(err: unknown): MetricsFailure {
  if ((err as { code?: string })?.code === "metrics_envelope_unrecognised") {
    return {
      kind: "unrecognised",
      message:
        "The platform metrics endpoint answered with a payload this console does not recognise. The tiles below are left blank rather than filled with figures that were not measured.",
    };
  }
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 403) {
    return {
      kind: "denied",
      message:
        "Your operator role does not include the platform metrics scope, so these counters cannot be read here. Nothing is failing — ask a platform administrator for the scope.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, {
      message: "The platform metrics endpoint did not answer.",
    }).message,
  };
}

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
  const [error, setError] = useState<MetricsFailure | null>(null);
  const [retryRunId, setRetryRunId] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult>({
    kind: "idle",
  });
  const [runs, setRuns] = useState<MediaRun[]>([]);
  const [runsState, setRunsState] = useState<RunsState>({ kind: "loading" });
  const [runStatus, setRunStatus] = useState<RunStatusFilter>("FAILED");

  /**
   * Load the run list.
   *
   * Declared with `useCallback` because both the status filter effect and
   * `runDismiss` call it, and a fresh identity on every render would make the
   * effect below re-fetch on every keystroke in the retry field.
   *
   * A FAILED READ IS NOT AN EMPTY LIST. This console already had a page-wide
   * lesson about the two looking alike — every tile printed "—" for months
   * because a bad read was indistinguishable from a missing counter — so the
   * list reports its own failure rather than rendering as "no runs".
   */
  const loadRuns = useCallback(async () => {
    setRunsState({ kind: "loading" });
    try {
      const res = (await apiFetch(
        `/v1/ops/media-intelligence/runs?status=${encodeURIComponent(runStatus)}&limit=25`,
        { method: "GET" },
      )) as RunListEnvelope;
      const rows = Array.isArray(res?.runs) ? res.runs : [];
      setRuns(rows);
      setRunsState({ kind: "ok", hasMore: Boolean(res?.hasMore) });
    } catch (err) {
      setRuns([]);
      setRunsState({
        kind: "failed",
        detail: toSafeUserError(err, {
          message: "The run list could not be read.",
        }).message,
      });
    }
  }, [runStatus]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  
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
          throw Object.assign(new Error("metrics_envelope_unrecognised"), {
            code: "metrics_envelope_unrecognised",
          });
        }
        if (!cancelled) {
          setSnapshot(res.metrics);
          setLastFetchAt(Date.now());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(classifyMetricsFailure(err));
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

  /**
   * Requeue one job.
   *
   * ADM-P2-005 — takes the identifier as an ARGUMENT. It used to read the
   * free-text field directly, which is why the only way to retry anything was
   * to type an id. The run list below calls this with the row's own `jobId`;
   * the field is now the fallback for an id an operator already holds, not the
   * only route in.
   */
  const runRetry = async (jobId?: string) => {
    if (actionResult?.kind === "pending") return;
    if (!teamId) {
      setActionResult({
        kind: "error",
        label: "Retry",
        detail: "Workspace context unavailable.",
      });
      return;
    }
    const trimmed = (jobId ?? retryRunId).trim();
    if (!trimmed) {
      setActionResult({
        kind: "error",
        label: "Retry",
        // The old text named `mi-<kind>-<evidenceId>`, which the producer
        // stopped emitting when the job id became `mi-run-<runId>` — an
        // operator following it built an id that matches nothing. An id shape
        // in copy is a copy of a contract, and this is how it drifts.
        detail: "Provide a job id (mi-run-<runId>), or retry a run from the list.",
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

  /**
   * Dismiss one run.
   *
   * ADM-P2-003 — the console has shown a "Run dismissed (operator)" tile over
   * `media_intelligence_run_dismissed_total` since before the route that
   * increments it existed. The route shipped; the control did not, so the
   * counter could only ever read zero and the page was counting an action it
   * did not offer.
   *
   * TWO IDENTIFIERS, AND THEY ARE NOT INTERCHANGEABLE. Retry above sends the
   * BullMQ JOB id; this sends the `media_intelligence_runs` ROW uuid. Both come
   * off the row, separately, so neither control can be handed the other's.
   *
   * THE WORKSPACE IS THE RUN'S, NOT THE OPERATOR'S. `dismissRun` filters on
   * `team_id`, so this must be the workspace that owns the run — unlike Retry
   * and Replay DLQ, where `teamId` is the audit scope and the operator's own
   * workspace is correct. Same field name, three routes, two meanings; sending
   * the operator's workspace here would silently match no row and read as
   * "already dismissed".
   */
  const runDismiss = async (run: MediaRun) => {
    if (actionResult?.kind === "pending") return;
    const ok = await confirm({
      title: "Dismiss this run?",
      description: `Run ${run.runId} is marked DISMISSED and stops appearing as outstanding work. It is not retried and its evidence is untouched. Only a run that is still PENDING, PROCESSING or FAILED can be dismissed.`,
      confirmLabel: "Dismiss run",
      tone: "warning",
      testId: "media-graph-dismiss",
    });
    if (!ok) return;
    setActionResult({ kind: "pending", label: "Dismiss" });
    try {
      await apiFetch(
        `/v1/ops/media-intelligence/runs/${encodeURIComponent(run.runId)}/dismiss`,
        {
          method: "POST",
          body: JSON.stringify({ teamId: run.teamId }),
        },
      );
      setActionResult({
        kind: "success",
        label: "Dismiss",
        detail: `Run ${run.runId} dismissed.`,
      });
      void loadRuns();
    } catch (err) {
      setActionResult({
        kind: "error",
        label: "Dismiss",
        detail: toSafeUserError(err, {
          message: "The run was not dismissed.",
        }).message,
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
          ? error.kind === "denied"
            ? "metrics not permitted"
            : error.kind === "unrecognised"
              ? "metrics not recognised"
              : "metrics unavailable"
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
        <p
          className="apf-note"
          data-tone={error.kind === "error" ? "critical" : "unknown"}
          data-media-graph-metrics-failure={error.kind}
          role={error.kind === "error" ? "alert" : "status"}
        >
          {error.message}
          {snapshot
            ? " The tiles below are the last snapshot this session captured, not the current one."
            : " No snapshot has been captured this session, so the tiles below show no figures."}
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

      {/*
        ADM-P2-005 — the records the actions act on.

        The counters above say how many runs failed. Until this section existed
        they were the whole story: the operator could see "Failed runs 7" and
        had no way to see which seven, so the remediation path documented in the
        runbooks required an id reconstructed from somewhere else.
      */}
      <section className="apf-section" data-media-run-list>
        <h2 className="apf-section-title">Runs</h2>
        <div className="apf-row">
          <div style={{ minWidth: 0 }}>
            <div className="apf-stat-hint">
              Media-intelligence runs across every workspace on this
              deployment, newest first. Each row carries both identifiers the
              actions need.
            </div>
          </div>
          <div style={actionControlStyle}>
            <select
              className="apf-control"
              aria-label="Run status to list"
              value={runStatus}
              data-media-run-status
              onChange={(e) => setRunStatus(e.target.value as RunStatusFilter)}
            >
              {RUN_STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void loadRuns();
              }}
              disabled={runsState.kind === "loading"}
            >
              {runsState.kind === "loading" ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        {/*
          The count, and whether it is all of them.

          `cap` is the 25 the request asks for and `hasMore` is the server's
          own answer, so a truncated page cannot render as a total — the
          failure this component exists to prevent. `filtered` is
          unconditionally true because a status is always applied: there is no
          unfiltered view of this list to confuse an empty result with.
        */}
        <ResultCount
          shown={runs.length}
          cap={25}
          hasMore={runsState.kind === "ok" ? runsState.hasMore : undefined}
          noun="run"
          // Always true: a status is always applied, so there is no unfiltered
          // view of this list whose emptiness could be confused with this one.
          // Written as an explicit value rather than the bare shorthand because
          // the count-truth audit reads `filtered={` — a page can be
          // filter-aware and recorded as not, which is a worse artifact than a
          // page that simply is not.
          filtered={true}
          loading={runsState.kind === "loading"}
          failed={runsState.kind === "failed"}
          data-testid="media-run-count"
        />

        {runsState.kind === "failed" ? (
          <div
            style={actionResultErrorStyle}
            role="status"
            data-media-run-list-failed
          >
            {runsState.detail}
          </div>
        ) : runsState.kind === "loading" ? (
          <div className="apf-stat-hint">Reading runs…</div>
        ) : runs.length === 0 ? (
          <div className="apf-stat-hint" data-media-run-list-empty>
            No runs match the {runStatus} filter. Other statuses may still have
            runs — this list was read successfully and is empty, which is not
            the same as a read that failed.
          </div>
        ) : (
          <>
            <div className="apf-table-wrap">
              <table className="apf-table">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Run</th>
                    <th scope="col">Job</th>
                    <th scope="col">Workspace</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Last error</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.runId} data-media-run-row={run.runId}>
                      <td>{run.status}</td>
                      <td>{run.kind}</td>
                      <td>
                        <IdentifierText value={run.runId} />
                      </td>
                      <td>
                        <IdentifierText value={run.jobId} />
                      </td>
                      <td>
                        <IdentifierText value={run.teamId} />
                      </td>
                      <td>{run.attemptCount}</td>
                      <td>{run.lastError ?? "—"}</td>
                      <td>
                        <div style={actionControlStyle}>
                          <Button
                            variant="secondary"
                            size="sm"
                            data-media-run-retry={run.jobId}
                            onClick={() => {
                              void runRetry(run.jobId);
                            }}
                            disabled={
                              actionResult.kind === "pending" || !teamId
                            }
                          >
                            Retry
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            data-media-run-dismiss={run.runId}
                            onClick={() => {
                              void runDismiss(run);
                            }}
                            disabled={actionResult.kind === "pending"}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runsState.hasMore ? (
              <div className="apf-stat-hint">
                Showing the 25 most recently updated. Narrow by status to see
                the rest.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="apf-section">
        <h2 className="apf-section-title">Operator actions</h2>
        <div className="apf-section">
          <div className="apf-row">
            <div style={{ minWidth: 0 }}>
              <div className="apf-section-title">Retry one job</div>
              <div className="apf-stat-hint">
                Requeues a specific failed BullMQ job by id
                (<code>mi-run-&lt;runId&gt;</code>). Use this for an id you
                already hold; otherwise retry from the run list above.
              </div>
            </div>
            <div style={actionControlStyle}>
              <input
                type="text"
                value={retryRunId}
                placeholder="mi-run-<uuid>"
                aria-label="Failed job id to retry"
                onChange={(e) => setRetryRunId(e.target.value)}
                className="apf-control"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void runRetry();
                }}
                disabled={actionResult.kind === "pending" || !teamId}
              >
                {actionResult.kind === "pending" && actionResult.label === "Retry"
                  ? "Retrying…"
                  : "Retry"}
              </Button>
            </div>
          </div>

          <div className="apf-row" />

          <div className="apf-row">
            <div style={{ minWidth: 0 }}>
              <div className="apf-section-title">Replay DLQ</div>
              <div className="apf-stat-hint">
                Walks up to 50 failed jobs and requeues each. Bounded by
                the server. Operator audit is recorded.
              </div>
            </div>
            <div style={actionControlStyle}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void runReplayDlq();
                }}
                disabled={actionResult.kind === "pending" || !teamId}
              >
                {actionResult.kind === "pending" &&
                actionResult.label === "Replay DLQ"
                  ? "Replaying…"
                  : "Replay DLQ"}
              </Button>
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
          <li key={t.metric} style={tileStyle(t.tone, value)}>
            <div className="apf-stat-label">{t.label}</div>
            <div className="apf-stat-value">
              {value == null ? "—" : formatNumber(value)}
            </div>
            {/* THE METRIC KEY IS PROVENANCE, NOT CONTENT.
                This rendered `MEDIA_INTELLIGENCE_QUEUE_DEPTH (GAUGE)` in
                shouty uppercase at the label's own weight, directly under the
                figure and wrapping across three lines — so the internal
                registry key was the most prominent thing on the tile after
                the number, and the HINT that says what the number means was
                pushed below it.

                It stays on the page, because an operator correlating this
                console with a metrics scrape needs the exact key. It is now
                the lower-case monospace it actually is, at caption size,
                after the hint. */}
            {t.hint ? <div className="apf-stat-hint">{t.hint}</div> : null}
            <div
              className="apf-mono"
              /* 11px is the console's floor, closed everywhere else in this phase
                 and missed here: the responsive sweep reported this key as
                 sub-11px text at every width from 320 up. */
              style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 4 }}
            >
              {/* `media_intelligence_processor_started_total` has no break
                  opportunity in it and this tile is about 120px wide, so
                  eleven of these keys were rendering split mid-word
                  ("...processo / r_started_total"). An operator's next step
                  with a metric key is to grep for it, and a key they cannot
                  read is a key they cannot use. `IdentifierText` offers the
                  break after each underscore and contributes no character, so
                  the value still copies exactly. */}
              <IdentifierText value={t.metric} />
              {t.kind === "gauge" ? " (gauge)" : ""}
            </div>
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
  err: MetricsFailure | null,
  ageSeconds: number | null,
): React.CSSProperties {
  let bg = "var(--info-subtle-bg)";
  let border = "var(--info-border)";
  let color = "var(--info)";
  if (err && err.kind === "error") {
    bg = "var(--danger-subtle-bg)";
    border = "var(--danger-border)";
    color = "var(--danger-strong)";
  } else if (err) {
    /* A refusal and a payload this console cannot read are both NEUTRAL:
       neither is a fault, and colouring them red sends an operator to look
       for an outage that is not there. */
    bg = "var(--surface-muted)";
    border = "var(--border)";
    color = "var(--ink-muted)";
  } else if (ageSeconds != null && ageSeconds > 120) {
    bg = "var(--warning-subtle-bg)";
    border = "var(--warning-border)";
    color = "var(--warning-strong)";
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





/**
 * THE TONE IS THE VALUE'S, NOT THE TILE'S.
 *
 * This took `tone` from a STATIC table on the tile definition and applied it
 * unconditionally — so every "failed", "denied", "dismissed" and "DLQ" tile
 * was tinted amber or red whether or not anything had failed. On a healthy
 * platform, where all fourteen counters read 0, the page rendered ten
 * coloured warning cards and two coloured success cards for a set of measured
 * zeros.
 *
 * That is the defect this phase removed from the Control Center's tiles and
 * from /admin/adoption's badges, in its purest form: a colour that cannot
 * change cannot carry information, and an operator who opens this page during
 * an incident has no way to tell the amber that means something from the
 * amber that is always there.
 *
 * A tone now requires a NON-ZERO value. A zero is a zero, on the plain card
 * ground, in every tile — which is also what makes a single amber tile
 * findable at a glance.
 */
function tileStyle(
  tone: Tile["tone"] | undefined,
  value: number | null,
): React.CSSProperties {
  const palette: Record<NonNullable<Tile["tone"]>, [string, string]> = {
    ok: ["var(--success-subtle-bg)", "var(--success-border)"],
    info: ["var(--info-subtle-bg)", "var(--info-border)"],
    warn: ["var(--warning-subtle-bg)", "var(--warning-border)"],
    danger: ["var(--danger-subtle-bg)", "var(--danger-border)"],
  };
  const earned = tone != null && value != null && value > 0;
  const [bg, border] = earned
    ? palette[tone]
    : ["var(--surface-card)", "var(--border-default)"];
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



const actionResultSuccessStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  background: "var(--success-subtle-bg)",
  border: "1px solid var(--success-border)",
  color: "var(--success-strong)",
  borderRadius: 6,
};

const actionResultErrorStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  background: "var(--danger-subtle-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger-strong)",
  borderRadius: 6,
};
