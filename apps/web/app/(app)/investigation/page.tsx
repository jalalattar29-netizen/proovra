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
 *     endpoint (reused from /admin/platform/media-graph).
 *
 * Phase 7C — VISUAL redesign only. The page now composes the shared
 * PageShell / PageHeader / PageSection foundation with token-driven
 * Card / Badge / Button primitives. All data fetching, polling,
 * permission gates, data-* attributes and honest-null ("—") handling
 * are preserved verbatim.
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
import { OperationalEmptyState } from "../../../components/operational/OperationalEmptyState";
import { classifyInvestigationEmptyState } from "../../../lib/empty-state/classifier";
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
// Phase 13 — typed cross-evidence findings client.
import {
  getCrossEvidenceFindings,
  type CrossEvidenceFinding,
} from "../../../lib/api/intelligence";
import { formatUserDateTime } from "../../../lib/date";
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

// Shared tone vocabulary → design-system Badge tone. Keeps the
// operational palette (ok / info / warn / danger) mapping honest.
type Tone = "ok" | "info" | "warn" | "danger";

function toneToCard(tone: Tone | undefined): {
  variant: "summary" | "status";
  cardTone?: "verified" | "pending" | "risk" | "info" | "neutral";
} {
  if (!tone) return { variant: "summary" };
  const map: Record<Tone, "verified" | "pending" | "risk" | "info"> = {
    ok: "verified",
    info: "info",
    warn: "pending",
    danger: "risk",
  };
  return { variant: "status", cardTone: map[tone] };
}

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
  // STAGE 2 — /admin/platform/media-graph maps to OBSERVABILITY_VIEW in the
  // canonical route registry. The "Open operations console" pivot
  // below is the only deep-link off this page into an ops surface
  // and must be hidden for actors without the capability.
  const canObservability = useCan("OBSERVABILITY_VIEW");
  // Wave 2 Phase 6 — refresh + ack/dismiss actions gated by
  // EVIDENCE_MANAGE (the closest UI-side capability that maps to the
  // backend evidence.update_metadata permission).
  const canMutate = useCan("EVIDENCE_MANAGE");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Wave 2 Phase 4 — capture the underlying fetch error so the classifier
  // can resolve API_ERROR instead of misclassifying as TRUE_EMPTY.
  const [fetchError, setFetchError] = useState<Error | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  // Wave 2 Phase 6 — refresh + per-signal action state.
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshResult, setRefreshResult] = useState<
    { enqueued: number; scanned: number } | null
  >(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [signalBusy, setSignalBusy] = useState<Record<string, string>>({});
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
        const [ov, metEnvelope] = await Promise.all([
          apiFetch(
            `/v1/investigation/overview?teamId=${encodeURIComponent(teamId)}`,
            { method: "GET" },
          ) as Promise<OverviewResponse>,
          // `/v1/ops/metrics` returns `{ metrics: MetricsSnapshot }` —
          // ops.routes.ts wraps the snapshot in an envelope. Unwrap
          // here so QueueHealthGrid sees the bare MetricsSnapshot
          // shape (counters/gauges directly accessible). Defensive:
          // if the server ever omits the envelope or returns null,
          // fall back to undefined so the grid renders the bounded
          // empty state instead of crashing on `t.metric in undefined`.
          apiFetch("/v1/ops/metrics", { method: "GET" }) as Promise<
            { metrics?: MetricsSnapshot } | MetricsSnapshot | null
          >,
        ]);
        if (cancelled) return;
        setOverview(ov);
        const metUnwrapped: MetricsSnapshot | null =
          metEnvelope == null
            ? null
            : "metrics" in metEnvelope &&
                (metEnvelope as { metrics?: MetricsSnapshot }).metrics != null
              ? (metEnvelope as { metrics: MetricsSnapshot }).metrics
              : ((metEnvelope as MetricsSnapshot).counters != null ||
                    (metEnvelope as MetricsSnapshot).gauges != null
                  ? (metEnvelope as MetricsSnapshot)
                  : null);
        setMetrics(metUnwrapped);
        setLastFetchAt(Date.now());
        setError(null);
        setFetchError(null);
      } catch (err) {
        if (!cancelled) {
          setError("overview_unavailable");
          // Wave 2 Phase 4 — preserve the underlying Error so the
          // classifier resolves API_ERROR honestly.
          setFetchError(
            err instanceof Error ? err : new Error("overview_unavailable"),
          );
        }
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

  // Wave 2 Phase 6 — refresh action handler. Calls the new bounded
  // workspace-wide media-intelligence refresh endpoint.
  const handleRefresh = async () => {
    if (!teamId || refreshBusy) return;
    setRefreshBusy(true);
    setRefreshError(null);
    setRefreshResult(null);
    try {
      const res = (await apiFetch(
        "/v1/investigation/media-intelligence/refresh",
        {
          method: "POST",
          body: JSON.stringify({ teamId }),
          headers: { "Content-Type": "application/json" },
        },
      )) as { enqueued: number; scanned: number };
      setRefreshResult({ enqueued: res.enqueued, scanned: res.scanned });
    } catch (err) {
      // Internal error-kind detection only — reads raw message to branch
      // on 403; the msg itself is never rendered.
      const msg = err instanceof Error ? err.message : "";
      setRefreshError(
        /403|forbidden/i.test(msg)
          ? "not_permitted"
          : "refresh_unavailable",
      );
    } finally {
      setRefreshBusy(false);
    }
  };

  // Wave 2 Phase 6 — per-signal ack/dismiss handler. Uses the
  // canonical /v1/media-intelligence/signals/:id/action endpoint.
  const handleSignalAction = async (
    signalId: string,
    action: "ACKNOWLEDGED" | "DISMISSED",
  ) => {
    if (!teamId) return;
    setSignalBusy((m) => ({ ...m, [signalId]: action }));
    try {
      await apiFetch(
        `/v1/media-intelligence/signals/${encodeURIComponent(signalId)}/action`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, action }),
          headers: { "Content-Type": "application/json" },
        },
      );
      // Optimistically remove the row.
      setOverview((prev) =>
        prev
          ? {
              ...prev,
              recentSignals: prev.recentSignals.filter((s) => s.id !== signalId),
            }
          : prev,
      );
    } catch {
      /* best-effort UI; next poll cycle reconciles state */
    } finally {
      setSignalBusy((m) => {
        const next = { ...m };
        delete next[signalId];
        return next;
      });
    }
  };

  const freshnessTone: BadgeTone = error
    ? "risk"
    : !teamId || ageSeconds == null
      ? "neutral"
      : ageSeconds > 180
        ? "pending"
        : "info";
  const freshnessLabel = error
    ? "Overview unavailable — retrying"
    : !teamId
      ? "loading workspace…"
      : ageSeconds == null
        ? "loading…"
        : `updated ${ageSeconds}s ago`;

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Investigation"
          title="Investigation Intelligence Overview"
          subtitle="Workspace-wide advisory observations and recent graph activity. Numbers are operational telemetry; they do not classify recorded material and they do not establish legal weight."
          contextStrip={
            <Badge tone={freshnessTone} dot>
              {freshnessLabel}
            </Badge>
          }
          primaryAction={
            // Wave 2 Phase 6 — workspace-wide media-intelligence refresh.
            // Bounded to top 50 evidence records per request. Hidden for
            // actors without EVIDENCE_MANAGE.
            canMutate ? (
              <Button
                variant="primary"
                data-action="run-media-intelligence-refresh"
                onClick={() => void handleRefresh()}
                disabled={refreshBusy || !teamId}
                loading={refreshBusy}
              >
                {refreshBusy ? "Refreshing…" : "Run media intelligence refresh"}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {refreshResult || refreshError ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: -12 }}>
          {refreshResult ? (
            <Badge tone="verified">
              {refreshResult.enqueued > 0
                ? `Queued ${refreshResult.enqueued} of ${refreshResult.scanned} record${refreshResult.scanned === 1 ? "" : "s"}.`
                : `No new analyses queued — scanned ${refreshResult.scanned} record${refreshResult.scanned === 1 ? "" : "s"}.`}
            </Badge>
          ) : null}
          {refreshError ? (
            <Badge tone="risk">
              {refreshError === "not_permitted"
                ? "You do not have permission to run this action."
                : "Unable to start refresh. Try again."}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <PageSection title="Signal totals">
        <TotalsGrid totals={overview?.totals ?? null} />
      </PageSection>

      <PageSection title="Recent observations">
        <RecentSignalsList
          signals={overview?.recentSignals ?? null}
          fetchError={fetchError}
          isAdmin={canObservability}
          canMutate={canMutate}
          signalBusy={signalBusy}
          onAck={(id) => void handleSignalAction(id, "ACKNOWLEDGED")}
          onDismiss={(id) => void handleSignalAction(id, "DISMISSED")}
        />
      </PageSection>

      <PageSection title="Recent graph activity">
        <GraphActivityList
          events={overview?.recentGraphActivity ?? null}
          fetchError={fetchError}
          isAdmin={canObservability}
        />
      </PageSection>

      {/* Phase 12 — Reviewer activity. Surfaces the bounded totals
          the existing /v1/investigation/reviewers endpoint returns,
          with a deep-link to the dedicated console. */}
      <PageSection title="Reviewer activity">
        <ReviewerActivityGrid activity={reviewerActivity} />
        <div style={pivotsStyle}>
          <Link href="/investigation/reviewers" style={pivotLinkStyle}>
            Open reviewer console →
          </Link>
        </div>
      </PageSection>

      {/* Phase 12 — Indexing progress. Surfaces the bounded indexing
          totals (OCR + transcript) that Phase 11 produces. */}
      <PageSection title="Indexing progress">
        <IndexingProgressGrid totals={reviewerActivity?.indexingTotals ?? null} />
      </PageSection>

      {/* Phase 13 — Cross-Evidence Findings. Lists workspace-wide
          entity tuples (kind, normalizedValue) that appear on more
          than one evidence record. Each chip deep-links into the
          existing /search surface so the operator can pivot to the
          full result set without leaving the page. */}
      <PageSection title="Cross-Evidence Findings">
        <CrossEvidenceFindingsCard findings={crossEvidence} />
      </PageSection>

      <PageSection title="Queue health">
        <QueueHealthGrid metrics={metrics} />
        {canObservability ? (
          <div style={pivotsStyle}>
            <Link href="/admin/platform/media-graph" style={pivotLinkStyle}>
              Open operations console →
            </Link>
          </div>
        ) : null}
      </PageSection>

      <p style={footerNoteStyle}>
        This dashboard renders only data the workspace operator already has
        access to. Originals are never mutated; the canonical custody record
        remains the authoritative integrity artifact.
      </p>
    </PageShell>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function MetricTile({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  detail?: string;
}) {
  const { variant, cardTone } = toneToCard(tone);
  return (
    <Card variant={variant} tone={cardTone} padding="comfortable">
      <div style={tileLabelStyle}>{label}</div>
      <div style={tileValueStyle}>{value}</div>
      {detail ? <div style={tileMetricNameStyle}>{detail}</div> : null}
    </Card>
  );
}

function TotalsGrid({ totals }: { totals: Totals | null }) {
  const tiles: Array<{
    label: string;
    value: number | null;
    tone?: Tone;
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
    <div style={gridStyle}>
      {tiles.map((t) => (
        <MetricTile
          key={t.label}
          label={t.label}
          tone={t.tone}
          value={t.value == null ? "—" : formatNumber(t.value)}
        />
      ))}
    </div>
  );
}

function RecentSignalsList({
  signals,
  fetchError,
  isAdmin,
  canMutate,
  signalBusy,
  onAck,
  onDismiss,
}: {
  signals: RecentSignal[] | null;
  fetchError: Error | null;
  isAdmin: boolean;
  canMutate: boolean;
  signalBusy: Record<string, string>;
  onAck: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (signals == null && !fetchError) {
    return <p style={emptyStyle}>Loading…</p>;
  }
  if (signals == null || signals.length === 0) {
    // Wave 2 Phase 4 — classifier-driven empty state.
    const { classification, reason } = classifyInvestigationEmptyState(
      { data: signals, fetchError, permission: "allowed" },
      "overview",
    );
    return (
      <OperationalEmptyState
        classification={classification}
        reason={reason}
        nextAction={{ label: "Capture evidence", href: "/capture" }}
        adminAction={{ label: "Open cases", href: "/cases" }}
        diagnosticsLink="/admin/platform/observability"
        isAdmin={isAdmin}
      />
    );
  }
  return (
    <div style={listStyle}>
      {signals.map((s) => (
        <Card key={s.id} padding="comfortable">
          <div style={rowHeaderStyle}>
            <Badge tone={severityTone(s.severity)}>
              {severityLabel(s.severity)}
            </Badge>
            <Badge tone="neutral" subtle>
              {confidenceLabel(s.confidence)}
            </Badge>
            <Badge tone={statusTone(s.status)} subtle>
              {statusLabel(s.status)}
            </Badge>
            <span style={signalTypeStyle}>{s.signalType}</span>
          </div>
          <p style={summaryTextStyle}>{s.safeSummary}</p>
          <div style={rowFooterStyle}>
            <time style={timestampStyle} dateTime={s.createdAtUtc}>
              Recorded {formatTimestamp(s.createdAtUtc)}
            </time>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {canMutate ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-action="acknowledge-signal"
                    onClick={() => onAck(s.id)}
                    disabled={signalBusy[s.id] != null}
                    loading={signalBusy[s.id] === "ACKNOWLEDGED"}
                  >
                    {signalBusy[s.id] === "ACKNOWLEDGED"
                      ? "Acknowledging…"
                      : "Acknowledge"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-action="dismiss-signal"
                    onClick={() => onDismiss(s.id)}
                    disabled={signalBusy[s.id] != null}
                    loading={signalBusy[s.id] === "DISMISSED"}
                  >
                    {signalBusy[s.id] === "DISMISSED"
                      ? "Dismissing…"
                      : "Dismiss"}
                  </Button>
                </>
              ) : null}
              <Link
                href={`/evidence/${encodeURIComponent(s.evidenceId)}`}
                style={pivotLinkStyle}
              >
                Open evidence →
              </Link>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function GraphActivityList({
  events,
  fetchError,
  isAdmin,
}: {
  events: GraphActivityEvent[] | null;
  fetchError: Error | null;
  isAdmin: boolean;
}) {
  if (events == null && !fetchError) {
    return <p style={emptyStyle}>Loading…</p>;
  }
  if (events == null || events.length === 0) {
    // Wave 2 Phase 4 — classifier-driven empty state.
    const { classification, reason } = classifyInvestigationEmptyState(
      { data: events, fetchError, permission: "allowed" },
      "graph",
    );
    return (
      <OperationalEmptyState
        classification={classification}
        reason={reason}
        nextAction={{ label: "Capture evidence", href: "/capture" }}
        adminAction={{ label: "Open cases", href: "/cases" }}
        diagnosticsLink="/admin/platform/observability"
        isAdmin={isAdmin}
      />
    );
  }
  return (
    <Card padding="none">
      <ul style={activityListStyle}>
        {events.map((e) => (
          <li key={`${e.kind}:${e.id}`} style={activityRowStyle}>
            <Badge tone={e.kind === "NODE_CREATED" ? "info" : "verified"} subtle>
              {e.kind === "NODE_CREATED" ? "Node" : "Edge"}
            </Badge>
            <span style={activitySummaryStyle}>{e.summary}</span>
            <time style={timestampStyle} dateTime={e.atUtc}>
              {formatTimestamp(e.atUtc)}
            </time>
          </li>
        ))}
      </ul>
    </Card>
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
    // Wave 2 Phase 4 — classifier-driven empty state. The reviewer
    // activity fetch is independent; failures collapse to null on
    // the page, so we treat null as TRUE_EMPTY here (the user lands
    // on the page with no reviewer assignments). The admin link
    // surfaces the dedicated reviewer console.
    const { classification, reason } = classifyInvestigationEmptyState(
      { data: activity, fetchError: null, permission: "allowed" },
      "reviewers",
    );
    return (
      <OperationalEmptyState
        classification={classification}
        reason={reason}
        nextAction={{
          label: "Open reviewer console",
          href: "/investigation/reviewers",
        }}
      />
    );
  }
  const wf = activity.workflowTotals ?? null;
  const esc = activity.escalationTotals ?? null;
  const ext = activity.externalReviewTotals ?? null;
  const tiles: Array<{
    label: string;
    value: number | null;
    tone?: Tone;
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
    <div style={gridStyle}>
      {tiles.map((t) => (
        <MetricTile
          key={t.label}
          label={t.label}
          tone={t.tone}
          detail={t.detail}
          value={t.value == null ? "—" : formatNumber(t.value)}
        />
      ))}
    </div>
  );
}

// Phase 12 — Display tile for OCR / transcript indexing totals.
//
// Defensive: the /v1/investigation/reviewers handler can silently swallow
// exceptions and return partial indexingTotals (media-intelligence.routes.ts:910-911).
// The previous unguarded read at lines 569-575 was the root cause of the
// /investigation "Something went wrong" regression. Every field is read via
// optional chain + nullish coalescing so a missing key renders 0 rather
// than throwing. We also gracefully accept `undefined` (in addition to
// `null`) so any future caller passing `reviewerActivity?.indexingTotals`
// directly (which is typed as optional on ReviewerActivitySummary) cannot
// re-introduce the crash.
function IndexingProgressGrid({
  totals,
}: {
  totals: ReviewerActivitySummary["indexingTotals"] | null | undefined;
}) {
  // Only fall back to the "not recorded yet" empty state when the field is
  // literally absent. If the API returned the object but some properties
  // are missing/null, we still render the tiles (with 0s) — that is more
  // informative than hiding the section entirely and keeps the surface
  // shape stable for the operator.
  if (totals === null || totals === undefined) {
    // Wave 2 Phase 4 — classifier-driven empty state.
    const { classification, reason } = classifyInvestigationEmptyState(
      { data: totals, fetchError: null, permission: "allowed" },
      "overview",
    );
    return (
      <OperationalEmptyState
        classification={classification}
        reason={reason}
        nextAction={{ label: "Capture evidence", href: "/capture" }}
      />
    );
  }
  // Defensive reads: optional chain guards against the runtime shape
  // diverging from the TS type (e.g. handler returns a partial object on
  // soft-failure), and ?? 0 ensures a sane numeric value for formatNumber.
  const ocrAvailable = totals?.ocrAvailable ?? 0;
  const ocrIndexed = totals?.ocrIndexed ?? 0;
  const transcriptAvailable = totals?.transcriptAvailable ?? 0;
  const transcriptIndexed = totals?.transcriptIndexed ?? 0;
  const tiles: Array<{ label: string; value: number; detail: string }> = [
    {
      label: "OCR records available",
      value: ocrAvailable,
      detail: `${ocrIndexed} indexed`,
    },
    {
      label: "OCR records indexed",
      value: ocrIndexed,
      detail: `${ocrAvailable} available`,
    },
    {
      label: "Transcript records available",
      value: transcriptAvailable,
      detail: `${transcriptIndexed} indexed`,
    },
    {
      label: "Transcript records indexed",
      value: transcriptIndexed,
      detail: `${transcriptAvailable} available`,
    },
  ];
  return (
    <div style={gridStyle}>
      {tiles.map((t) => (
        <MetricTile
          key={t.label}
          label={t.label}
          tone="info"
          detail={t.detail}
          value={formatNumber(t.value)}
        />
      ))}
    </div>
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
    // Wave 2 Phase 4 — classifier-driven empty state.
    const { classification, reason } = classifyInvestigationEmptyState(
      { data: findings, fetchError: null, permission: "allowed" },
      "overview",
    );
    return (
      <OperationalEmptyState
        classification={classification}
        reason={reason}
        nextAction={{ label: "Capture evidence", href: "/capture" }}
      />
    );
  }
  return (
    <div style={listStyle} data-cross-evidence-findings>
      {findings.map((f) => {
        const href = `/search?q=${encodeURIComponent(f.normalizedValue)}`;
        return (
          <Card key={`${f.kind}:${f.normalizedValue}`} padding="comfortable">
            <div style={rowHeaderStyle}>
              <span style={signalTypeStyle}>{f.kind}</span>
              <Badge tone="neutral" subtle>
                {f.evidenceCount} records
              </Badge>
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
          </Card>
        );
      })}
    </div>
  );
}

const crossEvidenceValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-primary, #0f172a)",
  wordBreak: "break-all",
};

function QueueHealthGrid({ metrics }: { metrics: MetricsSnapshot | null }) {
  const tiles: Array<{
    label: string;
    metric: string;
    kind: "counter" | "gauge";
    tone?: Tone;
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
  // Defensive fallbacks: a malformed response (e.g. the raw envelope
  // `{ metrics: ... }` slipping through, or the server returning a
  // partial snapshot) used to crash this grid with "cannot use 'in'
  // operator on undefined". Resolve to {} so a missing bag renders
  // bounded "—" tiles instead.
  const counters: Record<string, number> = metrics?.counters ?? {};
  const gauges: Record<string, number> = metrics?.gauges ?? {};
  return (
    <div style={gridStyle}>
      {tiles.map((t) => {
        const bag = t.kind === "counter" ? counters : gauges;
        const present = metrics != null && t.metric in bag;
        const value = present ? bag[t.metric]! : null;
        return (
          <MetricTile
            key={t.metric}
            label={t.label}
            tone={t.tone}
            detail={t.metric}
            value={value == null ? "—" : formatNumber(value)}
          />
        );
      })}
    </div>
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

function severityTone(s: Severity): BadgeTone {
  switch (s) {
    case "INFO":
      return "info";
    case "REVIEW_RECOMMENDED":
      return "pending";
    case "ATTENTION":
      return "risk";
  }
}

function statusTone(s: Status): BadgeTone {
  switch (s) {
    case "PENDING":
      return "neutral";
    case "ACKNOWLEDGED":
      return "verified";
    case "DISMISSED":
      return "neutral";
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
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

// =============================================================================
// Styles — token-driven remnants used inside Card/PageSection bodies.
// =============================================================================

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 12,
};

const tileLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-muted, #94a3b8)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const tileValueStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  margin: "6px 0 0 0",
  color: "var(--ink-primary, #0f172a)",
  lineHeight: 1.1,
};

const tileMetricNameStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--ink-muted, #94a3b8)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  marginTop: 6,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
  lineHeight: 1.5,
  background: "var(--surface-muted, #f1f4f9)",
  border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  borderRadius: "var(--radius-card, 14px)",
  padding: 16,
};

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  alignItems: "center",
  marginBottom: 8,
};

const summaryTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
  lineHeight: 1.55,
};

const rowFooterStyle: React.CSSProperties = {
  marginTop: 12,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const timestampStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-muted, #94a3b8)",
};

const signalTypeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--ink-secondary, #475569)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  background: "var(--surface-muted, #f1f4f9)",
  border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  borderRadius: 4,
  padding: "1px 6px",
};

const pivotsStyle: React.CSSProperties = {
  marginTop: 12,
  display: "flex",
  gap: 12,
};

const pivotLinkStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  color: "var(--status-info-solid, #2563eb)",
  textDecoration: "none",
};

const footerNoteStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 11,
  color: "var(--ink-muted, #94a3b8)",
  textAlign: "center",
  lineHeight: 1.5,
};

const activityListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
};

const activityRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 12,
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  alignItems: "center",
};

const activitySummaryStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-primary, #0f172a)",
  lineHeight: 1.4,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
