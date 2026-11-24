"use client";

/**
 * Phase 25 — SLA Operations Dashboard.
 *
 * Workspace-level SLA telemetry: backlog totals, breached counts,
 * reviewer workload snapshot, top reviewers by load, escalation
 * pressure. Operator-readable only — no per-reviewer private text.
 *
 * TEAM-SPEC §2 item 8 / §3 (2026-11-23) — no fabricated figures:
 *   - `slaComplianceRate` is null when no review completed in the range; it
 *     reads "No completed reviews in range", never 100% or 0%.
 *   - a null mean resolution or capacity reads "No data", never 0 h.
 *   - the by-stage "escalated" row counts reviews whose stored stage is
 *     ESCALATED (a manual escalation decision). An "open escalation" is an
 *     escalation record that is open, acknowledged or reassigned — the
 *     Escalations page's "Active" filter — so the two numbers can differ.
 *   - a failed dashboard read renders an error with Retry, never an endless
 *     "Loading…".
 *
 * TEAM-UI-SPEC §1/§3 (round 3): cards are `app-panel`, figures are
 * `app-metric-card` with the semantic metric tone, tables are `.app-table`
 * inside a scrolling `.app-table-surface`, and "View workspace health" lives
 * here (moved from the My reviews header) through `useHealthDestination`.
 */

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  NoWorkloadSnapshotsEmptyState,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import { formatCellDateTime } from "../../../../lib/date";
import Link from "next/link";
import { PageShell } from "../../../../components/ui/PageShell";
// TEAM-UI-SPEC (structure) — the one review page header (icon title row, no eyebrow).
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";
import { Badge } from "../../../../components/ui/Badge";
import { useHealthDestination } from "../../../../lib/navigation/healthDestination";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { useReviewDestination } from "../../../../components/reviewer-experience/reviewDestination";
import { ReviewDestinationLink } from "../../../../components/reviewer-experience/ReviewDestinationLink";
import {
  OPEN_ESCALATION_DEFINITION,
  complianceLabel,
  hoursOrNoData,
  splitStageCounts,
  stageRowLabel,
} from "../../../../components/reviewer-experience/monitoringDisplay";

type EscalationAnalytics = {
  range: { startUtc: string; endUtc: string };
  totalOpen: number;
  totalOpenedInRange: number;
  totalResolvedInRange: number;
  meanResolutionMs: number | null;
  byDay: Array<{
    dayBucket: string;
    opened: number;
    resolved: number;
    suppressed: number;
  }>;
  hotspots: Array<{
    reason: string;
    openCount: number;
    resolvedCount: number;
    meanResolutionMs: number | null;
  }>;
};

type ReviewerPerformance = {
  range: { startUtc: string; endUtc: string };
  rows: Array<{
    reviewerUserId: string;
    active: number;
    completedInRange: number;
    approvedInRange: number;
    rejectedInRange: number;
    overdue: number;
    escalated: number;
    meanResolutionMs: number | null;
    /** TEAM-SPEC §2 item 8 — null when no review completed in the range. */
    slaComplianceRate: number | null;
    capacityScore: number | null;
  }>;
};

type DashboardResponse = {
  counts: {
    byStage: Record<string, number>;
    /** T-057 — open reviews by stage, finished reviews by outcome. */
    openByStage?: Record<string, number>;
    closedByStage?: Record<string, number>;
    /** T-052 — open reviews that are escalated (unit: reviews). */
    escalatedReviews?: number;
    overdue: number;
    dueSoon: number;
    unassigned: number;
    assignedToMe: number;
  };
  openEscalations: number;
  criticalEscalationsOpen: number;
  workloadTop: Array<{
    reviewerUserId: string;
    activeReviewCount: number;
    overdueReviewCount: number;
    dueSoonReviewCount: number;
    escalatedReviewCount: number;
    needsInfoReviewCount: number;
    capacityScore: number;
    computedAtUtc: string;
  }>;
  suggestions: Array<{
    reviewerUserId: string;
    capacityScore: number;
    activeReviewCount: number;
    overdueReviewCount: number;
    rationale: string;
  }>;
};

// Phase 38.11 — wrap in canonical PageRouteGate. `review.sla` is
// PERSONAL_OR_ORG + the workspace's reviewer-operations entitlement
// (TEAM-SPEC R1); the gate renders the structured refusal otherwise.
export default function SlaDashboardPage() {
  return (
    <PageRouteGate routeId="review.sla">
      <SlaDashboardPageInner />
    </PageRouteGate>
  );
}

