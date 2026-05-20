"use client";

/**
 * Phase 31.7 + 32.6 — Media intelligence + investigation graph
 * operations console.
 *
 * Workspace-internal operator surface that pins the Phase 31.6 queue
 * counters/gauges and the Phase 32.5 graph query counters onto a
 * single dashboard. Consumes the existing `/v1/ops/metrics` endpoint
 * — no new server routes; this page is purely a projection of the
 * in-process metrics registry.
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

import { apiFetch } from "../../../../lib/api";

type MetricsSnapshot = {
  uptimeSeconds: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
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

export default function MediaGraphOpsPage() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [retryRunId, setRetryRunId] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult>({
    kind: "idle",
  });

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (!cancelled) setTeamId(r?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = (await apiFetch("/v1/ops/metrics", {
          method: "GET",
        })) as MetricsSnapshot;
        if (!cancelled) {
          setSnapshot(res);
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
  const runRetry = async () => {
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
      setActionResult({
        kind: "error",
        label: "Retry",
        detail:
          err instanceof Error
            ? `Request failed: ${err.message.slice(0, 160)}`
            : "Request failed.",
      });
    }
  };

  const runReplayDlq = async () => {
    if (!teamId) {
      setActionResult({
        kind: "error",
        label: "Replay DLQ",
        detail: "Workspace context unavailable.",
      });
      return;
    }
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
        detail:
          err instanceof Error
            ? `Request failed: ${err.message.slice(0, 160)}`
            : "Request failed.",
      });
    }
  };

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Media intelligence &amp; graph operations</h1>
          <p style={subtitleStyle}>
            Live counters and gauges for the media-intelligence async queue
            and the investigation graph query surfaces.
          </p>
        </div>
        <span style={freshnessPillStyle(error, ageSeconds)}>
          {error
            ? "metrics unavailable"
            : ageSeconds == null
              ? "loading…"
              : `updated ${ageSeconds}s ago`}
        </span>
      </header>

      {error ? (
        <p style={errorBannerStyle}>
          Metrics endpoint did not respond. Tiles below show the most
          recent successful snapshot if one was captured this session.
        </p>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Run lifecycle</h2>
        <TileGrid tiles={MEDIA_INTELLIGENCE_TILES} snapshot={snapshot} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Queue + processor counters</h2>
        <TileGrid tiles={MEDIA_INTELLIGENCE_COUNTERS} snapshot={snapshot} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Investigation graph</h2>
        <TileGrid tiles={GRAPH_TILES} snapshot={snapshot} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Operator actions</h2>
        <div style={actionsCardStyle}>
          <div style={actionRowStyle}>
            <div style={actionLabelStyle}>
              <div style={actionTitleStyle}>Retry one job</div>
              <div style={actionHintStyle}>
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
                onChange={(e) => setRetryRunId(e.target.value)}
                style={inputStyle}
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

          <div style={actionRowDividerStyle} />

          <div style={actionRowStyle}>
            <div style={actionLabelStyle}>
              <div style={actionTitleStyle}>Replay DLQ</div>
              <div style={actionHintStyle}>
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

      <p style={footerNoteStyle}>
        Numbers are advisory operational telemetry. They do not classify
        the recorded material and they do not establish legal weight; the
        canonical custody record remains the authoritative integrity
        artifact.
      </p>
    </div>
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
    <ul style={gridStyle}>
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
            <div style={tileLabelStyle}>{t.label}</div>
            <div style={tileValueStyle}>
              {value == null ? "—" : formatNumber(value)}
            </div>
            <div style={tileMetricNameStyle} title={t.hint}>
              {t.metric}
              {t.kind === "gauge" ? " (gauge)" : ""}
            </div>
            {t.hint ? <div style={tileHintStyle}>{t.hint}</div> : null}
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

const pageStyle: React.CSSProperties = {
  padding: 24,
  maxWidth: 1280,
  margin: "0 auto",
  fontFamily:
    "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  color: "#0f172a",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 20,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
};

const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 13,
  color: "#64748b",
};

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

const errorBannerStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  margin: "0 0 16px 0",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 24,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: 14,
  fontWeight: 700,
  color: "#334155",
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

const gridStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: 10,
};

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

const tileLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const tileValueStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  margin: "4px 0",
  color: "#0f172a",
};

const tileMetricNameStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#94a3b8",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const tileHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#475569",
  marginTop: 6,
  lineHeight: 1.4,
};

const footerNoteStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 11,
  color: "#64748b",
  textAlign: "center",
};

// ---------------------------------------------------------------------------
// Phase 31.9 — operator action panel styles
// ---------------------------------------------------------------------------

const actionsCardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 16,
  background: "#ffffff",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
};

const actionRowDividerStyle: React.CSSProperties = {
  height: 1,
  background: "#e5e7eb",
  margin: "4px 0",
};

const actionLabelStyle: React.CSSProperties = {
  flex: "1 1 320px",
  minWidth: 240,
};

const actionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#0f172a",
  marginBottom: 4,
};

const actionHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.4,
};

const actionControlStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: 8,
  alignItems: "center",
  flex: "1 1 280px",
  minWidth: 240,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  fontSize: 12,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
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
