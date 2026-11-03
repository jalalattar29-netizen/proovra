"use client";

/**
 * Phase E4 — Operational Analytics page.
 *
 * Lives UNDER the Operations Center hub (`/operations/analytics`). NOT a root
 * nav item — 32.8 IA keeps root at the 6 canonical primaries.
 *
 * Hard rules (enforced by phase-e4-analytics.test.ts):
 *   - Every section displays REAL counts from REAL Prisma tables.
 *   - Each metric carries a sourceTrace badge showing the table + filter
 *     it came from — operators can audit "where does this number come
 *     from" without leaving the page.
 *   - On Prisma failure the inner service returns `null` for the metric
 *     and pushes the source name to `degradedSources`. The UI renders
 *     "—" + a "data source unavailable" badge instead of fabricating
 *     a number.
 *   - No legal-admissibility scores. No AI predictions. No fake KPIs.
 *     No truth/authenticity claims. No charts beyond bar+line of REAL
 *     counts. No BI builder. No filters beyond the bounded window.
 *   - Bounded window: 1..180 days, default 30. Selector clamps inputs.
 *   - Read-only. No mutations. No new root nav item.
 */

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { sourceTraceLabel } from "../../../../lib/labels/workspaceOpsLabels";
import type { JSX } from "react";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useSearchParams } from "next/navigation";
import { useUrlFilterSync } from "../../../../lib/use-url-filter-sync";
import {
  useActiveSpaceId,
} from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../components/ui/PageShell";
import "../../admin/platform/admin-platform.css";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";

// ---------------------------------------------------------------------------
// Envelope types — mirror services/api/src/services/analytics/analytics.service.ts
// ---------------------------------------------------------------------------

type SourceTraceEntry = {
  metric: string;
  source: string;
  filter: string;
  windowed: boolean;
};

type AnalyticsWindow = {
  days: number;
  start: string;
  end: string;
};

type Envelope<TMetrics> = {
  generatedAt: string;
  window: AnalyticsWindow;
  sourceTrace: ReadonlyArray<SourceTraceEntry>;
  degradedSources: ReadonlyArray<string>;
  metrics: TMetrics;
};

type OperationsMetrics = {
  evidenceCreated: number | null;
  evidenceFinalized: number | null;
  openCases: number | null;
  openReviewWorkflows: number | null;
  openEscalations: number | null;
  reviewerCount: number | null;
};

type ReviewerMetrics = {
  activeReviews: number | null;
  assignedReviews: number | null;
  overdueReviews: number | null;
  openEscalations: number | null;
  resolvedEscalationsInWindow: number | null;
};

type GovernanceMetrics = {
  activeLegalHolds: number | null;
  activeCaseLegalHolds: number | null;
  legalHoldsPlacedInWindow: number | null;
  legalHoldsReleasedInWindow: number | null;
};

type AutomationMetrics = {
  enabledRules: number | null;
  runsInWindow: number | null;
  runsSucceededInWindow: number | null;
  runsFailedInWindow: number | null;
  runsSkippedInWindow: number | null;
  webhookDeliveriesInWindow: number | null;
  webhookDeliveriesSucceededInWindow: number | null;
  webhookDeliveriesFailedInWindow: number | null;
  webhookDeliveriesRetryScheduled: number | null;
  webhookDeliveriesRetryExhaustedInWindow: number | null;
  autoDisabledDestinations: number | null;
};

type ArtifactsMetrics = {
  reportsGeneratedInWindow: number | null;
  packagesGeneratedInWindow: number | null;
};

type Loaded = {
  operations: Envelope<OperationsMetrics> | null;
  reviewer: Envelope<ReviewerMetrics> | null;
  governance: Envelope<GovernanceMetrics> | null;
  automation: Envelope<AutomationMetrics> | null;
  artifacts: Envelope<ArtifactsMetrics> | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: Loaded }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

const ANALYTICS_WINDOW_OPTIONS = [7, 14, 30, 60, 90, 180] as const;
type AnalyticsWindowOption = (typeof ANALYTICS_WINDOW_OPTIONS)[number];
const DEFAULT_WINDOW: AnalyticsWindowOption = 30;

/**
 * PHASE 12 — VERTICAL B. The bounded window contract published by
 * `GET /v1/analytics/_window`. The API clamps every request into this
 * range, so the selector must not offer anything outside it.
 */
