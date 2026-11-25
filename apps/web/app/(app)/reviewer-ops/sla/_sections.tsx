"use client";

/**
 * Monitoring sections (stage D, T-078) built from the Phase 25 SLA dashboard:
 * `DeadlinesSection`, `WorkloadSection` and `EscalationAnalytics`. The
 * Monitoring page (`page.tsx`) renders them under one segmented control.
 *
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
import {
  NoWorkloadSnapshotsEmptyState,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import { formatCellDateTime } from "../../../../lib/date";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import type { AppTone } from "../../../../components/app-primitives/AppStatusBadge";
import { reviewerIdentityLabel } from "../../../../lib/reviewer-workspace/reviewer-identity";
import { useOptionalPlatformContext } from "../../../../lib/platform-context/PlatformContextProvider";
import { MultiStageReviewSummaryCard } from "../../../../components/reviewer-experience/MultiStageReviewSummaryCard";
import { ReviewerRoutingRecommendationsPane } from "../../../../components/hidden-feature-panels/HiddenFeaturePanels";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
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
    /** T-085 — projected by the API (display name / masked e-mail). */
    reviewerDisplayName?: string | null;
    reviewerMaskedEmail?: string | null;
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
    reviewerDisplayName?: string | null;
    reviewerMaskedEmail?: string | null;
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
    reviewerDisplayName?: string | null;
    reviewerMaskedEmail?: string | null;
    capacityScore: number;
    activeReviewCount: number;
    overdueReviewCount: number;
    rationale: string;
  }>;
};

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

