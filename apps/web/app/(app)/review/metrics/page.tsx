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
import { formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { OperationalEmptyState } from "../../../../components/operational";
import { fetchReviewerMetrics } from "../../../../lib/reviewer-workspace/reviewer-api";
import { PageShell } from "../../../../components/ui/PageShell";
// TEAM-UI-SPEC (structure) — the one review page header: icon title row, the
// tool name, a "← Review" back link above it, no eyebrow.
import {
  ReviewPageHeader,
  REVIEW_HUB_BACK,
} from "../../../../components/reviewer-experience/ReviewPageHeader";
import { Badge } from "../../../../components/ui/Badge";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";

/**
 * T-056 (stage C) — rates are per review and null when there is nothing to
 * divide by; null renders "No data", never 0 % or "0s".
 */
import { formatMetricDuration, formatMetricPct } from "../../../../lib/reviewer-workspace/metric-format";

type Metrics = {
  throughput7d: number;
  approvalRate7dPct: number | null;
  escalationRate7dPct: number | null;
  disagreementRate7dPct: number | null;
  qcFailureRate7dPct: number | null;
  avgReviewDurationMs7d: number | null;
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
  const none = (v: number | null) => v === null || v === 0;
  return (
    m.throughput7d === 0 &&
    none(m.approvalRate7dPct) &&
    none(m.escalationRate7dPct) &&
    none(m.disagreementRate7dPct) &&
    none(m.qcFailureRate7dPct) &&
    none(m.avgReviewDurationMs7d)
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

  // `isStale` lets the effect below discard a response that arrived after the
  // workspace changed (or the page unmounted) — without it, a slow request for
  // the PREVIOUS workspace would paint its metrics under the new one.
  const load = useCallback(async (isStale?: () => boolean) => {
    if (!teamId) {
      setState({ kind: "ERROR" });
      return;
    }
    setState({ kind: "LOADING" });
    try {
      const m = await fetchReviewerMetrics(teamId);
      if (isStale?.()) return;
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
      if (isStale?.()) return;
      if (status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") {
        setState({ kind: "FORBIDDEN" });
      } else {
        setState({ kind: "ERROR" });
      }
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!teamId) {
    return (
      <PageShell data-reviewer-metrics-page>
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading reviewer metrics."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      data-reviewer-metrics-page
      data-reviewer-metrics-state={state.kind}
      header={
        <ReviewPageHeader
          back={REVIEW_HUB_BACK}
          title="Reviewer metrics"
          subtitle="Operational metrics describing reviewer activity. Not authenticity claims about content; not legal weight."
          contextStrip={
            <>
              <Badge tone="neutral" subtle>
                Workspace-wide activity
              </Badge>
              <Badge tone="neutral" subtle>
                Period: last 7 days
              </Badge>
              <Badge tone="info" subtle>
                Updated:{" "}
                {loadedAt ? formatUserDateTime(loadedAt) : "Not yet loaded"}
              </Badge>
            </>
          }
        />
      }
    >
      {state.kind === "LOADING" ? (
        <p role="status" className="app-field-help" data-reviewer-metrics-loading>
          Loading reviewer metrics…
        </p>
      ) : null}

      {state.kind === "FORBIDDEN" ? (
        <section className="app-panel" data-reviewer-metrics-forbidden>
          <div className="app-panel__body">
          You do not have permission to view team-wide reviewer
          metrics. Ask a workspace administrator or supervisor.
          </div>
        </section>
      ) : null}

      {state.kind === "ERROR" ? (
        <section className="app-panel" data-reviewer-metrics-error>
          <div
            className="app-panel__body"
            style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}
          >
            <p role="alert" className="app-field-error" style={{ margin: 0, flex: "1 1 220px", minWidth: 0 }}>
              Could not load reviewer metrics — please retry.
            </p>
            <CanonicalActionButton
              variant="secondary"
              data-reviewer-metrics-retry
              onClick={() => void load()}
            >
              Retry
            </CanonicalActionButton>
          </div>
        </section>
      ) : null}

      {state.kind === "READY" ? (
        <>
          {isMetricsEmpty(state.metrics) ? (
            <section className="app-panel" data-reviewer-metrics-empty>
              <p className="app-panel__body app-field-help" style={{ margin: 0 }}>
              No reviewer activity in the last 7 days for this workspace. The
              cards stay visible below so this reads as a true zero state, not a
              hidden or broken metric fetch.{" "}
              <Link href="/review/queues?queue=UNASSIGNED">
                Open reviewer queues
              </Link>{" "}
              or{" "}
              <Link href="/reviewer-ops/sla">
                review SLA pressure
              </Link>
              .
              </p>
            </section>
          ) : null}
          <div
            data-reviewer-metrics-grid
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
              gap: 12,
            }}
          >
            <MetricCard label="Reviews decided" value={state.metrics.throughput7d} />
            <MetricCard
              label="Approval rate (of reviews)"
              value={formatMetricPct(state.metrics.approvalRate7dPct)}
            />
            <MetricCard
              label="Escalation rate (of reviews)"
              value={formatMetricPct(state.metrics.escalationRate7dPct)}
            />
            <MetricCard
              label="Disagreement rate (of reviews)"
              value={formatMetricPct(state.metrics.disagreementRate7dPct)}
            />
            <MetricCard
              label="QC failure rate (of QC samples)"
              value={formatMetricPct(state.metrics.qcFailureRate7dPct)}
            />
            <MetricCard
              label="Avg review duration"
              value={formatMetricDuration(state.metrics.avgReviewDurationMs7d)}
            />
          </div>
        </>
      ) : null}
    </PageShell>
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
    <section className="app-panel" data-reviewer-metric-card={label}>
      <div className="app-panel__body">
        <div className="app-field-help" style={{ margin: 0 }}>
          {label}
        </div>
        <div className="app-table__primary" style={{ fontSize: 22, marginTop: 4 }}>{value}</div>
      </div>
    </section>
  );
}