type AnalyticsWindowContract = {
  minDays: number;
  maxDays: number;
  defaultDays: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCount(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

function metricIsDegraded(
  envelope: Envelope<unknown> | null,
  metric: string,
): boolean {
  if (!envelope) return true;
  const entry = envelope.sourceTrace.find((e) => e.metric === metric);
  if (!entry) return false;
  return envelope.degradedSources.includes(entry.source);
}

function findTrace(
  envelope: Envelope<unknown> | null,
  metric: string,
): SourceTraceEntry | null {
  if (!envelope) return null;
  return envelope.sourceTrace.find((e) => e.metric === metric) ?? null;
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard(props: {
  envelope: Envelope<unknown> | null;
  metric: string;
  value: number | null;
  label: string;
  hint?: string;
}): JSX.Element {
  const trace = findTrace(props.envelope, props.metric);
  const degraded = metricIsDegraded(props.envelope, props.metric);
  return (
    <div
      className="apf-section"
      data-analytics-metric={props.metric}
      data-analytics-degraded={degraded ? "true" : "false"}
      style={{
        padding: 12,
        border: "1px solid var(--border-default)",
        borderRadius: 8,
        background: degraded ? "var(--warning-subtle-bg)" : "var(--surface-card)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ink-muted)",
        }}
      >
        {props.label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4 }}>
        {degraded ? "—" : formatCount(props.value)}
      </div>
      {props.hint ? (
        <div
          style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}
          data-analytics-metric-hint={props.metric}
        >
          {props.hint}
        </div>
      ) : null}
      {trace ? (
        <div
          style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 8 }}
          data-analytics-source-trace={props.metric}
          title={`Counted from ${sourceTraceLabel(trace.source)}${trace.windowed ? " in the selected period" : ""}`}
        >
          Workspace records
          {trace.windowed ? " · selected period" : ""}
        </div>
      ) : null}
      {degraded ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--warning-strong)",
            marginTop: 4,
          }}
          data-analytics-degraded-notice={props.metric}
        >
          Data source unavailable — value omitted rather than estimated.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner page
// ---------------------------------------------------------------------------

