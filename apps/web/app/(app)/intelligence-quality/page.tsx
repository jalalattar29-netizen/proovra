"use client";

/**
 * PROOVRA Phase 3B Enterprise Closure — Intelligence Quality Dashboard.
 *
 * Surfaces provider / reviewer / team quality analytics. Bounded
 * counts + bands + rank only — never raw extraction text.
 */

import { useCallback, useEffect, useState } from "react";

import {
  EXECUTIVE_METRICS_RANGES,
  type ExecutiveMetricsRange,
  type ProviderQualityProjection,
  type ProviderQualityRow,
  type ReviewerQualityProjection,
  type ReviewerQualityRow,
  type TeamQualityProjection,
  type TeamQualityRow,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";
import { IntelligenceRecordsPanel } from "./_sections/IntelligenceRecordsPanel";

export default function IntelligenceQualityPage() {
  return (
    <PageRouteGate routeId="workspace.intelligence_quality">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [range, setRange] = useState<ExecutiveMetricsRange>("7d");
  const [providers, setProviders] = useState<ProviderQualityProjection | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerQualityProjection | null>(null);
  const [teams, setTeams] = useState<TeamQualityProjection | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [p, r, t] = await Promise.all([
        apiFetch(`/v1/intelligence/quality/providers?range=${range}`, { method: "GET" }),
        apiFetch(`/v1/intelligence/quality/reviewers?range=${range}`, { method: "GET" }),
        apiFetch(`/v1/intelligence/quality/teams?range=${range}`, { method: "GET" }),
      ]);
      setProviders((p?.projection ?? null) as ProviderQualityProjection | null);
      setReviewers((r?.projection ?? null) as ReviewerQualityProjection | null);
      setTeams((t?.projection ?? null) as TeamQualityProjection | null);
    } catch {
      setProviders(null);
      setReviewers(null);
      setTeams(null);
    } finally {
      setBusy(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-intelligence-quality
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Intelligence Quality</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Provider · reviewer · team correction analytics. Aggregate-only ·
          NEVER raw extraction.
        </p>
      </header>

      <div
        data-intelligence-quality-range-bar
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
            data-intelligence-quality-range={r}
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
          data-intelligence-quality-refresh
          disabled={busy}
          onClick={() => void refresh()}
          style={primaryButton}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <section data-intelligence-quality-providers style={section}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Provider quality ranking</h2>
        <ProviderTable rows={providers?.rows ?? []} />
      </section>

      <section data-intelligence-quality-reviewers style={section}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Reviewer quality</h2>
        <ReviewerTable rows={reviewers?.rows ?? []} />
      </section>

      <section data-intelligence-quality-teams style={section}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Workspace + case quality</h2>
        <TeamTable rows={teams?.rows ?? []} />
      </section>

      {/* PHASE 12 — VERTICAL B. Record-level inspection + the immutable
          correction chain. Mounted HERE, on the restricted governance
          surface, rather than on a general reviewer page: a correction
          rewrites what the platform believes an extraction says, and the
          chain behind it is an audit artefact. */}
      <IntelligenceRecordsPanel />
    </div>
  );
}

function ProviderTable({ rows }: { rows: ReadonlyArray<ProviderQualityRow> }) {
  if (rows.length === 0) {
    return <p style={{ color: "#475569", fontSize: 12 }}>No provider activity in window.</p>;
  }
  return (
    <table data-intelligence-quality-provider-table style={tableStyle}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>Rank</th>
          <th style={th}>Provider</th>
          <th style={th}>Calls</th>
          <th style={th}>Failure %</th>
          <th style={th}>Records</th>
          <th style={th}>Correction %</th>
          <th style={th}>Revert %</th>
          <th style={th}>Confidence accuracy</th>
          <th style={th}>Score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.provider} data-intelligence-quality-provider-row={r.provider}>
            <td style={td}>#{r.rank}</td>
            <td style={td}><code>{r.provider}</code></td>
            <td style={td}>{r.callCount}</td>
            <td style={td}>{r.failureRatePct}%</td>
            <td style={td}>{r.recordCount}</td>
            <td style={td}>{r.correctionRatePct}%</td>
            <td style={td}>{r.revertRatePct}%</td>
            <td style={td}>{(r.confidenceAccuracy * 100).toFixed(0)}%</td>
            <td style={td}>{(r.rankingScore * 100).toFixed(0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReviewerTable({ rows }: { rows: ReadonlyArray<ReviewerQualityRow> }) {
  if (rows.length === 0) {
    return <p style={{ color: "#475569", fontSize: 12 }}>No reviewer activity in window.</p>;
  }
  return (
    <table data-intelligence-quality-reviewer-table style={tableStyle}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>Reviewer</th>
          <th style={th}>Authored</th>
          <th style={th}>Accepted</th>
          <th style={th}>Reverted</th>
          <th style={th}>Acceptance %</th>
          <th style={th}>Revert %</th>
          <th style={th}>Agreement %</th>
          <th style={th}>Median latency ms</th>
          <th style={th}>Quality score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.reviewerUserId} data-intelligence-quality-reviewer-row={r.reviewerUserId}>
            <td style={td}><code>{r.reviewerUserId.slice(0, 8)}…</code></td>
            <td style={td}>{r.correctionsAuthored}</td>
            <td style={td}>{r.correctionsAccepted}</td>
            <td style={td}>{r.correctionsReverted}</td>
            <td style={td}>{r.acceptanceRatePct}%</td>
            <td style={td}>{r.revertRatePct}%</td>
            <td style={td}>{r.agreementRatePct}%</td>
            <td style={td}>{r.medianAcceptLatencyMs}</td>
            <td style={td}>{r.qualityScore}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TeamTable({ rows }: { rows: ReadonlyArray<TeamQualityRow> }) {
  if (rows.length === 0) {
    return <p style={{ color: "#475569", fontSize: 12 }}>No team data in window.</p>;
  }
  return (
    <table data-intelligence-quality-team-table style={tableStyle}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>Scope</th>
          <th style={th}>Target</th>
          <th style={th}>Records</th>
          <th style={th}>Corrections</th>
          <th style={th}>Density</th>
          <th style={th}>Accepted</th>
          <th style={th}>Rejected</th>
          <th style={th}>Avg confidence</th>
          <th style={th}>Quality score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`${r.scope}:${r.scopeTargetId}`}
            data-intelligence-quality-team-row={`${r.scope}:${r.scopeTargetId}`}
          >
            <td style={td}>{r.scope}</td>
            <td style={td}><code>{r.scopeTargetId.slice(0, 8)}…</code></td>
            <td style={td}>{r.recordCount}</td>
            <td style={td}>{r.correctionCount}</td>
            <td style={td}>{r.correctionDensity}%</td>
            <td style={td}>{r.acceptedCount}</td>
            <td style={td}>{r.rejectedCount}</td>
            <td style={td}>{r.averageProviderConfidence}</td>
            <td style={td}>{r.reviewQualityScore}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
const section = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  overflowX: "auto" as const,
};
const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 };
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
