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
import {
  cardStyle,
  emptyStateStyle,
  errorBoxStyle,
  formatDateTime,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

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
      <main style={pageStyle} data-sla-loading>
        <header style={headerRowStyle}>
          <div>
            <h1 style={titleStyle}>SLA Operations Dashboard</h1>
            <p style={subtitleStyle}>Loading organization workspace…</p>
          </div>
        </header>
      </main>
    );
  }
  if (!data) {
    return (
      <main style={pageStyle}>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}
        <div style={emptyStateStyle}>Loading SLA dashboard…</div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      {teamId ? (
        <RuntimeStatusBanner teamId={teamId} forDomains={["reviewer_ops"]} />
      ) : null}
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>SLA Operations</h1>
          <p style={subtitleStyle} data-sla-dashboard-intro>
            Read-only operations dashboard reflecting current SLA
            pressure across the workspace — backlog, breached counts,
            reviewer workload, and escalation hotspots. SLA policy is
            administered at /governance/policy; this surface never
            mutates it. Operator-readable only — no private review
            notes.
          </p>
        </div>
      </header>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Freshness and runtime</h3>
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
                ? formatDateTime(data.workloadTop[0].computedAtUtc)
                : "Not yet available"
            }
            tone=""
          />
          <Stat
            label="Analytics range end"
            value={
              analytics?.range.endUtc
                ? formatDateTime(analytics.range.endUtc)
                : "Not yet loaded"
            }
            tone=""
          />
          <Stat label="Worker health" value="See runtime banner above" tone="" />
        </div>
        <p style={{ ...mutedStyle, marginTop: 10 }}>
          Workload and assignment suggestions depend on reconcile snapshots.
          Escalation analytics refresh separately from the queue snapshot. When
          the runtime banner is degraded and the latest workload snapshot is
          missing, operators should treat workload sections as stale rather than
          assuming a true zero.
        </p>
      </section>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Workspace pressure</h3>
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
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>By stage</h3>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Stage</th>
              <th style={thStyle}>Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.counts.byStage).map(([stage, count]) => (
              <tr key={stage}>
                <td style={tdStyle}>
                  {stage.toLowerCase().replace(/_/g, " ")}
                </td>
                <td style={tdStyle}>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Reviewer workload (latest snapshots)</h3>
        {data.workloadTop.length === 0 ? (
          <p style={mutedStyle}>
            No workload snapshots yet — run the reconcile job to populate.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Reviewer</th>
                <th style={thStyle}>Active</th>
                <th style={thStyle}>Due soon</th>
                <th style={thStyle}>Overdue</th>
                <th style={thStyle}>Escalated</th>
                <th style={thStyle}>Capacity</th>
                <th style={thStyle}>Computed</th>
              </tr>
            </thead>
            <tbody>
              {data.workloadTop.map((w) => (
                <tr key={w.reviewerUserId}>
                  <td style={tdStyle}>
                    <span style={monoStyle}>
                      {w.reviewerUserId.slice(0, 12)}…
                    </span>
                  </td>
                  <td style={tdStyle}>{w.activeReviewCount}</td>
                  <td style={tdStyle}>{w.dueSoonReviewCount}</td>
                  <td style={tdStyle}>{w.overdueReviewCount}</td>
                  <td style={tdStyle}>{w.escalatedReviewCount}</td>
                  <td style={tdStyle}>
                    <span style={capacityChipStyle(w.capacityScore)}>
                      {w.capacityScore}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(w.computedAtUtc)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Assignment suggestions</h3>
        {data.suggestions.length === 0 ? (
          <p style={mutedStyle}>
            No suggestions available. Run reconcile to compute workload first.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.suggestions.map((s) => (
              <li key={s.reviewerUserId} style={suggestionRowStyle}>
                <span style={monoStyle}>
                  {s.reviewerUserId.slice(0, 12)}…
                </span>
                <span style={capacityChipStyle(s.capacityScore)}>
                  {s.capacityScore}
                </span>
                <span style={{ flex: 1, ...mutedStyle }}>{s.rationale}</span>
              </li>
            ))}
          </ul>
        )}
        <p style={{ ...mutedStyle, marginTop: 8 }}>
          Suggestions are advisory. The reviewer-ops engine never
          auto-assigns; operators decide.
        </p>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h3 style={sectionTitleStyle}>Escalation analytics</h3>
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
          <p style={mutedStyle}>Loading analytics…</p>
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

            <h4 style={{ ...sectionTitleStyle, marginTop: 16 }}>
              Trend (opened vs resolved)
            </h4>
            <SparkBars buckets={analytics.byDay} />

            <h4 style={{ ...sectionTitleStyle, marginTop: 16 }}>
              Reason hotspots
            </h4>
            {analytics.hotspots.length === 0 ? (
              <p style={mutedStyle}>No escalations in this range.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Reason</th>
                    <th style={thStyle}>Open</th>
                    <th style={thStyle}>Resolved</th>
                    <th style={thStyle}>Mean resolution (h)</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.hotspots.map((h) => (
                    <tr key={h.reason}>
                      <td style={tdStyle}>
                        <span style={{ ...mutedStyle, fontSize: 12 }}>
                          {h.reason}
                        </span>
                      </td>
                      <td style={tdStyle}>{h.openCount}</td>
                      <td style={tdStyle}>{h.resolvedCount}</td>
                      <td style={tdStyle}>
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
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Reviewer performance</h3>
        {!reviewers ? (
          <p style={mutedStyle}>Loading…</p>
        ) : reviewers.rows.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <NoWorkloadSnapshotsEmptyState />
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Reviewer</th>
                <th style={thStyle}>Active</th>
                <th style={thStyle}>Completed</th>
                <th style={thStyle}>Approved</th>
                <th style={thStyle}>Rejected</th>
                <th style={thStyle}>Overdue</th>
                <th style={thStyle}>Escalated</th>
                <th style={thStyle}>SLA</th>
                <th style={thStyle}>Mean (h)</th>
                <th style={thStyle}>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {reviewers.rows.map((r) => (
                <tr key={r.reviewerUserId}>
                  <td style={tdStyle}>
                    <span style={monoStyle}>
                      {r.reviewerUserId.slice(0, 12)}…
                    </span>
                  </td>
                  <td style={tdStyle}>{r.active}</td>
                  <td style={tdStyle}>{r.completedInRange}</td>
                  <td style={tdStyle}>{r.approvedInRange}</td>
                  <td style={tdStyle}>{r.rejectedInRange}</td>
                  <td style={tdStyle}>{r.overdue}</td>
                  <td style={tdStyle}>{r.escalated}</td>
                  <td style={tdStyle}>
                    {Math.round(r.slaComplianceRate * 100)}%
                  </td>
                  <td style={tdStyle}>
                    {r.meanResolutionMs
                      ? Math.round(r.meanResolutionMs / 3_600_000)
                      : "—"}
                  </td>
                  <td style={tdStyle}>
                    <span style={capacityChipStyle(r.capacityScore)}>
                      {r.capacityScore}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: string;
}) {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    "": { bg: TOKENS.surfaceMuted, fg: TOKENS.ink, border: TOKENS.border },
    warn: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    alert: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  };
  const p = palette[tone] ?? palette[""];
  return (
    <div
      style={{
        padding: 12,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {label}
      </div>
    </div>
  );
}

function capacityChipStyle(score: number): React.CSSProperties {
  let bg = "#ecfdf5";
  let fg = "#065f46";
  let border = "#a7f3d0";
  if (score < 25) {
    bg = "#fef2f2";
    fg = "#7f1d1d";
    border = "#fecaca";
  } else if (score < 50) {
    bg = "#fef3c7";
    fg = "#78350f";
    border = "#fde68a";
  } else if (score < 80) {
    bg = "#eff6ff";
    fg = "#1e40af";
    border = "#bfdbfe";
  }
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 4,
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    minWidth: 32,
    textAlign: "center",
    display: "inline-block",
  };
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
  borderBottom: `1px solid ${TOKENS.divider}`,
};

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
};

// Re-use the severity-badge import to keep TS happy about it being unused.
void severityBadgeStyle;