function AnalyticsPageInner(): JSX.Element {
  const teamId = useActiveSpaceId();
  /**
   * THE WINDOW IS PART OF THE ADDRESS, BECAUSE IT IS PART OF THE READING.
   *
   * This was `useState(DEFAULT_WINDOW)` and nothing else, so a 90-day view
   * could not be sent to anybody, did not survive a reload, and Back did not
   * return to the window you were looking at a moment ago. Every figure on
   * this page is a figure FOR a window — "412 reviews" is meaningless without
   * it — so a link to this page without the window is a link to a different
   * number than the one the sender was reading.
   *
   * Seeded from the URL and validated against the server's own contract
   * (`GET /v1/analytics/_window`) further down, so a hand-edited or stale
   * value is clamped rather than trusted; `useUrlFilterSync` writes it back
   * in the same tick the read starts, which is what keeps a late `replace`
   * from cancelling a click out of the page.
   */
  const initialWindow = useSearchParams()?.get("window");
  const [windowDays, setWindowDays] = useState<AnalyticsWindowOption>(() => {
    const n = Number(initialWindow);
    return (ANALYTICS_WINDOW_OPTIONS as ReadonlyArray<number>).includes(n)
      ? (n as AnalyticsWindowOption)
      : DEFAULT_WINDOW;
  });
  useUrlFilterSync("/operations/analytics", { window: windowDays });
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // PHASE 12 — VERTICAL B. The window selector is bounded by the SERVER
  // contract (`GET /v1/analytics/_window`), not by a client constant.
  // Offering a range the API silently clamps is a quiet lie about what
  // the numbers below actually cover.
  const [windowContract, setWindowContract] =
    useState<AnalyticsWindowContract | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/analytics/_window`, { method: "GET" })
      .then((res: AnalyticsWindowContract) => {
        if (cancelled) return;
        setWindowContract(res);
        setWindowDays((current) => {
          const clamped = Math.min(
            Math.max(current, res.minDays),
            res.maxDays,
          );
          const allowed = ANALYTICS_WINDOW_OPTIONS.filter(
            (d) => d >= res.minDays && d <= res.maxDays,
          );
          if (allowed.includes(current as AnalyticsWindowOption)) return current;
          return (allowed.find((d) => d >= clamped) ??
            allowed[allowed.length - 1] ??
            current) as AnalyticsWindowOption;
        });
      })
      .catch(() => {
        // The contract is advisory metadata. If it is unavailable the
        // page still works against the built-in option list — it just
        // cannot annotate the clamp.
        if (!cancelled) setWindowContract(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allowedWindowOptions = useMemo<ReadonlyArray<AnalyticsWindowOption>>(
    () =>
      windowContract
        ? ANALYTICS_WINDOW_OPTIONS.filter(
            (d) => d >= windowContract.minDays && d <= windowContract.maxDays,
          )
        : ANALYTICS_WINDOW_OPTIONS,
    [windowContract],
  );

  useEffect(() => {
    if (!teamId) {
      setState({ status: "loading" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const qs = `teamId=${encodeURIComponent(teamId)}&window=${windowDays}`;
        const [operations, reviewer, governance, automation, artifacts] =
          await Promise.all([
            apiFetch(`/v1/analytics/operations?${qs}`) as Promise<Envelope<OperationsMetrics>>,
            apiFetch(`/v1/analytics/reviewer?${qs}`) as Promise<Envelope<ReviewerMetrics>>,
            apiFetch(`/v1/analytics/governance?${qs}`) as Promise<Envelope<GovernanceMetrics>>,
            apiFetch(`/v1/analytics/automation?${qs}`) as Promise<Envelope<AutomationMetrics>>,
            apiFetch(`/v1/analytics/artifacts?${qs}`) as Promise<Envelope<ArtifactsMetrics>>,
          ]);
        if (cancelled) return;
        setState({
          status: "ready",
          data: { operations, reviewer, governance, automation, artifacts },
        });
      } catch (err) {
        if (cancelled) return;
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 401) {
          setState({ status: "auth_error", code: "auth_required" });
        } else if (e.statusCode === 403) {
          setState({ status: "auth_error", code: "permission_denied" });
        } else {
          setState({
            status: "unavailable",
            message: toSafeUserError(e, { message: "Unable to load analytics." }).message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, windowDays]);

  const headerWindow = useMemo(() => {
    if (state.status !== "ready") return null;
    return state.data.operations?.window ?? null;
  }, [state]);

  // ----- Render branches -----

  if (state.status === "loading") {
    return (
      <PageShell
      width="full" data-analytics-loading
      header={
        <PageHeader
          eyebrow={"Operations Center · Analytics"}
          title={"Operational analytics"}
        />
      }
      >
        <section className="apf-section">
          <div className="adm-skeleton" />
        </section>
      </PageShell>
    );
  }

  if (state.status === "auth_error") {
    return (
      <PageShell
      width="full" data-analytics-auth-error={state.code}
      header={
        <PageHeader
          eyebrow={"Operations Center · Analytics"}
          title={state.code === "auth_required"
                ? "Sign in required"
                : "Permission required"}
          /*
           * ADM-P3-012 — no raw capability code in operator copy.
           *
           * This read "Operational analytics require the ANALYTICS_VIEW
           * capability (team writer or admin)", which names a key from the
           * capability catalogue. The route registry states the rule for the
           * Tools surface — no raw capability codes shown to operators — and it
           * holds here too: the code is not something the reader can act on, and
           * the two states it was flattening are different problems with
           * different fixes.
           */
          subtitle={
            state.code === "auth_required"
              ? "Your session has ended. Sign in again to view operational analytics."
              : "Your account cannot view operational analytics. A workspace administrator can grant access."
          }
        />
      }
      >
      </PageShell>
    );
  }

  if (state.status === "unavailable") {
    return (
      <PageShell
      width="full" data-analytics-unavailable
      header={
        <PageHeader
          eyebrow={"Operations Center · Analytics"}
          title={"Analytics temporarily unavailable"}
          subtitle={state.message}
        />
      }
      >
      </PageShell>
    );
  }

  const { operations, reviewer, governance, automation, artifacts } = state.data;

  return (
    <PageShell
      width="full" data-analytics-ready
      header={
        <PageHeader
          eyebrow={"Operations Center · Analytics"}
          title={"Operational analytics"}
          subtitle={"Counts taken directly from your workspace records. Nothing is estimated, and nothing here is a prediction or a legal or admissibility score."}
          secondaryActions={
            <>
              <div
              className="apf-muted"
              style={{ display: "flex", gap: 12, alignItems: "center" }}
              >
              <label
              htmlFor="analytics-window-select"
              style={{ fontSize: 12, color: "var(--ink-muted)" }}
              >
              Window
              </label>
              <AppListbox
                value={String(windowDays)}
                options={allowedWindowOptions.map((d) => ({ value: String(d), label: `Last ${d} days` }))}
                onChange={(selected) => {
                  const next = Number(selected) as AnalyticsWindowOption;
                  if (allowedWindowOptions.includes(next)) {
                    setWindowDays(next);
                  }
                }}
                id="analytics-window-select"
                triggerProps={{ "data-analytics-window-select": "" }}
              />
              {headerWindow ? (
              <span
              data-analytics-window-active
              style={{ fontSize: 11, color: "var(--ink-muted)" }}
              >
              {formatUserDate(headerWindow.start)} →{" "}
              {formatUserDate(headerWindow.end)}
              </span>
              ) : null}
              {windowContract ? (
              <span
              data-analytics-window-contract
              data-analytics-window-min={windowContract.minDays}
              data-analytics-window-max={windowContract.maxDays}
              style={{ fontSize: 11, color: "var(--ink-muted)" }}
              title={`The API clamps any window to ${windowContract.minDays}–${windowContract.maxDays} days.`}
              >
              {windowContract.minDays}–{windowContract.maxDays} day range
              </span>
              ) : null}
              </div>
            </>
          }
        />
      }
      >

      <section
        className="apf-section"
        data-analytics-honesty-notice
        style={{
          borderInlineStart: "4px solid var(--info)",
          paddingInlineStart: 12,
          background: "var(--info-subtle-bg)",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "var(--info)" }}>
          <strong>How to read this page.</strong> Each tile counts one kind
          of workspace record. A tile shows "—" with an amber badge when its
          source could not be read; we never estimate. Figures limited to
          a time window say "selected period".
        </p>
      </section>

      {/* -------------------- Operations overview -------------------- */}
      <section
        className="apf-section"
        data-analytics-section="operations"
      >
        <header className="apf-section-head">
          <h2 className="apf-section-title">Operations overview</h2>
          <span className="apf-section-note">
            Workspace pulse: evidence flow, open cases, reviewer headcount.
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            envelope={operations}
            metric="evidenceCreated"
            value={operations?.metrics.evidenceCreated ?? null}
            label="Evidence created"
            hint="In the selected period"
          />
          <MetricCard
            envelope={operations}
            metric="evidenceFinalized"
            value={operations?.metrics.evidenceFinalized ?? null}
            label="Evidence reported"
            hint="Reported, in the selected period"
          />
          <MetricCard
            envelope={operations}
            metric="openCases"
            value={operations?.metrics.openCases ?? null}
            label="Open cases"
            hint="Open"
          />
          <MetricCard
            envelope={operations}
            metric="openReviewWorkflows"
            value={operations?.metrics.openReviewWorkflows ?? null}
            label="Open review workflows"
            hint="Not yet approved or closed"
          />
          <MetricCard
            envelope={operations}
            metric="openEscalations"
            value={operations?.metrics.openEscalations ?? null}
            label="Open escalations"
            hint="Open"
          />
          <MetricCard
            envelope={operations}
            metric="reviewerCount"
            value={operations?.metrics.reviewerCount ?? null}
            label="Active reviewers"
            hint="Owners, admins and members"
          />
        </div>
      </section>

      {/* -------------------- Reviewer analytics -------------------- */}
      <section className="apf-section" data-analytics-section="reviewer">
        <header className="apf-section-head">
          <h2 className="apf-section-title">Reviewer activity</h2>
          <span className="apf-section-note">
            Review queue depth, assignment fill rate, escalation rhythm.
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            envelope={reviewer}
            metric="activeReviews"
            value={reviewer?.metrics.activeReviews ?? null}
            label="Active reviews"
            hint="Still open"
          />
          <MetricCard
            envelope={reviewer}
            metric="assignedReviews"
            value={reviewer?.metrics.assignedReviews ?? null}
            label="Assigned reviews"
            hint="Assigned to a reviewer"
          />
          <MetricCard
            envelope={reviewer}
            metric="overdueReviews"
            value={reviewer?.metrics.overdueReviews ?? null}
            label="Overdue reviews"
            hint="Past their due date"
          />
          <MetricCard
            envelope={reviewer}
            metric="openEscalations"
            value={reviewer?.metrics.openEscalations ?? null}
            label="Open escalations"
            hint="Open"
          />
          <MetricCard
            envelope={reviewer}
            metric="resolvedEscalationsInWindow"
            value={reviewer?.metrics.resolvedEscalationsInWindow ?? null}
            label="Escalations resolved"
            hint="Resolved, in the selected period"
          />
        </div>
      </section>

      {/* -------------------- Governance analytics -------------------- */}
      <section className="apf-section" data-analytics-section="governance">
        <header className="apf-section-head">
          <h2 className="apf-section-title">Governance posture</h2>
          <span className="apf-section-note">
            Legal-hold state and lifecycle. No legal conclusions — just counts.
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            envelope={governance}
            metric="activeLegalHolds"
            value={governance?.metrics.activeLegalHolds ?? null}
            label="Active evidence holds"
            hint="Active"
          />
          <MetricCard
            envelope={governance}
            metric="activeCaseLegalHolds"
            value={governance?.metrics.activeCaseLegalHolds ?? null}
            label="Active case holds"
            hint="Active"
          />
          <MetricCard
            envelope={governance}
            metric="legalHoldsPlacedInWindow"
            value={governance?.metrics.legalHoldsPlacedInWindow ?? null}
            label="Holds placed"
            hint="Placed in the selected period"
          />
          <MetricCard
            envelope={governance}
            metric="legalHoldsReleasedInWindow"
            value={governance?.metrics.legalHoldsReleasedInWindow ?? null}
            label="Holds released"
            hint="Released in the selected period"
          />
        </div>
      </section>

      {/* -------------------- Automation analytics -------------------- */}
      <section className="apf-section" data-analytics-section="automation">
        <header className="apf-section-head">
          <h2 className="apf-section-title">Automation health</h2>
          <span className="apf-section-note">
            Counts of rules, runs and webhook deliveries. Webhook
            destinations and delivery logs are listed under Automation.
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            envelope={automation}
            metric="enabledRules"
            value={automation?.metrics.enabledRules ?? null}
            label="Enabled rules"
            hint="Turned on"
          />
          <MetricCard
            envelope={automation}
            metric="runsInWindow"
            value={automation?.metrics.runsInWindow ?? null}
            label="Runs"
            hint="All, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="runsSucceededInWindow"
            value={automation?.metrics.runsSucceededInWindow ?? null}
            label="Runs succeeded"
            hint="Succeeded, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="runsFailedInWindow"
            value={automation?.metrics.runsFailedInWindow ?? null}
            label="Runs failed"
            hint="Failed, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="runsSkippedInWindow"
            value={automation?.metrics.runsSkippedInWindow ?? null}
            label="Runs skipped"
            hint="Skipped, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesInWindow"
            value={automation?.metrics.webhookDeliveriesInWindow ?? null}
            label="Webhook deliveries"
            hint="All, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesSucceededInWindow"
            value={
              automation?.metrics.webhookDeliveriesSucceededInWindow ?? null
            }
            label="Webhook 2xx"
            hint="Succeeded, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesFailedInWindow"
            value={
              automation?.metrics.webhookDeliveriesFailedInWindow ?? null
            }
            label="Webhook failed"
            hint="Failed, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesRetryScheduled"
            value={
              automation?.metrics.webhookDeliveriesRetryScheduled ?? null
            }
            label="Webhook retries pending"
            hint="Waiting for their next attempt"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesRetryExhaustedInWindow"
            value={
              automation?.metrics
                .webhookDeliveriesRetryExhaustedInWindow ?? null
            }
            label="Webhook retries exhausted"
            hint="Stopped after the last attempt, in the selected period"
          />
          <MetricCard
            envelope={automation}
            metric="autoDisabledDestinations"
            value={automation?.metrics.autoDisabledDestinations ?? null}
            label="Auto-disabled destinations"
            hint="Turned off after repeated failures"
          />
        </div>
      </section>

      {/* -------------------- Artifact readiness -------------------- */}
      <section className="apf-section" data-analytics-section="artifacts">
        <header className="apf-section-head">
          <h2 className="apf-section-title">Artifact readiness</h2>
          <span className="apf-section-note">
            Reports + verification packages generated in window.
          </span>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <MetricCard
            envelope={artifacts}
            metric="reportsGeneratedInWindow"
            value={artifacts?.metrics.reportsGeneratedInWindow ?? null}
            label="Reports generated"
            hint="Generated in the selected period"
          />
          <MetricCard
            envelope={artifacts}
            metric="packagesGeneratedInWindow"
            value={artifacts?.metrics.packagesGeneratedInWindow ?? null}
            label="Verification packages"
            hint="Generated in the selected period"
          />
        </div>
      </section>

      <footer
        className="apf-section"
        data-analytics-footer
        style={{ fontSize: 11, color: "var(--ink-muted)" }}
      >
        Generated at{" "}
        {state.data.operations?.generatedAt
          ? formatUserDateTime(state.data.operations.generatedAt)
          : "unknown"}{" "}
        · Hover "Workspace records" on a tile to see exactly what it counts.
      </footer>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Default export — PageRouteGate enforces ANALYTICS_VIEW.
// ---------------------------------------------------------------------------

export default function AnalyticsPage(): JSX.Element {
  return (
    <PageRouteGate routeId="operations.analytics">
      <AnalyticsPageInner />
    </PageRouteGate>
  );
}
