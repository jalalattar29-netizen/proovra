"use client";

/**
 * Phase 27.5 — Governance analytics dashboard.
 *
 * Compliance-grade analytics surface. Renders the bounded-metric set
 * computed by `/v1/governance/analytics` with severity slicing,
 * window selection, lifecycle distribution, destruction status mix,
 * immutable drift breakdown, top retention-conflict scopes, and a
 * reconciliation-run feed.
 *
 * Tone: operational, enterprise, dense but legible. No animations, no
 * playful copy. Every number on this page has a defined source — see
 * the corresponding service comment in
 * `services/api/src/services/governance-lifecycle/governance-analytics.service.ts`.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";

type AnalyticsWindow = "1h" | "24h" | "7d" | "30d";

type AnalyticsResult = {
  generatedAtUtc: string;
  teamId: string;
  window: AnalyticsWindow;
  windowMs: number;
  metrics: Record<string, number>;
  severityBreakdown: {
    incidents: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number>;
    notifications: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number>;
  };
  lifecycleByState: Record<string, number>;
  destructionByStatus: Record<string, number>;
  immutableDriftByOutcome: Record<string, number>;
  topRetentionConflicts: Array<{
    scope: string;
    scopeQualifier: string | null;
    caseId: string | null;
    activeCount: number;
  }>;
  topReconciliationRuns: Array<{
    id: string;
    kind: string;
    status: string;
    startedAtUtc: string;
    finishedAtUtc: string | null;
    scanned: number;
    matched: number;
    created: number;
    failed: number;
  }>;
};

const METRIC_LABEL: Record<string, string> = {
  destruction_queue_depth: "Destruction queue depth",
  destruction_blocked_count: "Destruction denied (window)",
  destruction_executed_count: "Destruction executed (window)",
  retention_conflicts: "Retention policy conflicts",
  retention_expiration_velocity: "Evidence expiring (window)",
  hold_pressure: "Active legal holds",
  lifecycle_transitions: "Lifecycle transitions (window)",
  lifecycle_blocked_transitions: "Blocked transitions (window)",
  governance_incident_open: "Open governance incidents",
  immutable_drift_count: "Immutable drift checks (window)",
  export_blocks: "Export blocks (window)",
  review_overdue: "Overdue reviews",
};

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function GovernanceAnalyticsPage() {
  return (
    <PageRouteGate routeId="governance.analytics">
      <GovernanceAnalyticsPageInner />
    </PageRouteGate>
  );
}

function GovernanceAnalyticsPageInner() {
  const teamId = useTeamId();
  const [window, setWindowSel] = useState<AnalyticsWindow>("24h");
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const tick = () => {
      apiFetch(
        `/v1/governance/analytics?teamId=${encodeURIComponent(teamId)}&window=${window}`,
        { method: "GET" },
      )
        .then((res: AnalyticsResult) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: { message?: string }) => {
          if (cancelled) return;
          setError(toSafeUserError(err, { message: "Unable to load analytics." }).message);
        });
    };
    tick();
    const handle = globalThis.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(handle);
    };
  }, [teamId, window]);

  const generatedLabel = useMemo(() => {
    if (!data) return "—";
    return formatUserDateTime(data.generatedAtUtc);
  }, [data]);

  type ConflictRow = AnalyticsResult["topRetentionConflicts"][number];
  type RunRow = AnalyticsResult["topReconciliationRuns"][number];

  const conflictColumns: DataTableColumn<ConflictRow>[] = [
    { key: "scope", header: "Scope", render: (c) => c.scope },
    {
      key: "qualifier",
      header: "Qualifier",
      render: (c) => c.scopeQualifier ?? "—",
    },
    {
      key: "case",
      header: "Case",
      render: (c) => (c.caseId ? c.caseId.slice(0, 8) + "…" : "—"),
    },
    {
      key: "active",
      header: "Active policies",
      align: "right",
      render: (c) => c.activeCount,
    },
  ];

  const runColumns: DataTableColumn<RunRow>[] = [
    { key: "kind", header: "Kind", render: (r) => r.kind },
    {
      key: "status",
      header: "Status",
      render: (r) => <span style={runStatusBadge(r.status)}>{r.status}</span>,
    },
    {
      key: "started",
      header: "Started",
      nowrap: true,
      render: (r) => formatUserDateTime(r.startedAtUtc),
    },
    {
      key: "finished",
      header: "Finished",
      nowrap: true,
      render: (r) =>
        r.finishedAtUtc ? formatUserDateTime(r.finishedAtUtc) : "—",
    },
    { key: "scanned", header: "Scanned", align: "right", render: (r) => r.scanned },
    { key: "matched", header: "Matched", align: "right", render: (r) => r.matched },
    { key: "created", header: "Created", align: "right", render: (r) => r.created },
    { key: "failed", header: "Failed", align: "right", render: (r) => r.failed },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance analytics"
          subtitle={`Operational view of the workspace's governance posture. Polled every 30 seconds. As of ${generatedLabel}.`}
          primaryAction={
            <FilterBar>
              <FilterBar.Select
                label="Window"
                showLabel
                value={window}
                onChange={(v) => setWindowSel(v as AnalyticsWindow)}
                options={[
                  { value: "1h", label: "Last 1 hour" },
                  { value: "24h", label: "Last 24 hours" },
                  { value: "7d", label: "Last 7 days" },
                  { value: "30d", label: "Last 30 days" },
                ]}
              />
            </FilterBar>
          }
        />
      }
    >
      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/retention" style={navLinkStyle}>
          Retention policies →
        </Link>
        <Link href="/governance/destruction" style={navLinkStyle}>
          Destruction queue →
        </Link>
        <Link href="/governance/notifications" style={navLinkStyle}>
          Notifications →
        </Link>
      </nav>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to an organization workspace to view its governance analytics."
        />
      ) : !data ? (
        <p style={mutedStyle}>Loading analytics…</p>
      ) : (
        <>
          <section style={gridStyle}>
            {Object.entries(data.metrics).map(([k, v]) => (
              <Tile
                key={k}
                label={METRIC_LABEL[k] ?? k}
                value={v}
                accent={metricAccent(k, v)}
              />
            ))}
          </section>

          <div style={twoColStyle}>
            <PageSection title="Incident severity (window)">
              <Card>
                <SeverityBars data={data.severityBreakdown.incidents} />
              </Card>
            </PageSection>
            <PageSection title="Notification severity (window)">
              <Card>
                <SeverityBars data={data.severityBreakdown.notifications} />
              </Card>
            </PageSection>
          </div>

          <PageSection title="Lifecycle distribution">
            <Card>
              <BreakdownTable data={data.lifecycleByState} />
            </Card>
          </PageSection>

          <div style={twoColStyle}>
            <PageSection title="Destruction queue mix (window)">
              <Card>
                <BreakdownTable data={data.destructionByStatus} />
              </Card>
            </PageSection>
            <PageSection title="Immutable storage drift (window)">
              <Card>
                <BreakdownTable data={data.immutableDriftByOutcome} />
              </Card>
            </PageSection>
          </div>

          <PageSection title="Top retention conflicts">
            <DataTable
              ariaLabel="Top retention conflicts"
              columns={conflictColumns}
              rows={data.topRetentionConflicts}
              getRowId={(_c, i) => String(i)}
              emptyState={
                <EmptyState
                  title="No deletion blockers"
                  purpose="No same-scope ACTIVE conflicts. Overlapping retention policies on the same scope would appear here for resolution."
                />
              }
            />
          </PageSection>

          <PageSection title="Recent reconciliation runs">
            <DataTable
              ariaLabel="Recent reconciliation runs"
              columns={runColumns}
              rows={data.topReconciliationRuns}
              getRowId={(r) => r.id}
              emptyState={
                <EmptyState
                  title="No reconciliation runs"
                  purpose="No runs in the selected window. Governance reconciliation runs and their outcomes will appear here."
                />
              }
            />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

function metricAccent(key: string, value: number): "neutral" | "warn" | "danger" {
  if (value === 0) return "neutral";
  if (
    key === "destruction_queue_depth" ||
    key === "hold_pressure" ||
    key === "retention_conflicts" ||
    key === "governance_incident_open" ||
    key === "review_overdue"
  ) {
    return value > 0 ? "warn" : "neutral";
  }
  if (
    key === "destruction_blocked_count" ||
    key === "immutable_drift_count" ||
    key === "export_blocks" ||
    key === "lifecycle_blocked_transitions"
  ) {
    return value > 0 ? "danger" : "neutral";
  }
  return "neutral";
}

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "neutral" | "warn" | "danger";
}) {
  return (
    <div style={tileStyle(accent)}>
      <div style={tileLabelStyle}>{label}</div>
      <div style={tileValueStyle}>{value.toLocaleString()}</div>
    </div>
  );
}

function SeverityBars({
  data,
}: {
  data: Record<"INFO" | "WARNING" | "HIGH" | "CRITICAL", number>;
}) {
  const max = Math.max(1, ...Object.values(data));
  const order: Array<"CRITICAL" | "HIGH" | "WARNING" | "INFO"> = [
    "CRITICAL",
    "HIGH",
    "WARNING",
    "INFO",
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {order.map((sev) => (
        <div key={sev} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", width: 80 }}>
            {sev}
          </span>
          <div
            style={{
              flex: 1,
              background: "#f1f5f9",
              height: 8,
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                background: severityColor(sev),
                height: "100%",
                width: `${(data[sev] / max) * 100}%`,
              }}
            />
          </div>
          <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", width: 40, textAlign: "right" }}>
            {data[sev]}
          </span>
        </div>
      ))}
    </div>
  );
}

function severityColor(s: string): string {
  switch (s) {
    case "CRITICAL":
      return "#991b1b";
    case "HIGH":
      return "#9a3412";
    case "WARNING":
      return "#92400e";
    case "INFO":
    default:
      return "#1e40af";
  }
}

function BreakdownTable({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <p style={mutedStyle}>No data in window.</p>;
  }
  return (
    <table style={tableStyle}>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td style={tdStyle}>{k}</td>
            <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {v.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 12,
  marginBottom: 8,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  marginTop: 16,
};
const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
  marginTop: 16,
};
function tileStyle(accent: "neutral" | "warn" | "danger"): React.CSSProperties {
  const palette = {
    neutral: { border: "#e2e8f0", bg: "#fff", color: "#0f172a" },
    warn: { border: "#fcd34d", bg: "#fffbeb", color: "#92400e" },
    danger: { border: "#fca5a5", bg: "#fef2f2", color: "#991b1b" },
  }[accent];
  return {
    padding: 14,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
    color: palette.color,
    borderRadius: 10,
  };
}
const tileLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.7,
};
const tileValueStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  marginTop: 4,
  fontVariantNumeric: "tabular-nums",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  marginTop: 8,
};
const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};

function runStatusBadge(status: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    SUCCEEDED: ["#ecfdf5", "#bbf7d0", "#166534"],
    PARTIAL: ["#fffbeb", "#fcd34d", "#92400e"],
    FAILED: ["#fef2f2", "#fca5a5", "#991b1b"],
    RUNNING: ["#eff6ff", "#bfdbfe", "#1e40af"],
  };
  const [bg, border, color] = palette[status] ?? [
    "#f1f5f9",
    "#cbd5e1",
    "#475569",
  ];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}
