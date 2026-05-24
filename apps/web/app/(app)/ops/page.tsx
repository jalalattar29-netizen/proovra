"use client";

/**
 * Phase 21 — Operations Center.
 *
 * Workspace-internal operator console for:
 *   - system health (database, observability, alerts, providers)
 *   - active + recent operational incidents
 *   - metrics snapshot (counters + gauges)
 *
 * Wording is operational only. We say "issue", "failure", "anomaly",
 * "incident", "outage". We never say "breach", "compromise",
 * "verdict", "forensic conclusion".
 */

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useTeamWorkspaceGate } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { HubQuickActionsBar } from "../../../components/hubs/HubQuickActionsBar";

// Phase 32.6.4 — bounded per-panel state machine. Replaces the
// previous `null | data` pattern where a single 503 from any of the
// three endpoints (health / incidents / metrics) blanked the entire
// page via Promise.all rejection.
type PanelState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; requestId?: string };

const PANEL_LOADING = { status: "loading" } as const;

function panelErrorMessageFor(
  surface: "health" | "incidents" | "metrics",
  err: unknown,
): { message: string; requestId?: string } {
  const e = err as { statusCode?: number; code?: string; requestId?: string };
  if (e?.statusCode === 401) {
    return { message: "Sign-in required.", requestId: e.requestId };
  }
  if (e?.statusCode === 403) {
    return { message: "Permission required.", requestId: e.requestId };
  }
  if (e?.statusCode === 503) {
    return {
      message:
        surface === "health"
          ? "System health is temporarily unavailable. Retry shortly."
          : surface === "incidents"
            ? "Incidents are temporarily unavailable. Retry shortly."
            : "Metrics are temporarily unavailable. Retry shortly.",
      requestId: e.requestId,
    };
  }
  return {
    message:
      surface === "health"
        ? "Unable to load system health."
        : surface === "incidents"
          ? "Unable to load incidents."
          : "Unable to load metrics.",
    requestId: e?.requestId,
  };
}

type IncidentSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
type IncidentStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "SUPPRESSED";

type Incident = {
  id: string;
  category: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  safeSummary: string;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  requestId: string | null;
  traceId: string | null;
  relatedEvidenceId: string | null;
  relatedJobId: string | null;
  relatedProvider: string | null;
  runbookSlug: string | null;
};

type Health = {
  ok: boolean;
  database: string;
  observability: { enabled: boolean; provider: string; ready: boolean };
  alerts: { provider: string; ready: boolean };
  incidents: {
    openTotal: number;
    openHigh: number;
    openCritical: number;
  };
  violations: Array<{ envName: string; reason: string }>;
  snapshot: {
    isProduction: boolean;
    database: { configured: boolean };
    communications: { configured: boolean };
    identitySecurity: { configured: boolean };
    notifications: { configured: boolean };
    ai: { configured: boolean };
    integrations: { configured: boolean };
  };
};

type MetricsSnapshot = {
  uptimeSeconds: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
};

const SEVERITIES: IncidentSeverity[] = ["INFO", "WARNING", "HIGH", "CRITICAL"];
const STATUSES: IncidentStatus[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "SUPPRESSED",
];

// Phase 38.8 — wrap in canonical PageRouteGate. The inner component
// retains its existing workspace + capability behavior; the gate
// short-circuits denied states with the canonical structured panel.
// R6 — Operations Center hub bar above the existing Phase 21
// operations content. The bar is the canonical hub HEADER; the
// rich existing operations content stays below unchanged.
export default function OpsPage() {
  return (
    <PageRouteGate routeId="platform.ops_center">
      <div data-hub-page data-hub-page-id="operations">
        <HubQuickActionsBar hubId="operations" />
        <OpsPageInner />
      </div>
    </PageRouteGate>
  );
}