/** The dashboard read the Deadlines and Workload sections share. */
export function useMonitoringDashboard(teamId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setError(null);
    apiFetch(`/v1/reviewer-ops/dashboard?teamId=${encodeURIComponent(teamId)}`, { method: "GET" })
      .then((r: DashboardResponse) => {
        if (cancelled) return;
        setData(r);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (!cancelled) setError(toSafeUserError(err, { message: "Could not load the monitoring figures." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, retry };
}

function DashboardPending({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return error ? (
    <div className="app-alert app-alert--danger" role="alert" data-sla-dashboard-error>
      {error}{" "}
      <button type="button" className="app-secondary-action" data-sla-dashboard-retry onClick={onRetry}>
        Retry
      </button>
    </div>
  ) : (
    <p className="app-field-help" aria-live="polite">
      Loading monitoring figures…
    </p>
  );
}

/** Monitoring → Deadlines: deadline pressure, open reviews by stage, reminders. */
export function DeadlinesSection({ teamId }: { teamId: string }) {
  const { data, error, retry } = useMonitoringDashboard(teamId);
  const policyDestination = useReviewDestination("review.settings", { label: "Review settings" });
  const [reminders, setReminders] = useState<ReviewReminder[] | null>(null);
  useEffect(() => {
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

  return (
    <div className="review-monitoring-section" data-monitoring-section-body="deadlines">
      {/* Review automation only: these figures come from the review
          automation pass, so a stale pass is said here, in one line. */}
      <RuntimeStatusBanner requires={["reviewAutomation"]} />
      <p className="app-field-help" data-sla-dashboard-intro style={{ margin: 0 }}>
        A read-only operations dashboard of current SLA pressure: open reviews, overdue reviews and active
        escalations. Review deadlines are set in{" "}
        {policyDestination ? <ReviewDestinationLink destination={policyDestination} /> : "the workspace's review settings"}.
      </p>
      {!data ? (
        <DashboardPending error={error} onRetry={retry} />
      ) : (
        <>
          <section className="app-panel app-panel__body review-panel-stack">
            <h2 className="app-panel__title">Workspace pressure</h2>
            <div className="review-metric-grid">
              <Stat label="Unassigned reviews" value={data.counts.unassigned} tone="" />
              <Stat label="Reviews due soon" value={data.counts.dueSoon} tone={data.counts.dueSoon > 0 ? "warn" : ""} />
              <Stat label="Overdue reviews" value={data.counts.overdue} tone={data.counts.overdue > 0 ? "alert" : ""} />
              <Stat label="Assigned to me" value={data.counts.assignedToMe} tone="" />
              {typeof data.counts.escalatedReviews === "number" ? (
                <Stat
                  label="Escalated reviews"
                  value={data.counts.escalatedReviews}
                  tone={data.counts.escalatedReviews > 0 ? "warn" : ""}
                  title="Open reviews with escalated status or at least one active escalation (unit: reviews)."
                />
              ) : null}
              {/* T-052 (stage C) — an escalation count, labelled as escalations. */}
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
            <h2 className="app-panel__title">By stage</h2>
            <p className="app-field-help" data-sla-by-stage-definition>
              Counts reviews by their recorded stage; open work and finished reviews are listed apart. &ldquo;
              {stageRowLabel("ESCALATED")}&rdquo; is a recorded status, set by an escalation, a first/second conflict or
              an unresolved adjudication. It is not the same as active escalations: {OPEN_ESCALATION_DEFINITION}
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
                      <td data-sla-stage={stage} title={stage.toUpperCase() === "ESCALATED" ? OPEN_ESCALATION_DEFINITION : undefined}>
                        {stageRowLabel(stage)}
                      </td>
                      <td>{count}</td>
                    </tr>
                  );
                  return (
                    <>
                      <tbody data-sla-stage-section="open">
                        <tr>
                          <th scope="rowgroup" colSpan={2}>
                            Open reviews
                          </th>
                        </tr>
                        {open.map(row("open"))}
                      </tbody>
                      <tbody data-sla-stage-section="closed">
                        <tr>
                          <th scope="rowgroup" colSpan={2}>
                            Finished reviews
                          </th>
                        </tr>
                        {closed.map(row("closed"))}
                      </tbody>
                    </>
                  );
                })()}
              </table>
            </div>
          </section>
        </>
      )}

      {reminders && reminders.length > 0 ? (
        <section className="app-panel app-panel__body review-panel-stack">
          <h2 className="app-panel__title">Reminders</h2>
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
    </div>
  );
}

/** One routing-recommendations probe: the pane shows only when there are any. */
function useHasRoutingRecommendations(teamId: string): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    setHas(false);
    let cancelled = false;
    apiFetch(`/v1/reviewer/routing-recommendations?teamId=${encodeURIComponent(teamId)}`)
      .then((res: { recommendations?: ReadonlyArray<unknown> }) => {
        if (!cancelled) setHas(Array.isArray(res?.recommendations) && res.recommendations.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHas(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);
  return has;
}

/**
 * Monitoring → Workload: who holds what (T-085: names, never id fragments),
 * assignment suggestions, review stages, routing recommendations and reviewer
 * performance over a range.
 */
export function WorkloadSection({ teamId }: { teamId: string }) {
  const { data, error, retry } = useMonitoringDashboard(teamId);
  const viewerUserId = useOptionalPlatformContext()?.envelope?.user?.id ?? null;
  const hasRouting = useHasRoutingRecommendations(teamId);
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [reviewers, setReviewers] = useState<ReviewerPerformance | null>(null);
  const [reviewersFailed, setReviewersFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReviewersFailed(false);
    apiFetch(
      `/v1/reviewer-ops/analytics/reviewers?teamId=${encodeURIComponent(teamId)}&rangeDays=${rangeDays}&limit=20`,
      { method: "GET" },
    )
      .then((r: ReviewerPerformance) => {
        if (!cancelled) setReviewers(r);
      })
      .catch(() => {
        if (cancelled) return;
        setReviewers(null);
        setReviewersFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, rangeDays, attempt]);
  const nameOf = (r: { reviewerUserId: string; reviewerDisplayName?: string | null; reviewerMaskedEmail?: string | null }) =>
    reviewerIdentityLabel(
      { userId: r.reviewerUserId, displayName: r.reviewerDisplayName ?? null, maskedEmail: r.reviewerMaskedEmail ?? null },
      viewerUserId,
    );

  return (
    <div className="review-monitoring-section" data-monitoring-section-body="workload">
      <RuntimeStatusBanner requires={["reviewAutomation"]} />
      {!data ? (
        <DashboardPending error={error} onRetry={retry} />
      ) : (
        <>
          <section className="app-panel app-panel__body review-panel-stack">
            <h2 className="app-panel__title">Reviewer workload</h2>
            <p className="app-field-help" style={{ margin: 0 }}>
              Latest snapshot{" "}
              {data.workloadTop[0]?.computedAtUtc ? formatCellDateTime(data.workloadTop[0].computedAtUtc) : "not yet available"}.
              Snapshots refresh every few minutes; when review automation is delayed, read them as out of date, not as zero.
            </p>
            {data.workloadTop.length === 0 ? (
              <p className="app-field-help">No workload snapshot yet. It appears a few minutes after reviews are assigned.</p>
            ) : (
              <div className="app-table-surface app-table-surface--scroll">
                <table className="app-table" data-monitoring-workload-table>
                  <thead>
                    <tr>
                      <th>Reviewer</th>
                      <th>Active</th>
                      <th>Due soon</th>
                      <th>Overdue</th>
                      <th>Escalated</th>
                      <th>Capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workloadTop.map((w) => (
                      <tr key={w.reviewerUserId}>
                        <td data-monitoring-reviewer>{nameOf(w)}</td>
                        <td>{w.activeReviewCount}</td>
                        <td>{w.dueSoonReviewCount}</td>
                        <td>{w.overdueReviewCount}</td>
                        <td>{w.escalatedReviewCount}</td>
                        <td>
                          <CapacityText score={w.capacityScore} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="app-panel app-panel__body review-panel-stack">
            <h2 className="app-panel__title">Assignment suggestions</h2>
            {data.suggestions.length === 0 ? (
              <p className="app-field-help">No suggestions yet. They appear once reviewer workload has been measured.</p>
            ) : (
              <ul className="review-tools">
                {data.suggestions.map((s) => (
                  <li key={s.reviewerUserId} className="review-tools__row">
                    <span className="app-status-text-row">
                      <strong data-monitoring-reviewer>{nameOf(s)}</strong>
                      <CapacityText score={s.capacityScore} />
                    </span>
                    <span className="app-field-help">{s.rationale}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="app-field-help">Suggestions are advisory. Nothing is assigned automatically; you decide.</p>
          </section>
        </>
      )}

      {hasRouting ? <ReviewerRoutingRecommendationsPane teamId={teamId} /> : null}
      <MultiStageReviewSummaryCard teamId={teamId} />

      <section className="app-panel app-panel__body review-panel-stack">
        <div className="app-panel__head-row">
          <h2 className="app-panel__title">Reviewer performance</h2>
          <AppListbox
            ariaLabel="Reviewer performance range"
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
        {reviewersFailed ? (
          <p className="app-field-help" role="alert" data-sla-reviewers-failed>
            Reviewer performance could not be loaded.{" "}
            <button type="button" className="app-secondary-action" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </p>
        ) : !reviewers ? (
          <p className="app-field-help">Loading…</p>
        ) : reviewers.rows.length === 0 ? (
          <NoWorkloadSnapshotsEmptyState />
        ) : (
          <div className="app-table-surface app-table-surface--scroll">
            <table className="app-table" data-monitoring-performance-table>
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Active</th>
                  <th>Completed</th>
                  <th>Approved</th>
                  <th>Rejected</th>
                  <th>Overdue</th>
                  <th>Escalated</th>
                  <th>On time</th>
                  <th>Mean (h)</th>
                  <th>Capacity</th>
                </tr>
              </thead>
              <tbody>
                {reviewers.rows.map((r) => (
                  <tr key={r.reviewerUserId}>
                    <td data-monitoring-reviewer>{nameOf(r)}</td>
                    <td>{r.active}</td>
                    <td>{r.completedInRange}</td>
                    <td>{r.approvedInRange}</td>
                    <td>{r.rejectedInRange}</td>
                    <td>{r.overdue}</td>
                    <td>{r.escalated}</td>
                    <td data-sla-compliance={r.slaComplianceRate === null ? "none" : "value"}>{complianceLabel(r.slaComplianceRate)}</td>
                    <td>{hoursOrNoData(r.meanResolutionMs)}</td>
                    <td>{typeof r.capacityScore === "number" ? <CapacityText score={r.capacityScore} /> : "No data"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Monitoring → Metrics: escalation analytics over a range (beside reviewer metrics). */
export function EscalationAnalyticsPanel({ teamId }: { teamId: string }) {
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [analytics, setAnalytics] = useState<EscalationAnalytics | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    apiFetch(`/v1/reviewer-ops/analytics/escalations?teamId=${encodeURIComponent(teamId)}&rangeDays=${rangeDays}`, {
      method: "GET",
    })
      .then((a: EscalationAnalytics) => {
        if (!cancelled) setAnalytics(a);
      })
      .catch(() => {
        if (cancelled) return;
        setAnalytics(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, rangeDays, attempt]);
  return (
    <section className="app-panel app-panel__body review-panel-stack" data-monitoring-escalation-analytics>
      <div className="app-panel__head-row">
        <h2 className="app-panel__title">Escalation analytics</h2>
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
      {failed ? (
        <p className="app-field-help" role="alert" data-sla-analytics-failed>
          Analytics could not be loaded.{" "}
          <button type="button" className="app-secondary-action" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </p>
      ) : !analytics ? (
        <p className="app-field-help">Loading analytics…</p>
      ) : (
        <>
          <div className="review-metric-grid">
            <Stat label="Active now" value={analytics.totalOpen} tone="" title={OPEN_ESCALATION_DEFINITION} />
            <Stat label="Opened in range" value={analytics.totalOpenedInRange} tone="" />
            <Stat label="Resolved in range" value={analytics.totalResolvedInRange} tone="" />
            <Stat label="Mean resolution (h)" value={hoursOrNoData(analytics.meanResolutionMs)} tone="" />
          </div>
          <h3 className="app-field-label">Trend (opened vs resolved)</h3>
          <SparkBars buckets={analytics.byDay} />
          <h3 className="app-field-label">Reason hotspots</h3>
          {analytics.hotspots.length === 0 ? (
            <p className="app-field-help">No escalations in this range.</p>
          ) : (
            <div className="app-table-surface app-table-surface--scroll">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>Active</th>
                    <th>Resolved</th>
                    <th>Mean resolution (h)</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.hotspots.map((h) => (
                    <tr key={h.reason}>
                      <td>
                        <span className="app-table__muted">{escalationReasonLabel(h.reason)}</span>
                      </td>
                      <td>{h.openCount}</td>
                      <td>{h.resolvedCount}</td>
                      <td>{hoursOrNoData(h.meanResolutionMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
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
 * A REVIEWER'S SPARE CAPACITY, AS A BAND — plain status text (T-071), the
 * number and its band word together.
 */
function capacityTone(score: number): AppTone {
  if (score < 25) return "red";
  if (score < 50) return "amber";
  if (score < 80) return "blue";
  return "green";
}

function CapacityText({ score }: { score: number }) {
  const band = score < 25 ? "low" : score < 50 ? "limited" : score < 80 ? "available" : "high";
  return (
    <AppStatusText tone={capacityTone(score)} data-capacity-band={band}>
      {score} · {band}
    </AppStatusText>
  );
}
