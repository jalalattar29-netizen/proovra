"use client";

/**
 * Phase 25 — SLA Operations Dashboard.
 *
 * Workspace-level SLA telemetry: backlog totals, breached counts,
 * reviewer workload snapshot, top reviewers by load, escalation
 * pressure. Operator-readable only — no per-reviewer private text.
 */

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
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";

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
    slaComplianceRate: number;
    capacityScore: number;
  }>;
};

type DashboardResponse = {
  counts: {
    byStage: Record<string, number>;
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
// organization-only; the gate renders the structured recovery panel.
export default function SlaDashboardPage() {
  return (
    <PageRouteGate routeId="review.sla">
      <SlaDashboardPageInner />
    </PageRouteGate>
  );
}

function SlaDashboardPageInner() {
  // PageRouteGate guarantees an active ORGANIZATION space here.
  const teamId = useActiveSpaceId();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<EscalationAnalytics | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerPerformance | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(14);

  const load = useCallback(() => {
    if (!teamId) return;
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
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

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
      })
      .catch(() => {
        if (cancelled) return;
        setAnalytics(null);
        setReviewers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, rangeDays]);

  // PageRouteGate already guaranteed ALLOWED. If the canonical
  // envelope is still hydrating we render the bounded loading shell.
  if (!teamId) {
    return (
      <PageShell
        width="full"
        data-sla-loading
        header={
          <PageHeader
            eyebrow="Reviewer operations"
            title="SLA Operations Dashboard"
            subtitle="Loading organization workspace…"
          />
        }
      />
    );
  }
  if (!data) {
    return (
      <PageShell
        width="full"
        header={
          <PageHeader
            eyebrow="Reviewer operations"
            title="SLA Operations"
          />
        }
      >
        {error ? (
          <Card variant="status" tone="risk">
            {error}
          </Card>
        ) : null}
        <EmptyState variant="inline" title="Loading SLA dashboard…" />
      </PageShell>
    );
  }

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Reviewer operations"
          title="SLA Operations"
          subtitle={
            <span data-sla-dashboard-intro>
              Read-only operations dashboard reflecting current SLA pressure
              across the workspace — backlog, breached counts, reviewer
              workload, and escalation hotspots. SLA policy is administered at
              /governance/policy; this surface never mutates it.
              Operator-readable only — no private review notes.
            </span>
          }
        />
      }
    >
      {teamId ? (
        <RuntimeStatusBanner teamId={teamId} forDomains={["reviewer_ops"]} />
      ) : null}

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">Freshness and runtime</h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
          }}
        >
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
          <Stat label="Worker health" value="See runtime banner above" tone="" />
        </div>
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--silver-ink)" }}>
          Workload and assignment suggestions depend on reconcile snapshots.
          Escalation analytics refresh separately from the queue snapshot. When
          the runtime banner is degraded and the latest workload snapshot is
          missing, operators should treat workload sections as stale rather than
          assuming a true zero.
        </p>
        </Card>
      </PageSection>

      {error ? (
        <Card variant="status" tone="risk">
          {error}
        </Card>
      ) : null}

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">Workspace pressure</h3>
        <div style={statGridStyle}>
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
          <Stat
            label="Open escalations"
            value={data.openEscalations}
            tone={data.openEscalations > 0 ? "warn" : ""}
          />
          <Stat
            label="Critical escalations"
            value={data.criticalEscalationsOpen}
            tone={data.criticalEscalationsOpen > 0 ? "alert" : ""}
          />
        </div>
        </Card>
      </PageSection>

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">By stage</h3>
        <table className="app-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.counts.byStage).map(([stage, count]) => (
              <tr key={stage}>
                <td>
                  {stage.toLowerCase().replace(/_/g, " ")}
                </td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </Card>
      </PageSection>

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">Reviewer workload (latest snapshots)</h3>
        {data.workloadTop.length === 0 ? (
          <p className="app-field-help">
            No workload snapshots yet — run the reconcile job to populate.
          </p>
        ) : (
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
                    <span style={monoStyle}>
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
        )}
        </Card>
      </PageSection>

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">Assignment suggestions</h3>
        {data.suggestions.length === 0 ? (
          <p className="app-field-help">
            No suggestions available. Run reconcile to compute workload first.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.suggestions.map((s) => (
              <li key={s.reviewerUserId} style={suggestionRowStyle}>
                <span style={monoStyle}>
                  {s.reviewerUserId.slice(0, 12)}…
                </span>
                <Badge tone={capacityTone(s.capacityScore)} subtle>
                  {s.capacityScore}
                </Badge>
                <span style={{ flex: 1, fontSize: 12, color: "var(--silver-ink)" }}>{s.rationale}</span>
              </li>
            ))}
          </ul>
        )}
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--silver-ink)" }}>
          Suggestions are advisory. The reviewer-ops engine never
          auto-assigns; operators decide.
        </p>
        </Card>
      </PageSection>

      <PageSection>
        <Card padding="comfortable">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h3 className="app-panel__title">Escalation analytics</h3>
          <select
            value={rangeDays}
            onChange={(e) => setRangeDays(Number(e.target.value))}
            style={{
              padding: "4px 8px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <option value={7}>Last 7d</option>
            <option value={14}>Last 14d</option>
            <option value={30}>Last 30d</option>
            <option value={60}>Last 60d</option>
            <option value={90}>Last 90d</option>
          </select>
        </div>
        {!analytics ? (
          <p className="app-field-help">Loading analytics…</p>
        ) : (
          <>
            <div style={statGridStyle}>
              <Stat label="Open now" value={analytics.totalOpen} tone="" />
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
                value={
                  analytics.meanResolutionMs
                    ? Math.round(analytics.meanResolutionMs / 3_600_000)
                    : 0
                }
                tone=""
              />
            </div>

            <h4 style={{ marginTop: 16 }}>
              Trend (opened vs resolved)
            </h4>
            <SparkBars buckets={analytics.byDay} />

            <h4 style={{ marginTop: 16 }}>
              Reason hotspots
            </h4>
            {analytics.hotspots.length === 0 ? (
              <p className="app-field-help">No escalations in this range.</p>
            ) : (
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
                        <span style={{ fontSize: 12, color: "var(--silver-ink)" }}>
                          {h.reason}
                        </span>
                      </td>
                      <td>{h.openCount}</td>
                      <td>{h.resolvedCount}</td>
                      <td>
                        {h.meanResolutionMs
                          ? Math.round(h.meanResolutionMs / 3_600_000)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        </Card>
      </PageSection>

      <PageSection>
        <Card padding="comfortable">
        <h3 className="app-panel__title">Reviewer performance</h3>
        {!reviewers ? (
          <p className="app-field-help">Loading…</p>
        ) : reviewers.rows.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <NoWorkloadSnapshotsEmptyState />
          </div>
        ) : (
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
                    <span style={monoStyle}>
                      {r.reviewerUserId.slice(0, 12)}…
                    </span>
                  </td>
                  <td>{r.active}</td>
                  <td>{r.completedInRange}</td>
                  <td>{r.approvedInRange}</td>
                  <td>{r.rejectedInRange}</td>
                  <td>{r.overdue}</td>
                  <td>{r.escalated}</td>
                  <td>
                    {Math.round(r.slaComplianceRate * 100)}%
                  </td>
                  <td>
                    {r.meanResolutionMs
                      ? Math.round(r.meanResolutionMs / 3_600_000)
                      : "—"}
                  </td>
                  <td>
                    <Badge tone={capacityTone(r.capacityScore)} subtle>
                      {r.capacityScore}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </Card>
      </PageSection>
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
              background: "#fca5a5",
              minHeight: b.opened > 0 ? 2 : 0,
            }}
          />
          <div
            style={{
              height: `${(b.resolved / max) * 50}%`,
              background: "#86efac",
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
}: {
  label: string;
  value: number | string;
  tone: "" | "warn" | "alert";
}) {
  const palette = {
    "": {
      bg: "var(--surface-muted)",
      fg: "var(--ink-primary)",
      border: "var(--border-standard)",
    },
    warn: {
      bg: "var(--warning-subtle-bg)",
      fg: "var(--warning-strong)",
      border: "var(--warning-border)",
    },
    alert: {
      bg: "var(--danger-subtle-bg)",
      fg: "var(--danger-strong)",
      border: "var(--danger-border)",
    },
  } as const;
  const p = palette[tone] ?? palette[""];
  return (
    <div
      style={{
        padding: 12,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        borderRadius: "var(--radius-md)",
      }}
      data-sla-stat-tone={tone === "" ? "neutral" : tone}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
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

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
};

const suggestionRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  padding: "6px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
};

