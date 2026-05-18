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

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";

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

export default function GovernanceAnalyticsPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [window, setWindowSel] = useState<AnalyticsWindow>("24h");
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((res: { user?: { currentWorkspaceId?: string | null } }) => {
        if (cancelled) return;
        setTeamId(res?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => setTeamId(null));
    return () => {
      cancelled = true;
    };
  }, []);

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
          setError(err?.message ?? "Unable to load analytics.");
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
    return new Date(data.generatedAtUtc).toLocaleString();
  }, [data]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Governance analytics</h1>
        <p style={mutedStyle}>
          Operational view of the workspace's governance posture. Polled
          every 30 seconds. As of {generatedLabel}.
        </p>
      </header>

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

      <div style={toolbarStyle}>
        <label style={filterLabelStyle}>
          Window
          <select
            style={selectStyle}
            value={window}
            onChange={(e) => setWindowSel(e.target.value as AnalyticsWindow)}
          >
            <option value="1h">Last 1 hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view analytics.</p>
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
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Incident severity (window)</h2>
              <SeverityBars data={data.severityBreakdown.incidents} />
            </section>
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Notification severity (window)</h2>
              <SeverityBars data={data.severityBreakdown.notifications} />
            </section>
          </div>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Lifecycle distribution</h2>
            <BreakdownTable data={data.lifecycleByState} />
          </section>

          <div style={twoColStyle}>
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Destruction queue mix (window)</h2>
              <BreakdownTable data={data.destructionByStatus} />
            </section>
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Immutable storage drift (window)</h2>
              <BreakdownTable data={data.immutableDriftByOutcome} />
            </section>
          </div>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Top retention conflicts</h2>
            {data.topRetentionConflicts.length === 0 ? (
              <p style={mutedStyle}>No same-scope ACTIVE conflicts.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Scope</th>
                    <th style={thStyle}>Qualifier</th>
                    <th style={thStyle}>Case</th>
                    <th style={thStyle}>Active policies</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topRetentionConflicts.map((c, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{c.scope}</td>
                      <td style={tdStyle}>{c.scopeQualifier ?? "—"}</td>
                      <td style={tdStyle}>
                        {c.caseId ? c.caseId.slice(0, 8) + "…" : "—"}
                      </td>
                      <td style={tdStyle}>{c.activeCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Recent reconciliation runs</h2>
            {data.topReconciliationRuns.length === 0 ? (
              <p style={mutedStyle}>No runs in the selected window.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Kind</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Started</th>
                    <th style={thStyle}>Finished</th>
                    <th style={thStyle}>Scanned</th>
                    <th style={thStyle}>Matched</th>
                    <th style={thStyle}>Created</th>
                    <th style={thStyle}>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topReconciliationRuns.map((r) => (
                    <tr key={r.id}>
                      <td style={tdStyle}>{r.kind}</td>
                      <td style={tdStyle}>
                        <span style={runStatusBadge(r.status)}>{r.status}</span>
                      </td>
                      <td style={tdStyle}>
                        {new Date(r.startedAtUtc).toLocaleString()}
                      </td>
                      <td style={tdStyle}>
                        {r.finishedAtUtc
                          ? new Date(r.finishedAtUtc).toLocaleString()
                          : "—"}
                      </td>
                      <td style={tdStyle}>{r.scanned}</td>
                      <td style={tdStyle}>{r.matched}</td>
                      <td style={tdStyle}>{r.created}</td>
                      <td style={tdStyle}>{r.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
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

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  marginBottom: 4,
  letterSpacing: -0.4,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 6,
  letterSpacing: 0.2,
  textTransform: "uppercase",
  color: "#334155",
};
const cardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
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
const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  marginTop: 16,
  marginBottom: 4,
};
const filterLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#475569",
};
const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
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
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#475569",
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
