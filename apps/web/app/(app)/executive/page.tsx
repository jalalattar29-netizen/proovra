"use client";

/**
 * PROOVRA Phase 3B — Executive Dashboard.
 *
 * Phase 3B Enterprise Closure: snapshot tiles are replaced by trend
 * cards, with a bounded range selector (24h / 7d / 30d / 90d / 12m).
 * Every numeric metric shows current value, previous-period value,
 * delta % and trend direction.
 *
 * Hard rules:
 *   * NEVER per-user / per-document detail.
 *   * Standing limitations rendered in the footer.
 *   * Reads round-trip through `/v1/executive/trends` —
 *     the UI never reconstructs trends client-side.
 */

import { useCallback, useEffect, useState } from "react";

import {
  EXECUTIVE_METRICS_RANGES,
  type ExecutiveMetricsRange,
  type ExecutiveTrendsProjection,
  type TrendDirection,
  type TrendMetric,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";

export default function ExecutiveDashboardPage() {
  return (
    <PageRouteGate routeId="workspace.executive">
      <ExecutiveDashboardShell />
    </PageRouteGate>
  );
}

function ExecutiveDashboardShell() {
  const [trends, setTrends] = useState<ExecutiveTrendsProjection | null>(null);
  const [range, setRange] = useState<ExecutiveMetricsRange>("7d");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/v1/executive/trends?range=${range}`, {
        method: "GET",
      });
      setTrends((res?.trends ?? null) as ExecutiveTrendsProjection | null);
    } catch {
      setTrends(null);
    } finally {
      setBusy(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-executive-dashboard
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Executive Dashboard</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Cross-domain enterprise metrics with historical trend.
          Aggregate-only · NEVER PII.
        </p>
      </header>

      <div
        data-executive-range-bar
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 14,
          padding: 8,
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 11, color: "#475569" }}>Range</span>
        {EXECUTIVE_METRICS_RANGES.map((r) => (
          <button
            type="button"
            key={r}
            data-executive-range-button={r}
            data-active={r === range ? "true" : "false"}
            onClick={() => setRange(r)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border:
                r === range
                  ? "1px solid #0f172a"
                  : "1px solid rgba(15, 23, 42, 0.18)",
              background: r === range ? "#0f172a" : "#fff",
              color: r === range ? "#fafafa" : "#0f172a",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {r}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-executive-refresh
          disabled={busy}
          onClick={() => void refresh()}
          style={primaryButton}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {!trends ? (
        <p style={{ color: "#475569" }}>Loading executive trends…</p>
      ) : (
        <>
          <p style={{ color: "#475569", fontSize: 11, margin: "0 0 10px" }}>
            Current window {formatUserDateTime(trends.windowStartUtc)} →{" "}
            {formatUserDateTime(trends.windowEndUtc)} · Comparison
            window {formatUserDateTime(trends.previousWindowStartUtc)} →{" "}
            {formatUserDateTime(trends.previousWindowEndUtc)}
          </p>

          <div style={{ display: "grid", gap: 12 }}>
            <Family title="Capture" data-attr="data-executive-capture">
              <TrendTile label="Captures" metric={trends.capture.captures} />
              <TrendTile
                label="Capture success rate %"
                metric={trends.capture.captureSuccessRatePct}
                suffix="%"
              />
              <TrendTile
                label="Mobile signed ratio %"
                metric={trends.capture.mobileSignedRatio}
                suffix="%"
              />
              <TrendTile
                label="High-trust captures"
                metric={trends.capture.highTrustCaptures}
              />
            </Family>

            <Family title="Review" data-attr="data-executive-review">
              <TrendTile label="Reviewed" metric={trends.review.reviewed} />
              <TrendTile
                label="Approval rate %"
                metric={trends.review.approvalRatePct}
                suffix="%"
              />
              <TrendTile
                label="QC accuracy %"
                metric={trends.review.qcAccuracyPct}
                suffix="%"
              />
              <TrendTile
                label="Avg review duration ms"
                metric={trends.review.averageReviewDurationMs}
              />
            </Family>

            <Family title="Evidence" data-attr="data-executive-evidence">
              <TrendTile
                label="Total evidence"
                metric={trends.evidence.totalEvidence}
              />
              <TrendTile
                label="Storage bytes"
                metric={trends.evidence.storageBytes}
              />
            </Family>

            <Family
              title="Verification"
              data-attr="data-executive-verification"
            >
              <TrendTile
                label="Verifications"
                metric={trends.verification.verifications}
              />
              <TrendTile
                label="Public verify views"
                metric={trends.verification.publicVerifyViews}
              />
              <TrendTile
                label="Success rate %"
                metric={trends.verification.successRatePct}
                suffix="%"
              />
            </Family>

            <Family title="AI Intelligence" data-attr="data-executive-ai">
              <TrendTile
                label="Provider calls"
                metric={trends.ai.providerCalls}
              />
              <TrendTile
                label="Estimated cost USD"
                metric={trends.ai.estimatedCostUsd}
                prefix="$"
              />
              <TrendTile
                label="Corrections"
                metric={trends.ai.corrections}
              />
              <TrendTile
                label="Avg provider confidence"
                metric={trends.ai.averageProviderConfidence}
              />
            </Family>

            <Family title="SLA / Reliability" data-attr="data-executive-sla">
              <TrendTile
                label="Job failure rate %"
                metric={trends.sla.jobFailureRatePct}
                suffix="%"
              />
              <TrendTile
                label="Provider availability %"
                metric={trends.sla.providerAvailabilityPct}
                suffix="%"
              />
            </Family>

            <Family title="Cost Governance" data-attr="data-executive-cost">
              <TrendTile
                label="Total cost USD"
                metric={trends.cost.totalCostUsd}
                prefix="$"
              />
              <TrendTile
                label="Blocked calls"
                metric={trends.cost.blockedCalls}
              />
              <TrendTile
                label="Budget breaches"
                metric={trends.cost.budgetBreaches}
              />
            </Family>

            <Family
              title="Correction Lifecycle"
              data-attr="data-executive-corrections"
            >
              <TrendTile
                label="Created"
                metric={trends.corrections.created}
              />
              <TrendTile
                label="Accepted"
                metric={trends.corrections.accepted}
              />
              <TrendTile
                label="Reverted"
                metric={trends.corrections.reverted}
              />
              <TrendTile
                label="Superseded"
                metric={trends.corrections.superseded}
              />
            </Family>
          </div>

          <footer
            data-executive-limitations
            style={{
              marginTop: 18,
              padding: 10,
              background: "rgba(15, 23, 42, 0.04)",
              border: "1px dashed rgba(15, 23, 42, 0.18)",
              borderRadius: 8,
              fontSize: 11,
              color: "#475569",
            }}
          >
            <strong style={{ color: "#0f172a" }}>Standing limitations</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {trends.limitations.map((l) => (
                <li key={l}>
                  <code>{l}</code>
                </li>
              ))}
            </ul>
          </footer>
        </>
      )}
    </div>
  );
}

function Family({
  title,
  "data-attr": dataAttr,
  children,
}: {
  title: string;
  "data-attr": string;
  children: React.ReactNode;
}) {
  return (
    <section
      {...({ [dataAttr]: "" } as Record<string, string>)}
      style={{
        padding: 12,
        background: "rgba(15, 23, 42, 0.03)",
        border: "1px solid rgba(15, 23, 42, 0.06)",
        borderRadius: 10,
      }}
    >
      <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>
        {title}
      </strong>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function TrendTile({
  label,
  metric,
  prefix,
  suffix,
}: {
  label: string;
  metric: TrendMetric;
  prefix?: string;
  suffix?: string;
}) {
  const arrow = directionArrow(metric.direction);
  const color = directionColor(metric.direction);
  return (
    <div
      data-executive-trend-tile={label}
      data-trend-direction={metric.direction}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <small style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>
        {label}
      </small>
      <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>
        {prefix ?? ""}
        {formatValue(metric.current)}
        {suffix ?? ""}
      </strong>
      <div style={{ marginTop: 4, fontSize: 11, color }}>
        <span data-executive-trend-arrow={metric.direction}>{arrow}</span>{" "}
        <span data-executive-trend-delta={label}>
          {metric.delta >= 0 ? "+" : ""}
          {formatValue(metric.delta)}
          {suffix ?? ""}
        </span>{" "}
        <span data-executive-trend-pct={label}>
          ({metric.deltaPct >= 0 ? "+" : ""}
          {metric.deltaPct.toFixed(1)}%)
        </span>
      </div>
      <div style={{ marginTop: 2, fontSize: 10, color: "#94a3b8" }}>
        prev: {prefix ?? ""}
        {formatValue(metric.previous)}
        {suffix ?? ""}
      </div>
    </div>
  );
}

function directionArrow(d: TrendDirection): string {
  if (d === "UP") return "▲";
  if (d === "DOWN") return "▼";
  return "■";
}

function directionColor(d: TrendDirection): string {
  if (d === "UP") return "#15803d";
  if (d === "DOWN") return "#b91c1c";
  return "#475569";
}

function formatValue(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.round(n * 100) / 100}`;
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
