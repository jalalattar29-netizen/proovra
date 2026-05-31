"use client";

/**
 * PROOVRA Phase 2A — Reviewer metrics surface.
 *
 * Bounded team-wide metric ribbon. Per-reviewer metrics surface on
 * the workspace ribbon; this page is the supervisor/ops view of
 * aggregate throughput + accuracy.
 */

import { useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { fetchReviewerMetrics } from "../../../../lib/reviewer-workspace/reviewer-api";

export default function MetricsPage() {
  return (
    <PageRouteGate routeId="workspace.review_metrics">
      <MetricsShell />
    </PageRouteGate>
  );
}

function MetricsShell() {
  const [metrics, setMetrics] = useState<{
    throughput7d: number;
    approvalRate7dPct: number;
    escalationRate7dPct: number;
    disagreementRate7dPct: number;
    qcFailureRate7dPct: number;
    avgReviewDurationMs7d: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await fetchReviewerMetrics();
      if (!cancelled) setMetrics(m);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      data-reviewer-metrics-page
      style={{ padding: 24, maxWidth: 900, margin: "0 auto", color: "#0f172a" }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Reviewer metrics (7d)</h1>
      <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
        Operational metrics describing reviewer activity. Not authenticity
        claims about content; not legal weight.
      </p>
      {metrics === null ? (
        <div>Loading metrics…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginTop: 14,
          }}
        >
          <MetricCard label="Throughput" value={metrics.throughput7d} />
          <MetricCard label="Approval rate" value={`${metrics.approvalRate7dPct}%`} />
          <MetricCard label="Escalation rate" value={`${metrics.escalationRate7dPct}%`} />
          <MetricCard label="Disagreement rate" value={`${metrics.disagreementRate7dPct}%`} />
          <MetricCard label="QC failure rate" value={`${metrics.qcFailureRate7dPct}%`} />
          <MetricCard
            label="Avg review duration"
            value={`${Math.round(metrics.avgReviewDurationMs7d / 1000)}s`}
          />
        </div>
      )}
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
