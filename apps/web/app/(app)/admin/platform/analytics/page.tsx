"use client";

/**
 * Phase E4 — Operational Analytics page.
 *
 * Lives UNDER the Operations Center hub (`/admin/platform/analytics`). NOT a root
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

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import {
  useActiveSpaceId,
} from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { formatUserDate, formatUserDateTime } from "../../../../../lib/date";

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
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: degraded ? "#fffbeb" : "#ffffff",
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "#64748b",
        }}
      >
        {props.label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4 }}>
        {degraded ? "—" : formatCount(props.value)}
      </div>
      {props.hint ? (
        <div
          style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}
          data-analytics-metric-hint={props.metric}
        >
          {props.hint}
        </div>
      ) : null}
      {trace ? (
        <div
          style={{ fontSize: 10, color: "#94a3b8", marginTop: 8 }}
          data-analytics-source-trace={props.metric}
          title={`source=${trace.source} filter=${trace.filter} windowed=${trace.windowed ? "yes" : "no"}`}
        >
          source: {trace.source}
          {trace.windowed ? " · windowed" : ""}
        </div>
      ) : null}
      {degraded ? (
        <div
          style={{
            fontSize: 10,
            color: "#92400e",
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
  const [windowDays, setWindowDays] = useState<AnalyticsWindowOption>(DEFAULT_WINDOW);
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
          <div className="cc-skeleton" />
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
          subtitle={"Operational analytics require the ANALYTICS_VIEW capability (team writer or admin)."}
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
          subtitle={"Real counts from real tables. Every value traces to a Prisma model + filter. No fake KPIs, no AI predictions, no legal/admissibility scores — operational signal only."}
          secondaryActions={
            <>
              <div
              className="cc-meta"
              style={{ display: "flex", gap: 12, alignItems: "center" }}
              >
              <label
              htmlFor="analytics-window-select"
              style={{ fontSize: 12, color: "#64748b" }}
              >
              Window
              </label>
              <select
              id="analytics-window-select"
              data-analytics-window-select
              value={windowDays}
              onChange={(e) => {
              const next = Number(e.target.value) as AnalyticsWindowOption;
              if (allowedWindowOptions.includes(next)) {
              setWindowDays(next);
              }
              }}
              style={{
              fontSize: 13,
              padding: "4px 8px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              }}
              >
              {allowedWindowOptions.map((d) => (
              <option key={d} value={d}>
              Last {d} days
              </option>
              ))}
              </select>
              {headerWindow ? (
              <span
              data-analytics-window-active
              style={{ fontSize: 11, color: "#94a3b8" }}
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
              style={{ fontSize: 11, color: "#94a3b8" }}
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
          borderLeft: "4px solid #2563eb",
          paddingLeft: 12,
          background: "#eff6ff",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "#1e3a8a" }}>
          <strong>How to read this page.</strong> Each tile shows a count
          from a specific Prisma model. Tiles render "—" with an amber
          badge when the underlying source failed — we never estimate.
          Window-bounded metrics show "windowed" in the source trace.
        </p>
      </section>

      {/* -------------------- Operations overview -------------------- */}
      <section
        className="apf-section"
        data-analytics-section="operations"
      >
        <header className="cc-section-header">
          <h2 className="apf-section-title">Operations overview</h2>
          <span className="cc-section-subtitle">
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
            hint="in window"
          />
          <MetricCard
            envelope={operations}
            metric="evidenceFinalized"
            value={operations?.metrics.evidenceFinalized ?? null}
            label="Evidence reported"
            hint="status=REPORTED, in window"
          />
          <MetricCard
            envelope={operations}
            metric="openCases"
            value={operations?.metrics.openCases ?? null}
            label="Open cases"
            hint="status=OPEN"
          />
          <MetricCard
            envelope={operations}
            metric="openReviewWorkflows"
            value={operations?.metrics.openReviewWorkflows ?? null}
            label="Open review workflows"
            hint="status not in (APPROVED_INTERNAL, CLOSED)"
          />
          <MetricCard
            envelope={operations}
            metric="openEscalations"
            value={operations?.metrics.openEscalations ?? null}
            label="Open escalations"
            hint="status=OPEN"
          />
          <MetricCard
            envelope={operations}
            metric="reviewerCount"
            value={operations?.metrics.reviewerCount ?? null}
            label="Active reviewers"
            hint="OWNER + ADMIN + MEMBER"
          />
        </div>
      </section>

      {/* -------------------- Reviewer analytics -------------------- */}
      <section className="apf-section" data-analytics-section="reviewer">
        <header className="cc-section-header">
          <h2 className="apf-section-title">Reviewer activity</h2>
          <span className="cc-section-subtitle">
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
            hint="open statuses"
          />
          <MetricCard
            envelope={reviewer}
            metric="assignedReviews"
            value={reviewer?.metrics.assignedReviews ?? null}
            label="Assigned reviews"
            hint="assignedToUserId set"
          />
          <MetricCard
            envelope={reviewer}
            metric="overdueReviews"
            value={reviewer?.metrics.overdueReviews ?? null}
            label="Overdue reviews"
            hint="dueAt < now"
          />
          <MetricCard
            envelope={reviewer}
            metric="openEscalations"
            value={reviewer?.metrics.openEscalations ?? null}
            label="Open escalations"
            hint="status=OPEN"
          />
          <MetricCard
            envelope={reviewer}
            metric="resolvedEscalationsInWindow"
            value={reviewer?.metrics.resolvedEscalationsInWindow ?? null}
            label="Escalations resolved"
            hint="status=RESOLVED, in window"
          />
        </div>
      </section>

      {/* -------------------- Governance analytics -------------------- */}
      <section className="apf-section" data-analytics-section="governance">
        <header className="cc-section-header">
          <h2 className="apf-section-title">Governance posture</h2>
          <span className="cc-section-subtitle">
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
            hint="status=ACTIVE"
          />
          <MetricCard
            envelope={governance}
            metric="activeCaseLegalHolds"
            value={governance?.metrics.activeCaseLegalHolds ?? null}
            label="Active case holds"
            hint="status=ACTIVE"
          />
          <MetricCard
            envelope={governance}
            metric="legalHoldsPlacedInWindow"
            value={governance?.metrics.legalHoldsPlacedInWindow ?? null}
            label="Holds placed"
            hint="placedAtUtc in window"
          />
          <MetricCard
            envelope={governance}
            metric="legalHoldsReleasedInWindow"
            value={governance?.metrics.legalHoldsReleasedInWindow ?? null}
            label="Holds released"
            hint="releasedAtUtc in window"
          />
        </div>
      </section>

      {/* -------------------- Automation analytics -------------------- */}
      <section className="apf-section" data-analytics-section="automation">
        <header className="cc-section-header">
          <h2 className="apf-section-title">Automation health</h2>
          <span className="cc-section-subtitle">
            Bounded rules + run + webhook delivery counts. Detailed
            webhook destinations and delivery logs are exposed via the
            backend `/v1/automation/webhooks` and
            `/v1/automation/webhook-deliveries` endpoints for API /
            automation use; this surface shows aggregate counters only.
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
            hint="enabled=true"
          />
          <MetricCard
            envelope={automation}
            metric="runsInWindow"
            value={automation?.metrics.runsInWindow ?? null}
            label="Runs"
            hint="all statuses, in window"
          />
          <MetricCard
            envelope={automation}
            metric="runsSucceededInWindow"
            value={automation?.metrics.runsSucceededInWindow ?? null}
            label="Runs succeeded"
            hint="status=SUCCEEDED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="runsFailedInWindow"
            value={automation?.metrics.runsFailedInWindow ?? null}
            label="Runs failed"
            hint="status=FAILED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="runsSkippedInWindow"
            value={automation?.metrics.runsSkippedInWindow ?? null}
            label="Runs skipped"
            hint="status=SKIPPED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesInWindow"
            value={automation?.metrics.webhookDeliveriesInWindow ?? null}
            label="Webhook deliveries"
            hint="all statuses, in window"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesSucceededInWindow"
            value={
              automation?.metrics.webhookDeliveriesSucceededInWindow ?? null
            }
            label="Webhook 2xx"
            hint="status=SUCCEEDED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesFailedInWindow"
            value={
              automation?.metrics.webhookDeliveriesFailedInWindow ?? null
            }
            label="Webhook failed"
            hint="status=FAILED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesRetryScheduled"
            value={
              automation?.metrics.webhookDeliveriesRetryScheduled ?? null
            }
            label="Webhook retries pending"
            hint="status=RETRY_SCHEDULED"
          />
          <MetricCard
            envelope={automation}
            metric="webhookDeliveriesRetryExhaustedInWindow"
            value={
              automation?.metrics
                .webhookDeliveriesRetryExhaustedInWindow ?? null
            }
            label="Webhook retries exhausted"
            hint="status=RETRY_EXHAUSTED, in window"
          />
          <MetricCard
            envelope={automation}
            metric="autoDisabledDestinations"
            value={automation?.metrics.autoDisabledDestinations ?? null}
            label="Auto-disabled destinations"
            hint="autoDisabledAt set"
          />
        </div>
      </section>

      {/* -------------------- Artifact readiness -------------------- */}
      <section className="apf-section" data-analytics-section="artifacts">
        <header className="cc-section-header">
          <h2 className="apf-section-title">Artifact readiness</h2>
          <span className="cc-section-subtitle">
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
            hint="generatedAtUtc in window"
          />
          <MetricCard
            envelope={artifacts}
            metric="packagesGeneratedInWindow"
            value={artifacts?.metrics.packagesGeneratedInWindow ?? null}
            label="Verification packages"
            hint="generatedAtUtc in window"
          />
        </div>
      </section>

      <footer
        className="apf-section"
        data-analytics-footer
        style={{ fontSize: 11, color: "#94a3b8" }}
      >
        Generated at{" "}
        {state.data.operations?.generatedAt
          ? formatUserDateTime(state.data.operations.generatedAt)
          : "unknown"}{" "}
        · Hover any "source: …" badge to see the table + filter used.
      </footer>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Default export — PageRouteGate enforces ANALYTICS_VIEW.
// ---------------------------------------------------------------------------

export default function AnalyticsPage(): JSX.Element {
  return (
    <PageRouteGate routeId="platform.analytics">
      <AnalyticsPageInner />
    </PageRouteGate>
  );
}