type ReviewReminder = {
  id: string;
  kind: string;
  status: "SCHEDULED" | "DELIVERED" | "SUPPRESSED" | "FAILED";
  safeSummary: string;
  createdAt: string;
};

const REMINDER_STATUS_LABEL: Record<ReviewReminder["status"], string> = {
  SCHEDULED: "Waiting to send",
  DELIVERED: "Emailed",
  SUPPRESSED: "Shown here only",
  FAILED: "Could not send",
};

function SlaDashboardPageInner() {
  // The ACTIVE workspace (personal or organization) from the envelope.
  const teamId = useActiveSpaceId();
  const policyDestination = useReviewDestination("review.settings", {
    label: "Review settings",
  });
  // ADM-013 — the ONE authority for where "check the health" goes for THIS
  // actor (label with href; null → no link). TEAM-UI-SPEC §3 moved it here.
  const healthDestination = useHealthDestination();
  const healthLink = healthDestination ? (
    <Link href={healthDestination.href} className="app-ghost-action" data-sla-health-link>
      {healthDestination.label}
    </Link>
  ) : undefined;
  const [dashboardAttempt, setDashboardAttempt] = useState(0);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<EscalationAnalytics | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerPerformance | null>(null);
  // PRO-R2-15 — a failed analytics read is a stated failure with Retry, not
  // "Loading…" forever.
  const [analyticsFailed, setAnalyticsFailed] = useState(false);
  const [analyticsAttempt, setAnalyticsAttempt] = useState(0);
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [reminders, setReminders] = useState<ReviewReminder[] | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    setError(null);
    apiFetch(
      `/v1/reviewer-ops/dashboard?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: DashboardResponse) => {
        setData(r);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load dashboard." }).message),
      );
    // `dashboardAttempt` re-runs the read when Retry is pressed.
  }, [teamId, dashboardAttempt]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/reviewer-ops/reminders?teamId=${encodeURIComponent(teamId)}`, { method: "GET" })
      .then((r: { reminders: ReviewReminder[] }) => {
        if (!cancelled) setReminders(r.reminders);
      })
      .catch(() => {
        if (!cancelled) setReminders(null);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Phase 25.5 — analytics + reviewer performance.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    Promise.all([
      apiFetch(
        `/v1/reviewer-ops/analytics/escalations?teamId=${encodeURIComponent(
          teamId,
        )}&rangeDays=${rangeDays}`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/reviewer-ops/analytics/reviewers?teamId=${encodeURIComponent(
          teamId,
        )}&rangeDays=${rangeDays}&limit=20`,
        { method: "GET" },
      ),
    ])
      .then(([a, r]: [EscalationAnalytics, ReviewerPerformance]) => {
        if (cancelled) return;
        setAnalytics(a);
        setReviewers(r);
        setAnalyticsFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAnalytics(null);
        setReviewers(null);
        setAnalyticsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, rangeDays, analyticsAttempt]);

  // PageRouteGate already guaranteed ALLOWED. If the canonical
  // envelope is still hydrating we render the bounded loading shell.
  if (!teamId) {
    return (
      <PageShell
        width="full"
        data-sla-loading
        header={
          <ReviewPageHeader title="SLA monitoring" subtitle="Loading workspace…" />
        }
      />
    );
  }
  if (!data) {
    return (
      <PageShell
        width="full"
        header={
          <ReviewPageHeader title="SLA monitoring" secondaryActions={healthLink} />
        }
      >
        <ReviewHubNav active="monitoring" monitoringView="sla" />
        {reminders && reminders.length > 0 ? (
        <section className="app-panel app-panel__body review-panel-stack">
            <h3 className="app-panel__title">Reminders</h3>
            <div className="app-table-surface app-table-surface--scroll">
            <table className="app-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Reminder</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {reminders.map((r) => (
                  <tr key={r.id}>
                    <td>{formatCellDateTime(r.createdAt)}</td>
                    <td>{r.safeSummary}</td>
                    <td>{REMINDER_STATUS_LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
        </section>
      ) : null}

      {error ? (
          <div className="app-alert app-alert--danger" role="alert" data-sla-dashboard-error>
            {error}{" "}
            <button
              type="button"
              className="app-secondary-action"
              data-sla-dashboard-retry
              onClick={() => setDashboardAttempt((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="app-field-help" aria-live="polite">Loading SLA dashboard…</p>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      width="full"
      header={
        <ReviewPageHeader
          title="SLA monitoring"
          subtitle={
            <span data-sla-dashboard-intro>
              Read-only operations dashboard of current SLA pressure: backlog,
              overdue reviews and reviewer workload. Review deadlines are set in{" "}
              {policyDestination ? (
                <ReviewDestinationLink destination={policyDestination} />
              ) : (
                "the workspace's review settings"
              )}
              .
            </span>
          }
          secondaryActions={healthLink}
        />
      }
    >
      <ReviewHubNav active="monitoring" monitoringView="sla" />
      {/* Review automation only: this page's SLA and escalation figures are
          produced by the reviewer reconcile sweep, so a stale sweep is said
          here, in one line. Unrelated platform checks are not. Global service
          status lives in the header indicator. */}
      <RuntimeStatusBanner requires={["reviewAutomation"]} />

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">Freshness and runtime</h3>
        <div className="review-metric-grid">
          <Stat
            label="Latest workload snapshot"
            value={
              data.workloadTop[0]?.computedAtUtc
                ? formatCellDateTime(data.workloadTop[0].computedAtUtc)
                : "Not yet available"
            }
            tone=""
          />
          <Stat
            label="Analytics range end"
            value={
              analytics?.range.endUtc
                ? formatCellDateTime(analytics.range.endUtc)
                : "Not yet loaded"
            }
            tone=""
          />
                  </div>
        <p className="app-field-help">
          Workload and assignment suggestions refresh every few minutes.
          Escalation analytics refresh separately. When the status banner says
          review automation is delayed and no workload snapshot is shown, treat
          the workload sections as out of date rather than as zero.
        </p>
      </section>

      {error ? (
        <div className="app-alert app-alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">Workspace pressure</h3>
        <div className="review-metric-grid">
          <Stat label="Unassigned" value={data.counts.unassigned} tone="" />
          <Stat
            label="Due soon"
            value={data.counts.dueSoon}
            tone={data.counts.dueSoon > 0 ? "warn" : ""}
          />
          <Stat
            label="Overdue"
            value={data.counts.overdue}
            tone={data.counts.overdue > 0 ? "alert" : ""}
          />
          <Stat label="My reviews" value={data.counts.assignedToMe} tone="" />
          {typeof data.counts.escalatedReviews === "number" ? (
            <Stat
              label="Escalated reviews"
              value={data.counts.escalatedReviews}
              tone={data.counts.escalatedReviews > 0 ? "warn" : ""}
              title="Open reviews with escalated status or at least one active escalation (unit: reviews)."
            />
          ) : null}
          {/* T-052 (stage C) — an escalation count, labelled as escalations:
              one review can carry several. */}
          <Stat
            label="Active escalations"
            value={data.openEscalations}
            tone={data.openEscalations > 0 ? "warn" : ""}
            title={OPEN_ESCALATION_DEFINITION}
          />
          <Stat
            label="Critical active escalations"
            value={data.criticalEscalationsOpen}
            tone={data.criticalEscalationsOpen > 0 ? "alert" : ""}
          />
        </div>
      </section>

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">By stage</h3>
        <p className="app-field-help" data-sla-by-stage-definition>
          Counts reviews by their recorded stage; open work and finished
          reviews are listed apart. &ldquo;{stageRowLabel("ESCALATED")}&rdquo;
          is a recorded status, set by an escalation, a first/second conflict or
          an unresolved adjudication. It is not the same as active escalations:{" "}
          {OPEN_ESCALATION_DEFINITION}
        </p>
        <div className="app-table-surface app-table-surface--scroll">
        <table className="app-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Reviews</th>
            </tr>
          </thead>
          {(() => {
            const { open, closed } = splitStageCounts(data.counts);
            const row = (group: "open" | "closed") => ([stage, count]: [string, number]) => (
              <tr key={`${group}-${stage}`} data-sla-stage-group={group}>
                <td
                  data-sla-stage={stage}
                  title={stage.toUpperCase() === "ESCALATED" ? OPEN_ESCALATION_DEFINITION : undefined}
                >
                  {stageRowLabel(stage)}
                </td>
                <td>{count}</td>
              </tr>
            );
            return (
              <>
                <tbody data-sla-stage-section="open">
                  <tr>
                    <th scope="rowgroup" colSpan={2}>Open reviews</th>
                  </tr>
                  {open.map(row("open"))}
                </tbody>
                <tbody data-sla-stage-section="closed">
                  <tr>
                    <th scope="rowgroup" colSpan={2}>Finished reviews</th>
                  </tr>
                  {closed.map(row("closed"))}
                </tbody>
              </>
            );
          })()}
        </table>
        </div>
      </section>

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">Reviewer workload (latest snapshots)</h3>
        {data.workloadTop.length === 0 ? (
          <p className="app-field-help">
            No workload snapshot yet. It appears a few minutes after reviews are assigned.
          </p>
        ) : (
          <div className="app-table-surface app-table-surface--scroll">
          <table className="app-table">
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Active</th>
                <th>Due soon</th>
                <th>Overdue</th>
                <th>Escalated</th>
                <th>Capacity</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {data.workloadTop.map((w) => (
                <tr key={w.reviewerUserId}>
                  <td>
                    <span className="app-table__muted">
                      {w.reviewerUserId.slice(0, 12)}…
                    </span>
                  </td>
                  <td>{w.activeReviewCount}</td>
                  <td>{w.dueSoonReviewCount}</td>
                  <td>{w.overdueReviewCount}</td>
                  <td>{w.escalatedReviewCount}</td>
                  <td>
                    <Badge tone={capacityTone(w.capacityScore)} subtle>
                      {w.capacityScore}
                    </Badge>
                  </td>
                  <td>
                    <span className="app-field-help">
                      {formatCellDateTime(w.computedAtUtc)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">Assignment suggestions</h3>
        {data.suggestions.length === 0 ? (
          <p className="app-field-help">
            No suggestions yet. They appear once reviewer workload has been measured.
          </p>
        ) : (
          <ul className="review-tools">
            {data.suggestions.map((s) => (
              <li key={s.reviewerUserId} className="review-tools__row">
                <span className="review-chip-row">
                  <code>{s.reviewerUserId.slice(0, 12)}…</code>
                  <Badge tone={capacityTone(s.capacityScore)} subtle>
                    {s.capacityScore}
                  </Badge>
                </span>
                <span className="app-field-help">{s.rationale}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="app-field-help">
          Suggestions are advisory. Nothing is assigned automatically; you decide.
        </p>
      </section>

      <section className="app-panel app-panel__body review-panel-stack">
        <div className="app-panel__head-row">
          <h3 className="app-panel__title">Escalation analytics</h3>
          <AppListbox
            ariaLabel="Escalation analytics range"
            value={String(rangeDays)}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "14", label: "Last 14 days" },
              { value: "30", label: "Last 30 days" },
              { value: "60", label: "Last 60 days" },
              { value: "90", label: "Last 90 days" },
            ]}
            onChange={(next) => setRangeDays(Number(next))}
          />
        </div>
        {analyticsFailed ? (
          <p className="app-field-help" role="alert" data-sla-analytics-failed>
            Analytics could not be loaded.{" "}
            <button type="button" className="app-secondary-action" onClick={() => setAnalyticsAttempt((n) => n + 1)}>
              Retry
            </button>
          </p>
        ) : !analytics ? (
          <p className="app-field-help">Loading analytics…</p>
        ) : (
          <>
            <div className="review-metric-grid">
              <Stat label="Open now" value={analytics.totalOpen} tone="" title={OPEN_ESCALATION_DEFINITION} />
              <Stat
                label="Opened in range"
                value={analytics.totalOpenedInRange}
                tone=""
              />
              <Stat
                label="Resolved in range"
                value={analytics.totalResolvedInRange}
                tone=""
              />
              <Stat
                label="Mean resolution (h)"
                value={hoursOrNoData(analytics.meanResolutionMs)}
                tone=""
              />
            </div>

            <h4 className="app-field-label">Trend (opened vs resolved)</h4>
            <SparkBars buckets={analytics.byDay} />

            <h4 className="app-field-label">Reason hotspots</h4>
            {analytics.hotspots.length === 0 ? (
              <p className="app-field-help">No escalations in this range.</p>
            ) : (
              <div className="app-table-surface app-table-surface--scroll">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>Open</th>
                    <th>Resolved</th>
                    <th>Mean resolution (h)</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.hotspots.map((h) => (
                    <tr key={h.reason}>
                      <td>
                        <span className="app-table__muted">
                          {escalationReasonLabel(h.reason)}
                        </span>
                      </td>
                      <td>{h.openCount}</td>
                      <td>{h.resolvedCount}</td>
                      <td>
                        {hoursOrNoData(h.meanResolutionMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="app-panel app-panel__body review-panel-stack">
        <h3 className="app-panel__title">Reviewer performance</h3>
        {analyticsFailed ? (
          <p className="app-field-help" role="alert" data-sla-reviewers-failed>
            Reviewer performance could not be loaded.{" "}
            <button type="button" className="app-secondary-action" onClick={() => setAnalyticsAttempt((n) => n + 1)}>
              Retry
            </button>
          </p>
        ) : !reviewers ? (
          <p className="app-field-help">Loading…</p>
        ) : reviewers.rows.length === 0 ? (
          <NoWorkloadSnapshotsEmptyState />
        ) : (
          <div className="app-table-surface app-table-surface--scroll">
          <table className="app-table">
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Active</th>
                <th>Completed</th>
                <th>Approved</th>
                <th>Rejected</th>
                <th>Overdue</th>
                <th>Escalated</th>
                <th>SLA</th>
                <th>Mean (h)</th>
                <th>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {reviewers.rows.map((r) => (
                <tr key={r.reviewerUserId}>
                  <td>
                    <span className="app-table__muted">
                      {r.reviewerUserId.slice(0, 12)}…
                    </span>
                  </td>
                  <td>{r.active}</td>
                  <td>{r.completedInRange}</td>
                  <td>{r.approvedInRange}</td>
                  <td>{r.rejectedInRange}</td>
                  <td>{r.overdue}</td>
                  <td>{r.escalated}</td>
                  <td data-sla-compliance={r.slaComplianceRate === null ? "none" : "value"}>
                    {complianceLabel(r.slaComplianceRate)}
                  </td>
                  <td>{hoursOrNoData(r.meanResolutionMs)}</td>
                  <td>
                    {typeof r.capacityScore === "number" ? (
                      <Badge tone={capacityTone(r.capacityScore)} subtle>
                        {r.capacityScore}
                      </Badge>
                    ) : (
                      "No data"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </PageShell>
  );
}

function SparkBars({
  buckets,
}: {
  buckets: Array<{ dayBucket: string; opened: number; resolved: number }>;
}) {
  if (buckets.length === 0) return null;
  const max = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.opened, b.resolved)),
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        height: 60,
        marginTop: 4,
      }}
    >
      {buckets.map((b) => (
        <div
          key={b.dayBucket}
          title={`${b.dayBucket}: ${b.opened} opened, ${b.resolved} resolved`}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column-reverse",
            gap: 1,
            minWidth: 4,
          }}
        >
          <div
            style={{
              height: `${(b.opened / max) * 50}%`,
              background: "var(--status-risk-solid)",
              minHeight: b.opened > 0 ? 2 : 0,
            }}
          />
          <div
            style={{
              height: `${(b.resolved / max) * 50}%`,
              background: "var(--status-verified-solid)",
              minHeight: b.resolved > 0 ? 2 : 0,
            }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * A FIGURE, AND WHETHER IT NEEDS ATTENTION.
 *
 * The three tones were a hand-written palette of raw hex — a slate default, an
 * amber, a red — carried in this file beside the second design system. They
 * are the product's semantic warning and danger, so they are drawn from the
 * canonical tokens, and the tone always reaches the reader as a WORD as well
 * as a colour: the label already names what the figure is, and an alert tone
 * adds a marker that survives being printed in grey.
 */
function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: number | string;
  tone: "" | "warn" | "alert";
  /** Optional definition, shown as a tooltip. */
  title?: string;
}) {
  // TEAM-UI-SPEC §1 — the canonical metric card and its semantic tone; the
  // tone still reaches the reader as a word, not only a colour.
  const metricTone = tone === "alert" ? "danger" : tone === "warn" ? "warning" : "neutral";
  return (
    <div
      className="app-metric-card"
      data-app-metric-tone={metricTone}
      data-sla-stat-tone={tone === "" ? "neutral" : tone}
      title={title}
    >
      <div className="app-metric-card__value">{value}</div>
      <div className="app-metric-card__label">
        {label}
        {tone === "alert" ? " · needs attention" : tone === "warn" ? " · watch" : ""}
      </div>
    </div>
  );
}

/**
 * A REVIEWER'S SPARE CAPACITY, AS A BAND.
 *
 * Four raw-hex bands lived here. They are the product's four semantic tones,
 * so the band is now named and the canonical `<Badge>` renders it — which
 * also means the number stops being the only thing carrying the meaning.
 */
function capacityTone(score: number): "verified" | "pending" | "risk" | "info" {
  if (score < 25) return "risk";
  if (score < 50) return "pending";
  if (score < 80) return "info";
  return "verified";
}

