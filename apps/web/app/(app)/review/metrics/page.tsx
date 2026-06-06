"use client";

/**
 * PROOVRA Phase 2A — Reviewer metrics surface.
 *
 * Bounded team-wide metric ribbon. Per-reviewer metrics surface on
 * the workspace ribbon; this page is the supervisor/ops view of
 * aggregate throughput + accuracy.
 *
 * PHASE 4 hardening — Phase 0 identified that this page stuck on
 * "Loading metrics…" forever when the backend returned a 403 (catch
 * was absent and metrics stayed null). It also failed to distinguish
 * EMPTY (all-zero metrics, e.g. workspace has no activity) from a
 * generic failure.
 *
 * The page now models four bounded states and never leaks any data
 * when the user is FORBIDDEN:
 *
 *   - LOADING  — initial fetch in flight.
 *   - FORBIDDEN — 403 NOT_PERMITTED. Render explanation panel only.
 *   - ERROR    — network error / 500 / parse error. Retry control.
 *   - READY    — 200 response. May be EMPTY (all-zero) — surfaced via
 *                an empty-state line above the metric grid.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { OperationalEmptyState } from "../../../../components/operational";
import { fetchReviewerMetrics } from "../../../../lib/reviewer-workspace/reviewer-api";

type Metrics = {
  throughput7d: number;
  approvalRate7dPct: number;
  escalationRate7dPct: number;
  disagreementRate7dPct: number;
  qcFailureRate7dPct: number;
  avgReviewDurationMs7d: number;
};

type FetchState =
  | { kind: "LOADING" }
  | { kind: "FORBIDDEN" }
  | { kind: "ERROR" }
  | { kind: "READY"; metrics: Metrics };

// A metric response is considered EMPTY when every numeric / pct
// metric is exactly zero. This matches "no reviewer activity in the
// last 7 days for this workspace" rather than a 403 (which is
// modelled as FORBIDDEN, never a fake empty grid).
function isMetricsEmpty(m: Metrics): boolean {
  return (
    m.throughput7d === 0 &&
    m.approvalRate7dPct === 0 &&
    m.escalationRate7dPct === 0 &&
    m.disagreementRate7dPct === 0 &&
    m.qcFailureRate7dPct === 0 &&
    m.avgReviewDurationMs7d === 0
  );
}

export default function MetricsPage() {
  return (
    <PageRouteGate routeId="workspace.review_metrics">
      <MetricsShell />
    </PageRouteGate>
  );
}

function MetricsShell() {
  const teamId = useActiveSpaceId();
  const [state, setState] = useState<FetchState>({ kind: "LOADING" });
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setState({ kind: "ERROR" });
      return;
    }
    setState({ kind: "LOADING" });
    try {
      const m = await fetchReviewerMetrics(teamId);
      setState({ kind: "READY", metrics: m });
      setLoadedAt(new Date().toISOString());
    } catch (err) {
      // Structured warn — silent failure is forbidden.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.statusCode ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = ((err as any)?.code ?? "UNKNOWN") as string;
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] metrics fetch failed", {
        status,
        code,
      });
      if (status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") {
        setState({ kind: "FORBIDDEN" });
      } else {
        setState({ kind: "ERROR" });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!teamId) {
    return (
      <div
        data-reviewer-metrics-page
        style={{ padding: 24, maxWidth: 900, margin: "0 auto", color: "#0f172a" }}
      >
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading reviewer metrics."
        />
      </div>
    );
  }

  return (
    <div
      data-reviewer-metrics-page
      data-reviewer-metrics-state={state.kind}
      style={{ padding: 24, maxWidth: 900, margin: "0 auto", color: "#0f172a" }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Reviewer metrics (7d)</h1>
      <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
        Operational metrics describing reviewer activity. Not authenticity
        claims about content; not legal weight.
      </p>
      <div
        style={{
          marginTop: 12,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid #e2e8f0",
          background: "#f8fafc",
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          color: "#475569",
          fontSize: 12,
        }}
      >
        <strong style={{ color: "#0f172a" }}>Scope</strong>
        <span>Workspace-wide reviewer activity</span>
        <span>Period: last 7 days</span>
        <span>Updated: {loadedAt ? new Date(loadedAt).toLocaleString() : "Not yet loaded"}</span>
      </div>

      {state.kind === "LOADING" ? (
        <div data-reviewer-metrics-loading style={mutedStyle}>
          Loading reviewer metrics…
        </div>
      ) : null}

      {state.kind === "FORBIDDEN" ? (
        <div
          data-reviewer-metrics-forbidden
          style={{
            marginTop: 14,
            padding: "12px 14px",
            background: "rgba(15, 23, 42, 0.04)",
            border: "1px solid rgba(15, 23, 42, 0.12)",
            borderRadius: 10,
            color: "#0f172a",
            fontSize: 13,
          }}
        >
          You do not have permission to view team-wide reviewer
          metrics. Ask a workspace administrator or supervisor.
        </div>
      ) : null}

      {state.kind === "ERROR" ? (
        <div
          data-reviewer-metrics-error
          style={{
            marginTop: 14,
            padding: "12px 14px",
            background: "rgba(220, 38, 38, 0.08)",
            border: "1px solid rgba(220, 38, 38, 0.32)",
            borderRadius: 10,
            color: "#7f1d1d",
            fontSize: 13,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>Could not load reviewer metrics — please retry.</span>
          <button
            type="button"
            data-reviewer-metrics-retry
            onClick={() => void load()}
            style={{
              background: "#fff",
              border: "1px solid #fecaca",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
              color: "#7f1d1d",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "READY" ? (
        <>
          {isMetricsEmpty(state.metrics) ? (
            <div
              data-reviewer-metrics-empty
              style={{
                marginTop: 14,
                padding: "12px 14px",
                background: "rgba(15, 23, 42, 0.03)",
                border: "1px dashed rgba(15, 23, 42, 0.18)",
                borderRadius: 10,
                color: "#475569",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              No reviewer activity in the last 7 days for this workspace. The
              cards stay visible below so this reads as a true zero state, not a
              hidden or broken metric fetch.{" "}
              <Link href="/review/queues?queue=UNASSIGNED" style={{ color: "#0f172a" }}>
                Open reviewer queues
              </Link>{" "}
              or{" "}
              <Link href="/reviewer-ops/sla" style={{ color: "#0f172a" }}>
                review SLA pressure
              </Link>
              .
            </div>
          ) : null}
          <div
            data-reviewer-metrics-grid
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginTop: 14,
            }}
          >
            <MetricCard label="Throughput" value={state.metrics.throughput7d} />
            <MetricCard
              label="Approval rate"
              value={`${state.metrics.approvalRate7dPct}%`}
            />
            <MetricCard
              label="Escalation rate"
              value={`${state.metrics.escalationRate7dPct}%`}
            />
            <MetricCard
              label="Disagreement rate"
              value={`${state.metrics.disagreementRate7dPct}%`}
            />
            <MetricCard
              label="QC failure rate"
              value={`${state.metrics.qcFailureRate7dPct}%`}
            />
            <MetricCard
              label="Avg review duration"
              value={`${Math.round(state.metrics.avgReviewDurationMs7d / 1000)}s`}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      data-reviewer-metric-card={label}
      style={{
        padding: "14px 16px",
        background: "#fff",
        borderRadius: 12,
        border: "1px solid rgba(15, 23, 42, 0.08)",
      }}
    >
      <div style={{ fontSize: 11, color: "#475569" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const mutedStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 13,
  marginTop: 14,
};
