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
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";

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
        <PageHeader
          eyebrow="Review operations"
          title="Reviewer metrics (7d)"
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
        <div data-reviewer-metrics-loading style={mutedStyle}>
          Loading reviewer metrics…
        </div>
      ) : null}

      {state.kind === "FORBIDDEN" ? (
        <Card
          variant="status"
          tone="neutral"
          data-reviewer-metrics-forbidden
        >
          You do not have permission to view team-wide reviewer
          metrics. Ask a workspace administrator or supervisor.
        </Card>
      ) : null}

      {state.kind === "ERROR" ? (
        <Card
          variant="status"
          tone="risk"
          data-reviewer-metrics-error
          footer={
            <Button
              variant="secondary"
              size="sm"
              data-reviewer-metrics-retry
              onClick={() => void load()}
            >
              Retry
            </Button>
          }
        >
          Could not load reviewer metrics — please retry.
        </Card>
      ) : null}

      {state.kind === "READY" ? (
        <>
          {isMetricsEmpty(state.metrics) ? (
            <Card
              variant="empty"
              data-reviewer-metrics-empty
              style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-secondary, #475569)" }}
            >
              No reviewer activity in the last 7 days for this workspace. The
              cards stay visible below so this reads as a true zero state, not a
              hidden or broken metric fetch.{" "}
              <Link href="/review/queues?queue=UNASSIGNED" style={{ color: "var(--ink-primary, #0f172a)" }}>
                Open reviewer queues
              </Link>{" "}
              or{" "}
              <Link href="/reviewer-ops/sla" style={{ color: "var(--ink-primary, #0f172a)" }}>
                review SLA pressure
              </Link>
              .
            </Card>
          ) : null}
          <div
            data-reviewer-metrics-grid
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
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
    <Card padding="compact" data-reviewer-metric-card={label}>
      <div style={{ fontSize: 11, color: "var(--ink-secondary, #475569)" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </Card>
  );
}

const mutedStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 13,
  marginTop: 4,
};