function OpsPageInner() {
  // Phase 32.8 Foundation cleanup — read team-scoped workspace from
  // the canonical platform context. No /v1/users/me, no /v1/teams.
  const workspace = useTeamWorkspaceGate();
  const teamId =
    workspace.status === "ready" ? workspace.workspaceId : null;

  // Phase 32.6.4 — per-panel independent state. A 503 from any one
  // of (health / incidents / metrics) MUST NOT blank the other two
  // panels.
  const [healthPanel, setHealthPanel] =
    useState<PanelState<Health>>(PANEL_LOADING);
  const [incidentsPanel, setIncidentsPanel] =
    useState<PanelState<Incident[]>>(PANEL_LOADING);
  const [metricsPanel, setMetricsPanel] =
    useState<PanelState<MetricsSnapshot>>(PANEL_LOADING);

  const [status, setStatus] = useState<IncidentStatus | "">("OPEN");
  const [severity, setSeverity] = useState<IncidentSeverity | "">("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;

    const qs = `?teamId=${encodeURIComponent(teamId)}`;
    const incidentsQs = `${qs}${status ? `&status=${status}` : ""}${severity ? `&severity=${severity}` : ""}`;

    setHealthPanel(PANEL_LOADING);
    setIncidentsPanel(PANEL_LOADING);
    setMetricsPanel(PANEL_LOADING);

    Promise.allSettled([
      apiFetch(`/v1/ops/health${qs}`, { method: "GET" }),
      apiFetch(`/v1/ops/incidents${incidentsQs}`, { method: "GET" }),
      apiFetch(`/v1/ops/metrics${qs}`, { method: "GET" }),
    ]).then(([healthR, incidentsR, metricsR]) => {
      if (cancelled) return;

      if (healthR.status === "fulfilled") {
        setHealthPanel({
          status: "ready",
          data: healthR.value as Health,
        });
      } else {
        setHealthPanel({
          status: "error",
          ...panelErrorMessageFor("health", healthR.reason),
        });
      }

      if (incidentsR.status === "fulfilled") {
        const value = incidentsR.value as { incidents: Incident[] };
        setIncidentsPanel({
          status: "ready",
          data: value.incidents ?? [],
        });
      } else {
        setIncidentsPanel({
          status: "error",
          ...panelErrorMessageFor("incidents", incidentsR.reason),
        });
      }

      if (metricsR.status === "fulfilled") {
        const value = metricsR.value as { metrics: MetricsSnapshot };
        setMetricsPanel({ status: "ready", data: value.metrics });
      } else {
        setMetricsPanel({
          status: "error",
          ...panelErrorMessageFor("metrics", metricsR.reason),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [teamId, status, severity]);

  // Bounded helpers — JSX reads from these instead of hand-rolling
  // every `panel.status === "ready" ? … : …` ternary.
  const health = healthPanel.status === "ready" ? healthPanel.data : null;
  const incidents =
    incidentsPanel.status === "ready" ? incidentsPanel.data : null;
  const metrics =
    metricsPanel.status === "ready" ? metricsPanel.data : null;

  async function transitionIncident(
    id: string,
    action: "ack" | "resolve" | "suppress",
  ) {
    if (!teamId) return;
    let resolutionNote: string | undefined;
    if (action === "resolve") {
      const note = window.prompt("Resolution note (operator-visible, optional)");
      resolutionNote = note?.trim() ?? undefined;
    }
    setBusy(true);
    try {
      await apiFetch(`/v1/ops/incidents/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, ...(resolutionNote ? { resolutionNote } : {}) }),
      });
      // refresh
      const qs = `?teamId=${encodeURIComponent(teamId)}`;
      const fresh: { incidents: Incident[] } = await apiFetch(
        `/v1/ops/incidents${qs}${status ? `&status=${status}` : ""}${severity ? `&severity=${severity}` : ""}`,
        { method: "GET" },
      );
      setIncidentsPanel({ status: "ready", data: fresh.incidents ?? [] });
    } catch (err) {
      alert((err as { message?: string })?.message ?? "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const headlineCounters = useMemo(() => {
    if (!metrics) return null;
    const c = metrics.counters;
    return {
      jobsFailed: c["jobs_failed_total"] ?? 0,
      webhooksInvalid:
        (c["webhook_invalid_signature_total"] ?? 0) +
        (c["webhook_invalid_signature"] ?? 0),
      commsFailed: c["communication_message_failed"] ?? 0,
      stepUpDenied: c["step_up_denied"] ?? 0,
      requests5xx: c["request_5xx"] ?? 0,
      alertsSent: c["alert_sent"] ?? 0,
    };
  }, [metrics]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Operations Center</h1>
        <p style={mutedStyle}>
          Workspace-internal operations view: system health, active and
          recent operational incidents, and the in-process metrics
          snapshot. Wording is operational only — incidents describe
          system behaviour, never legal or forensic conclusions.
        </p>
      </header>

      {workspace.status === "loading" ? (
        <p style={mutedStyle}>Loading workspace…</p>
      ) : workspace.status === "error" ? (
        <div style={errorBoxStyle}>{workspace.message}</div>
      ) : !teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use ops center.</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>System health</h2>
            {healthPanel.status === "loading" ? (
              <p style={mutedStyle}>Loading…</p>
            ) : healthPanel.status === "error" ? (
              <div style={errorBoxStyle}>
                {healthPanel.message}
                {healthPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {healthPanel.requestId}
                  </div>
                ) : null}
              </div>
            ) : !health ? null : (
              <>
                <div style={healthGridStyle}>
                  <Stat label="Database" value={health.database} />
                  <Stat
                    label="Observability"
                    value={
                      health.observability.ready
                        ? health.observability.provider
                        : "noop"
                    }
                  />
                  <Stat
                    label="Alerts"
                    value={health.alerts.ready ? health.alerts.provider : "noop"}
                  />
                  <Stat
                    label="Open incidents"
                    value={String(health.incidents.openTotal)}
                  />
                  <Stat
                    label="HIGH open"
                    value={String(health.incidents.openHigh)}
                  />
                  <Stat
                    label="CRITICAL open"
                    value={String(health.incidents.openCritical)}
                  />
                  <Stat
                    label="Communications"
                    value={
                      health.snapshot.communications.configured ? "ready" : "—"
                    }
                  />
                  <Stat
                    label="Identity sec"
                    value={
                      health.snapshot.identitySecurity.configured ? "ready" : "—"
                    }
                  />
                </div>
                {health.violations.length > 0 ? (
                  <div style={warnBoxStyle}>
                    {health.violations.length} configuration issue
                    {health.violations.length === 1 ? "" : "s"} reported:{" "}
                    {health.violations.map((v) => v.envName).join(", ")}
                  </div>
                ) : null}
              </>
            )}
          </section>

          {metricsPanel.status === "error" ? (
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Headline counters</h2>
              <div style={errorBoxStyle}>
                {metricsPanel.message}
                {metricsPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {metricsPanel.requestId}
                  </div>
                ) : null}
              </div>
            </section>
          ) : headlineCounters ? (
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Headline counters</h2>
              <div style={healthGridStyle}>
                <Stat label="Jobs failed" value={String(headlineCounters.jobsFailed)} />
                <Stat
                  label="Invalid webhook sigs"
                  value={String(headlineCounters.webhooksInvalid)}
                />
                <Stat
                  label="Comms failed"
                  value={String(headlineCounters.commsFailed)}
                />
                <Stat
                  label="Step-up denied"
                  value={String(headlineCounters.stepUpDenied)}
                />
                <Stat label="5xx" value={String(headlineCounters.requests5xx)} />
                <Stat label="Alerts sent" value={String(headlineCounters.alertsSent)} />
              </div>
              {metrics ? (
                <p style={mutedStyle}>
                  Process uptime: {Math.floor(metrics.uptimeSeconds / 60)} min ·{" "}
                  {Object.keys(metrics.counters).length} counters ·{" "}
                  {Object.keys(metrics.gauges).length} gauges
                </p>
              ) : null}
            </section>
          ) : null}

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Operational incidents</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as IncidentStatus | "")}
                  style={selectStyle}
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  value={severity}
                  onChange={(e) =>
                    setSeverity(e.target.value as IncidentSeverity | "")
                  }
                  style={selectStyle}
                >
                  <option value="">All severities</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {incidentsPanel.status === "loading" ? (
              <p style={mutedStyle}>Loading…</p>
            ) : incidentsPanel.status === "error" ? (
              <div style={errorBoxStyle}>
                {incidentsPanel.message}
                {incidentsPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {incidentsPanel.requestId}
                  </div>
                ) : null}
              </div>
            ) : !incidents || incidents.length === 0 ? (
              <p style={mutedStyle}>No incidents match the filters.</p>
            ) : (
              <ul style={listStyle}>
                {incidents.map((i) => (
                  <li key={i.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {i.title}{" "}
                        <span style={chipStyle}>{i.category}</span>{" "}
                        <span style={chipStyle}>×{i.occurrenceCount}</span>
                      </div>
                      <div style={mutedStyle}>{i.safeSummary}</div>
                      <div style={mutedStyle}>
                        first {new Date(i.firstSeenAtUtc).toLocaleString()} ·{" "}
                        last {new Date(i.lastSeenAtUtc).toLocaleString()}
                        {i.runbookSlug ? ` · runbook: ${i.runbookSlug}` : ""}
                        {i.requestId ? ` · req ${i.requestId.slice(0, 8)}…` : ""}
                      </div>
                    </div>
                    <span style={severityBadgeStyle(i.severity)}>{i.severity}</span>
                    <span style={statusBadgeStyle(i.status)}>{i.status}</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {i.status === "OPEN" ? (
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          disabled={busy}
                          onClick={() => void transitionIncident(i.id, "ack")}
                        >
                          Ack
                        </button>
                      ) : null}
                      {i.status === "OPEN" || i.status === "ACKNOWLEDGED" ? (
                        <>
                          <button
                            type="button"
                            style={primaryButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              void transitionIncident(i.id, "resolve")
                            }
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              void transitionIncident(i.id, "suppress")
                            }
                          >
                            Suppress
                          </button>
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const healthGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
  marginBottom: 12,
};
const statStyle: React.CSSProperties = {
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
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
const warnBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 12,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 13,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

function severityBadgeStyle(severity: IncidentSeverity): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (severity === "CRITICAL")
    return { ...base, background: "#fef2f2", borderColor: "#fca5a5", color: "#7f1d1d" };
  if (severity === "HIGH")
    return { ...base, background: "#fff7ed", borderColor: "#fdba74", color: "#9a3412" };
  if (severity === "WARNING")
    return { ...base, background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" };
  return { ...base, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e40af" };
}

function statusBadgeStyle(status: IncidentStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "RESOLVED")
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  if (status === "ACKNOWLEDGED")
    return { ...base, background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" };
  if (status === "SUPPRESSED")
    return { ...base, background: "#f1f5f9", borderColor: "#cbd5e1", color: "#475569" };
  return { ...base, background: "#fef2f2", borderColor: "#fca5a5", color: "#7f1d1d" };
}
