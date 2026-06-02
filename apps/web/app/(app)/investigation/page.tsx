"use client";

/**
 * Phase 31.12 — Investigation Intelligence Overview dashboard.
 *
 * Surface #12 of 12 in the brief's investigation workstation list.
 * Aggregates real workspace data:
 *
 *   * Signal totals (by severity + by status) — from the new
 *     /v1/investigation/overview endpoint.
 *   * Recent non-dismissed signals — bounded list, severity-ordered.
 *   * Recent graph activity — bounded list of new nodes + edges.
 *   * Queue health — gauges from the existing /v1/ops/metrics
 *     endpoint (reused from /ops/media-graph).
 *
 * Hard rules:
 *   * Tone is operational only. No forbidden vocabulary
 *     (tampered/forged/fake/authentic/admissible/proves/confirms/
 *     manipulated/doctored).
 *   * No fake counters — when a metric is absent, render "—" not
 *     zero.
 *   * No storage internals, no signed URLs, no internal IDs in any
 *     UI literal (signal evidence IDs are link targets only, never
 *     displayed as raw text).
 *   * Polling bounded at 60 s; paused when tab is hidden.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { useCan, useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { HubQuickActionsBar } from "../../../components/hubs/HubQuickActionsBar";
// Phase 13 — typed cross-evidence findings client.
import {
  getCrossEvidenceFindings,
  type CrossEvidenceFinding,
} from "../../../lib/api/intelligence";
// =============================================================================
// Types
// =============================================================================

type Severity = "ATTENTION" | "REVIEW_RECOMMENDED" | "INFO";
type Confidence = "LOW" | "MEDIUM" | "HIGH";
type Status = "PENDING" | "ACKNOWLEDGED" | "DISMISSED";

type Totals = {
  signalsTotal: number;
  attention: number;
  reviewRecommended: number;
  info: number;
  pending: number;
  acknowledged: number;
  dismissed: number;
};

type RecentSignal = {
  id: string;
  signalType: string;
  evidenceId: string;
  severity: Severity;
  confidence: Confidence;
  status: Status;
  safeSummary: string;
  createdAtUtc: string;
};

type GraphActivityEvent = {
  id: string;
  kind: "NODE_CREATED" | "EDGE_CREATED";
  atUtc: string;
  summary: string;
};

type OverviewResponse = {
  teamId: string;
  totals: Totals;
  recentSignals: RecentSignal[];
  recentGraphActivity: GraphActivityEvent[];
};

type MetricsSnapshot = {
  uptimeSeconds: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
};

// Phase 12 — Reviewer-activity summary. Pulls the existing
// `/v1/investigation/reviewers` endpoint so the overview surface
// shows headline counts and deep-links into the full console rather
// than the operator having to navigate blind.
type ReviewerActivitySummary = {
  workflowTotals?: {
    total: number;
    notStarted: number;
    inProgress: number;
    escalated: number;
    paused: number;
    completed: number;
    rejected: number;
  };
  escalationTotals?: {
    total: number;
    open: number;
    acknowledged: number;
    reassigned: number;
    resolved: number;
    suppressed: number;
  };
  externalReviewTotals?: {
    total: number;
    invited: number;
    active: number;
    expired: number;
    revoked: number;
  };
  indexingTotals?: {
    ocrAvailable: number;
    ocrIndexed: number;
    transcriptAvailable: number;
    transcriptIndexed: number;
  };
};

// =============================================================================
// Page
// =============================================================================

// Phase 38.11 — wrap in canonical PageRouteGate.
// R6 — Investigation Center hub bar above the existing overview
// (unchanged). The bar is the canonical hub HEADER; the rich
// existing Phase 31.12 overview content stays below.
export default function InvestigationOverviewPage() {
  return (
    <PageRouteGate routeId="investigation.hub">
      <div data-hub-page data-hub-page-id="investigation">
        <HubQuickActionsBar hubId="investigation" />
        <InvestigationOverviewPageInner />
      </div>
    </PageRouteGate>
  );
}

function InvestigationOverviewPageInner() {
  const teamId = useTeamId();
  // STAGE 2 — /ops/media-graph maps to OBSERVABILITY_VIEW in the
  // canonical route registry. The "Open operations console" pivot
  // below is the only deep-link off this page into an ops surface
  // and must be hidden for actors without the capability.
  const canObservability = useCan("OBSERVABILITY_VIEW");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  // Phase 12 — Reviewer-activity summary read from the existing
  // `/v1/investigation/reviewers` endpoint. Soft-fail to null so a
  // missing permission collapses to bounded empty copy.
  const [reviewerActivity, setReviewerActivity] =
    useState<ReviewerActivitySummary | null>(null);
  // Phase 13 — Cross-evidence findings (workspace-wide entity tuples
  // that appear on more than one evidence record). Soft-fail to null
  // so a missing permission or empty workspace collapses to bounded
  // empty copy.
  const [crossEvidence, setCrossEvidence] = useState<
    CrossEvidenceFinding[] | null
  >(null);

  // Resolve workspace once.
  
// Bounded poll: workspace data + metrics every 60 s while visible.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const [ov, met] = await Promise.all([
          apiFetch(
            `/v1/investigation/overview?teamId=${encodeURIComponent(teamId)}`,
            { method: "GET" },
          ) as Promise<OverviewResponse>,
          apiFetch("/v1/ops/metrics", { method: "GET" }) as Promise<
            MetricsSnapshot
          >,
        ]);
        if (cancelled) return;
        setOverview(ov);
        setMetrics(met);
        setLastFetchAt(Date.now());
        setError(null);
      } catch {
        if (!cancelled) setError("overview_unavailable");
      }
      // Phase 12 — reviewer activity summary is a second, independent
      // fetch so a permission-denied here doesn't poison the rest of
      // the overview page.
      try {
        const reviewers = (await apiFetch(
          `/v1/investigation/reviewers?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as ReviewerActivitySummary;
        if (!cancelled) setReviewerActivity(reviewers ?? null);
      } catch {
        if (!cancelled) setReviewerActivity(null);
      }
      // Phase 13 — cross-evidence findings via the typed client.
      // Third independent fetch; null on any failure → empty state.
      try {
        const ce = await getCrossEvidenceFindings(teamId, 20);
        if (!cancelled) setCrossEvidence(ce?.findings ?? null);
      } catch {
        if (!cancelled) setCrossEvidence(null);
      }
    };

    void load();
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [teamId]);

  const ageSeconds = useMemo(() => {
    if (!lastFetchAt) return null;
    return Math.floor((Date.now() - lastFetchAt) / 1000);
  }, [lastFetchAt]);

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Investigation Intelligence Overview</h1>
          <p style={subtitleStyle}>
            Workspace-wide advisory observations and recent graph activity.
            Numbers are operational telemetry; they do not classify recorded
            material and they do not establish legal weight.
          </p>
        </div>
        <span style={freshnessPillStyle(error, ageSeconds, teamId)}>
          {error
            ? "No analyses recorded yet"
            : !teamId
              ? "loading workspace…"
              : ageSeconds == null
                ? "loading…"
                : `updated ${ageSeconds}s ago`}
        </span>
      </header>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Signal totals</h2>
        <TotalsGrid totals={overview?.totals ?? null} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Recent observations</h2>
        <RecentSignalsList signals={overview?.recentSignals ?? null} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Recent graph activity</h2>
        <GraphActivityList events={overview?.recentGraphActivity ?? null} />
      </section>

      {/* Phase 12 — Reviewer activity. Surfaces the bounded totals
          the existing /v1/investigation/reviewers endpoint returns,
          with a deep-link to the dedicated console. */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Reviewer activity</h2>
        <ReviewerActivityGrid activity={reviewerActivity} />
        <div style={pivotsStyle}>
          <Link href="/investigation/reviewers" style={pivotLinkStyle}>
            Open reviewer console →
          </Link>
        </div>
      </section>

      {/* Phase 12 — Indexing progress. Surfaces the bounded indexing
          totals (OCR + transcript) that Phase 11 produces. */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Indexing progress</h2>
        <IndexingProgressGrid totals={reviewerActivity?.indexingTotals ?? null} />
      </section>

      {/* Phase 13 — Cross-Evidence Findings. Lists workspace-wide
          entity tuples (kind, normalizedValue) that appear on more
          than one evidence record. Each chip deep-links into the
          existing /search surface so the operator can pivot to the
          full result set without leaving the page. */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Cross-Evidence Findings</h2>
        <CrossEvidenceFindingsCard findings={crossEvidence} />
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Queue health</h2>
        <QueueHealthGrid metrics={metrics} />
        {canObservability ? (
          <div style={pivotsStyle}>
            <Link href="/ops/media-graph" style={pivotLinkStyle}>
              Open operations console →
            </Link>
          </div>
        ) : null}
      </section>

      <p style={footerNoteStyle}>
        This dashboard renders only data the workspace operator already has
        access to. Originals are never mutated; the canonical custody record
        remains the authoritative integrity artifact.
      </p>
    </div>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function TotalsGrid({ totals }: { totals: Totals | null }) {
  const tiles: Array<{
    label: string;
    value: number | null;
    tone?: "ok" | "info" | "warn" | "danger";
  }> = [
    { label: "Total signals", value: totals?.signalsTotal ?? null },
    {
      label: "Needs attention",
      value: totals?.attention ?? null,
      tone: "danger",
    },
    {
      label: "Review recommended",
      value: totals?.reviewRecommended ?? null,
      tone: "warn",
    },
    { label: "Observations", value: totals?.info ?? null, tone: "info" },
    { label: "Open", value: totals?.pending ?? null },
    { label: "Acknowledged", value: totals?.acknowledged ?? null, tone: "ok" },
    { label: "Dismissed", value: totals?.dismissed ?? null },
  ];
  return (
    <ul style={gridStyle}>
      {tiles.map((t) => (
        <li key={t.label} style={tileStyle(t.tone)}>
          <div style={tileLabelStyle}>{t.label}</div>
          <div style={tileValueStyle}>
            {t.value == null ? "—" : formatNumber(t.value)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RecentSignalsList({
  signals,
}: {
  signals: RecentSignal[] | null;
}) {
  if (signals == null) {
    return <p style={emptyStyle}>Loading…</p>;
  }
  if (signals.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={emptyTitleStyle}>
          Investigation surfaces populate as you capture evidence and open
          cases. No setup required — capture content and return here.
        </p>
        <p style={emptyHintStyle}>
          This page lists workspace-wide advisory observations. Capture
          evidence or open an existing case to populate it.
        </p>
        <div style={emptyCtaRowStyle}>
          <Link href="/capture" style={emptyCtaPrimaryStyle}>
            Capture evidence
          </Link>
          <Link href="/cases" style={emptyCtaSecondaryStyle}>
            Open cases
          </Link>
        </div>
      </div>
    );
  }
  return (
    <ul style={listStyle}>
      {signals.map((s) => (
        <li key={s.id} style={rowStyle}>
          <div style={rowHeaderStyle}>
            <span style={severityBadgeStyle(s.severity)}>
              {severityLabel(s.severity)}
            </span>
            <span style={confidenceBadgeStyle}>
              {confidenceLabel(s.confidence)}
            </span>
            <span style={statusBadgeStyle(s.status)}>
              {statusLabel(s.status)}
            </span>
            <span style={signalTypeStyle}>{s.signalType}</span>
          </div>
          <p style={summaryTextStyle}>{s.safeSummary}</p>
          <div style={rowFooterStyle}>
            <time style={timestampStyle} dateTime={s.createdAtUtc}>
              Recorded {formatTimestamp(s.createdAtUtc)}
            </time>
            <Link
              href={`/evidence/${encodeURIComponent(s.evidenceId)}`}
              style={pivotLinkStyle}
            >
              Open evidence →
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

function GraphActivityList({
  events,
}: {
  events: GraphActivityEvent[] | null;
}) {
  if (events == null) {
    return <p style={emptyStyle}>Loading…</p>;
  }
  if (events.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={emptyTitleStyle}>
          No graph activity recorded yet.
        </p>
        <p style={emptyHintStyle}>
          The workspace map updates as evidence is captured and cases are
          opened.
        </p>
        <div style={emptyCtaRowStyle}>
          <Link href="/capture" style={emptyCtaPrimaryStyle}>
            Capture evidence
          </Link>
          <Link href="/cases" style={emptyCtaSecondaryStyle}>
            Open cases
          </Link>
        </div>
      </div>
    );
  }
  return (
    <ul style={activityListStyle}>
      {events.map((e) => (
        <li key={`${e.kind}:${e.id}`} style={activityRowStyle}>
          <span style={activityKindBadgeStyle(e.kind)}>
            {e.kind === "NODE_CREATED" ? "Node" : "Edge"}
          </span>
          <span style={activitySummaryStyle}>{e.summary}</span>
          <time style={timestampStyle} dateTime={e.atUtc}>
            {formatTimestamp(e.atUtc)}
          </time>
        </li>
      ))}
    </ul>
  );
}

// Phase 12 — Bounded display tiles for the reviewer-activity summary
// surfaced on the overview page. Reads counts already returned by
// /v1/investigation/reviewers; never fabricates a value.
function ReviewerActivityGrid({
  activity,
}: {
  activity: ReviewerActivitySummary | null;
}) {
  if (activity == null) {
    return (
      <div style={emptyStyle}>
        <p style={emptyTitleStyle}>
          Review workflow surfaces populate as evidence is captured and
          assigned. No setup required.
        </p>
        <p style={emptyHintStyle}>
          Open the reviewer console for the full operator surface.
        </p>
      </div>
    );
  }
  const wf = activity.workflowTotals ?? null;
  const esc = activity.escalationTotals ?? null;
  const ext = activity.externalReviewTotals ?? null;
  const tiles: Array<{
    label: string;
    value: number | null;
    tone?: "ok" | "info" | "warn" | "danger";
    detail?: string;
  }> = [
    {
      label: "Review workflows",
      value: wf?.total ?? null,
      detail:
        wf != null
          ? `${wf.inProgress} in progress · ${wf.escalated} escalated`
          : undefined,
    },
    {
      label: "Open escalations",
      value: esc?.open ?? null,
      tone: (esc?.open ?? 0) > 0 ? "warn" : undefined,
      detail:
        esc != null
          ? `${esc.acknowledged} acknowledged · ${esc.resolved} resolved`
          : undefined,
    },
    {
      label: "External reviewer grants",
      value: ext?.active ?? null,
      tone: "info",
      detail:
        ext != null
          ? `${ext.invited} invited · ${ext.expired} expired`
          : undefined,
    },
  ];
  return (
    <ul style={gridStyle}>
      {tiles.map((t) => (
        <li key={t.label} style={tileStyle(t.tone)}>
          <div style={tileLabelStyle}>{t.label}</div>
          <div style={tileValueStyle}>
            {t.value == null ? "—" : formatNumber(t.value)}
          </div>
          {t.detail ? (
            <div style={tileMetricNameStyle}>{t.detail}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// Phase 12 — Display tile for OCR / transcript indexing totals.
function IndexingProgressGrid({
  totals,
}: {
  totals: ReviewerActivitySummary["indexingTotals"] | null;
}) {
  if (totals == null) {
    return (
      <div style={emptyStyle}>
        <p style={emptyTitleStyle}>
          OCR and transcript indexing has not been recorded for this
          workspace yet.
        </p>
        <p style={emptyHintStyle}>
          Indexing runs as evidence is captured; existing OCR and
          transcript content also remains searchable.
        </p>
      </div>
    );
  }
  const tiles: Array<{ label: string; value: number; detail: string }> = [
    {
      label: "OCR records available",
      value: totals.ocrAvailable,
      detail: `${totals.ocrIndexed} indexed`,
    },
    {
      label: "Transcript records available",
      value: totals.transcriptAvailable,
      detail: `${totals.transcriptIndexed} indexed`,
    },
  ];
  return (
    <ul style={gridStyle}>
      {tiles.map((t) => (
        <li key={t.label} style={tileStyle("info")}>
          <div style={tileLabelStyle}>{t.label}</div>
          <div style={tileValueStyle}>{formatNumber(t.value)}</div>
          <div style={tileMetricNameStyle}>{t.detail}</div>
        </li>
      ))}
    </ul>
  );
}

// Phase 13 — Cross-Evidence Findings card. Renders the workspace-
// wide entity tuples returned by the new /v1/investigation/cross-
// evidence endpoint. Each finding becomes a chip the operator can
// click to deep-link into the existing /search surface (the
// keyword index already covers OCR + transcript text + the
// entity normalizedValue chunks added in Phase 13).
function CrossEvidenceFindingsCard({
  findings,
}: {
  findings: CrossEvidenceFinding[] | null;
}) {
  if (findings == null) {
    return <p style={emptyStyle}>Loading…</p>;
  }
  if (findings.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={emptyTitleStyle}>
          No cross-evidence findings recorded for this workspace yet.
        </p>
        <p style={emptyHintStyle}>
          When the same person, email, phone number, organisation or
          location appears on more than one evidence record, the
          workspace surfaces it here for operator review.
        </p>
      </div>
    );
  }
  return (
    <ul style={listStyle} data-cross-evidence-findings>
      {findings.map((f) => {
        const href = `/search?q=${encodeURIComponent(f.normalizedValue)}`;
        return (
          <li key={`${f.kind}:${f.normalizedValue}`} style={rowStyle}>
            <div style={rowHeaderStyle}>
              <span style={signalTypeStyle}>{f.kind}</span>
              <span style={confidenceBadgeStyle}>
                {f.evidenceCount} records
              </span>
              <span style={crossEvidenceValueStyle}>{f.normalizedValue}</span>
            </div>
            <p style={summaryTextStyle}>{f.operatorSummary}</p>
            <div style={rowFooterStyle}>
              <span style={timestampStyle}>
                {f.sampleEvidenceIds.length} sample{f.sampleEvidenceIds.length === 1 ? "" : "s"}
              </span>
              <Link href={href} style={pivotLinkStyle}>
                Open search results →
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const crossEvidenceValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#0f172a",
  wordBreak: "break-all",
};

function QueueHealthGrid({ metrics }: { metrics: MetricsSnapshot | null }) {
  const tiles: Array<{
    label: string;
    metric: string;
    kind: "counter" | "gauge";
    tone?: "ok" | "info" | "warn" | "danger";
  }> = [
    {
      label: "Queue depth",
      metric: "media_intelligence_queue_depth",
      kind: "gauge",
      tone: "info",
    },
    {
      label: "Pending runs",
      metric: "media_intelligence_runs_pending",
      kind: "gauge",
    },
    {
      label: "Processing runs",
      metric: "media_intelligence_runs_processing",
      kind: "gauge",
    },
    {
      label: "Failed runs",
      metric: "media_intelligence_runs_failed",
      kind: "gauge",
      tone: "warn",
    },
    {
      label: "Oldest pending (s)",
      metric: "media_intelligence_oldest_pending_age_seconds",
      kind: "gauge",
      tone: "warn",
    },
    {
      label: "DLQ total",
      metric: "media_intelligence_dlq_total",
      kind: "counter",
      tone: "danger",
    },
  ];
  return (
    <ul style={gridStyle}>
      {tiles.map((t) => {
        const present =
          metrics != null &&
          (t.kind === "counter"
            ? t.metric in metrics.counters
            : t.metric in metrics.gauges);
        const value = present
          ? t.kind === "counter"
            ? metrics!.counters[t.metric]!
            : metrics!.gauges[t.metric]!
          : null;
        return (
          <li key={t.metric} style={tileStyle(t.tone)}>
            <div style={tileLabelStyle}>{t.label}</div>
            <div style={tileValueStyle}>
              {value == null ? "—" : formatNumber(value)}
            </div>
            <div style={tileMetricNameStyle}>{t.metric}</div>
          </li>
        );
      })}
    </ul>
  );
}

// =============================================================================
// Display helpers (mirror apps/web/lib/media-intelligence/types.ts)
// =============================================================================

function severityLabel(s: Severity): string {
  switch (s) {
    case "INFO":
      return "Observation";
    case "REVIEW_RECOMMENDED":
      return "Review recommended";
    case "ATTENTION":
      return "Needs attention";
  }
}

function confidenceLabel(c: Confidence): string {
  switch (c) {
    case "LOW":
      return "Low confidence";
    case "MEDIUM":
      return "Medium confidence";
    case "HIGH":
      return "High confidence";
  }
}

function statusLabel(s: Status): string {
  switch (s) {
    case "PENDING":
      return "Open";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "DISMISSED":
      return "Dismissed";
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// =============================================================================
// Styles — inline, dense, enterprise. Matches /ops/media-graph register.
// =============================================================================

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
  maxWidth: 720,
  lineHeight: 1.5,
};

function freshnessPillStyle(
  err: string | null,
  ageSeconds: number | null,
  teamId: string | null,
): React.CSSProperties {
  let bg = "#eff6ff";
  let border = "#bfdbfe";
  let color = "#1e40af";
  if (err) {
    bg = "#fef2f2";
    border = "#fca5a5";
    color = "#991b1b";
  } else if (!teamId || ageSeconds == null) {
    bg = "#f1f5f9";
    border = "#cbd5e1";
    color = "#334155";
  } else if (ageSeconds > 180) {
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
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 10,
};

function tileStyle(
  tone: "ok" | "info" | "warn" | "danger" | undefined,
): React.CSSProperties {
  const palette: Record<NonNullable<typeof tone>, [string, string]> = {
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
  margin: "4px 0 0 0",
  color: "#0f172a",
};

const tileMetricNameStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#94a3b8",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  marginTop: 4,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#64748b",
  lineHeight: 1.5,
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 14,
};

const emptyTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};

const emptyHintStyle: React.CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: 12,
  color: "#64748b",
  lineHeight: 1.5,
};

const emptyCtaRowStyle: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const emptyCtaPrimaryStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#ffffff",
  background: "#1e40af",
  border: "1px solid #1e3a8a",
  borderRadius: 6,
  padding: "5px 12px",
  textDecoration: "none",
};

const emptyCtaSecondaryStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  padding: "5px 12px",
  textDecoration: "none",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const rowStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
  background: "#ffffff",
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  alignItems: "center",
  marginBottom: 6,
};

const summaryTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#0f172a",
  lineHeight: 1.5,
};

const rowFooterStyle: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const timestampStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const signalTypeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#475569",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "1px 6px",
};

const pivotsStyle: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  gap: 12,
};

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#1e40af",
  textDecoration: "none",
};

const footerNoteStyle: React.CSSProperties = {
  marginTop: 16,
  fontSize: 11,
  color: "#64748b",
  textAlign: "center",
  lineHeight: 1.5,
};

const activityListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: "#ffffff",
};

const activityRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 12,
  padding: "10px 14px",
  borderBottom: "1px solid #f1f5f9",
  alignItems: "center",
};

function activityKindBadgeStyle(
  kind: "NODE_CREATED" | "EDGE_CREATED",
): React.CSSProperties {
  const isNode = kind === "NODE_CREATED";
  return {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    background: isNode ? "#eff6ff" : "#ecfdf5",
    border: `1px solid ${isNode ? "#bfdbfe" : "#bbf7d0"}`,
    color: isNode ? "#1e40af" : "#166534",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    whiteSpace: "nowrap",
  };
}

const activitySummaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#0f172a",
  lineHeight: 1.4,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function severityBadgeStyle(s: Severity): React.CSSProperties {
  const palette: Record<Severity, [string, string, string]> = {
    INFO: ["#eff6ff", "#bfdbfe", "#1e40af"],
    REVIEW_RECOMMENDED: ["#fffbeb", "#fcd34d", "#92400e"],
    ATTENTION: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[s];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const confidenceBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 500,
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  color: "#334155",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

function statusBadgeStyle(s: Status): React.CSSProperties {
  const palette: Record<Status, [string, string, string]> = {
    PENDING: ["#ffffff", "#cbd5e1", "#334155"],
    ACKNOWLEDGED: ["#ecfdf5", "#bbf7d0", "#166534"],
    DISMISSED: ["#f1f5f9", "#cbd5e1", "#64748b"],
  };
  const [bg, border, color] = palette[s];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}
