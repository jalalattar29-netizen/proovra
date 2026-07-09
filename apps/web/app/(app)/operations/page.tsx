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
 *
 * Phase 7C — premium ops-console visual pass. Migrated to the shared
 * design system (PageShell / PageHeader / PageSection + Card / Badge /
 * Button / FilterBar / DataTable / EmptyState). NO change to data
 * fetching, gating, honest states, or the bounded per-panel state
 * machine — a single 503 still isolates to its own panel.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useTeamWorkspaceGate } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { HubQuickActionsBar } from "../../../components/hubs/HubQuickActionsBar";
import { formatUserDateTime } from "../../../lib/date";
import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  FilterBar,
  type DataTableColumn,
} from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

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
  const [lastCheckedAtUtc, setLastCheckedAtUtc] = useState<string | null>(null);

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

      setLastCheckedAtUtc(new Date().toISOString());
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
      alert(toSafeUserError(err, { message: "Action failed." }).message);
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

  const incidentColumns: DataTableColumn<Incident>[] = [
    {
      key: "incident",
      header: "Incident",
      render: (i) => (
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              fontWeight: 650,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            <span>{i.title}</span>
            <Badge tone="info" subtle>
              {i.category}
            </Badge>
            <Badge tone="neutral" subtle>
              ×{i.occurrenceCount}
            </Badge>
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--ink-secondary, #475569)",
              marginTop: 3,
            }}
          >
            {i.safeSummary}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-muted, #94a3b8)",
              marginTop: 3,
            }}
          >
            first {formatUserDateTime(i.firstSeenAtUtc)} · last{" "}
            {formatUserDateTime(i.lastSeenAtUtc)}
            {i.runbookSlug ? ` · runbook: ${i.runbookSlug}` : ""}
            {i.requestId ? ` · req ${i.requestId.slice(0, 8)}…` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      nowrap: true,
      render: (i) => (
        <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      nowrap: true,
      render: (i) => (
        <Badge tone={incidentStatusTone(i.status)}>{i.status}</Badge>
      ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Operations"
          title="Operations Center"
          subtitle="Workspace-internal operations view: system health, active and recent operational incidents, and the in-process metrics snapshot. Wording is operational only — incidents describe system behaviour, never legal or forensic conclusions."
          contextStrip={
            lastCheckedAtUtc ? (
              <Badge tone="neutral" subtle>
                Last checked {formatUserDateTime(lastCheckedAtUtc)}
              </Badge>
            ) : null
          }
        />
      }
    >
      {workspace.status === "loading" ? (
        <p style={mutedStyle}>Loading workspace…</p>
      ) : workspace.status === "error" ? (
        <Card variant="status" tone="risk">
          <div style={{ color: "var(--status-risk-fg, #991b1b)" }}>
            {workspace.message}
          </div>
        </Card>
      ) : !teamId ? (
        <Card>
          <EmptyState
            compact
            title="No workspace selected"
            purpose="Switch to a workspace to use the operations center."
          />
        </Card>
      ) : (
        <>
          <PageSection
            title="System health"
            description="Live posture for the platform runtime, providers, and open incident load."
          >
            {healthPanel.status === "loading" ? (
              <Card>
                <p style={mutedStyle}>Loading…</p>
              </Card>
            ) : healthPanel.status === "error" ? (
              <Card variant="status" tone="risk">
                <div style={{ color: "var(--status-risk-fg, #991b1b)" }}>
                  {healthPanel.message}
                </div>
                {healthPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {healthPanel.requestId}
                  </div>
                ) : null}
              </Card>
            ) : !health ? null : (
              <>
                <div style={statGridStyle}>
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
                    tone={health.incidents.openHigh > 0 ? "pending" : undefined}
                  />
                  <Stat
                    label="CRITICAL open"
                    value={String(health.incidents.openCritical)}
                    tone={
                      health.incidents.openCritical > 0 ? "risk" : undefined
                    }
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
                  <Card
                    variant="status"
                    tone="pending"
                    padding="compact"
                    style={{ marginTop: 12 }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--status-pending-fg, #78350f)",
                      }}
                    >
                      {health.violations.length} configuration issue
                      {health.violations.length === 1 ? "" : "s"} reported:{" "}
                      {health.violations.map((v) => v.envName).join(", ")}
                    </div>
                  </Card>
                ) : null}
              </>
            )}
          </PageSection>

          <PageSection
            title="Headline counters"
            description="In-process counters since the last API restart. All values reset on restart."
          >
            {metricsPanel.status === "error" ? (
              <Card variant="status" tone="risk">
                <div style={{ color: "var(--status-risk-fg, #991b1b)" }}>
                  {metricsPanel.message}
                </div>
                {metricsPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {metricsPanel.requestId}
                  </div>
                ) : null}
              </Card>
            ) : headlineCounters ? (
              <>
                <div style={statGridStyle}>
                  <Stat
                    label="Jobs failed"
                    value={String(headlineCounters.jobsFailed)}
                    tone={headlineCounters.jobsFailed > 0 ? "pending" : undefined}
                  />
                  <Stat
                    label="Invalid webhook sigs"
                    value={String(headlineCounters.webhooksInvalid)}
                    tone={
                      headlineCounters.webhooksInvalid > 0 ? "pending" : undefined
                    }
                  />
                  <Stat
                    label="Comms failed"
                    value={String(headlineCounters.commsFailed)}
                    tone={headlineCounters.commsFailed > 0 ? "pending" : undefined}
                  />
                  <Stat
                    label="Step-up denied"
                    value={String(headlineCounters.stepUpDenied)}
                  />
                  <Stat
                    label="5xx"
                    value={String(headlineCounters.requests5xx)}
                    tone={headlineCounters.requests5xx > 0 ? "risk" : undefined}
                  />
                  <Stat
                    label="Alerts sent"
                    value={String(headlineCounters.alertsSent)}
                  />
                </div>
                {metrics ? (
                  <p style={{ ...mutedStyle, marginTop: 12 }}>
                    Process uptime: {Math.floor(metrics.uptimeSeconds / 60)} min ·{" "}
                    {Object.keys(metrics.counters).length} counters ·{" "}
                    {Object.keys(metrics.gauges).length} gauges
                  </p>
                ) : null}
              </>
            ) : (
              <Card>
                <p style={mutedStyle}>Loading…</p>
              </Card>
            )}
          </PageSection>

          <PageSection
            title="Operational incidents"
            description="System behaviour anomalies. Acknowledge, resolve, or suppress from the row actions."
            action={
              <FilterBar>
                <FilterBar.Select
                  label="Status"
                  value={status}
                  onChange={(v) => setStatus(v as IncidentStatus | "")}
                  options={[
                    { value: "", label: "All statuses" },
                    ...STATUSES.map((s) => ({ value: s, label: s })),
                  ]}
                />
                <FilterBar.Select
                  label="Severity"
                  value={severity}
                  onChange={(v) => setSeverity(v as IncidentSeverity | "")}
                  options={[
                    { value: "", label: "All severities" },
                    ...SEVERITIES.map((s) => ({ value: s, label: s })),
                  ]}
                />
              </FilterBar>
            }
          >
            {incidentsPanel.status === "error" ? (
              <Card variant="status" tone="risk">
                <div style={{ color: "var(--status-risk-fg, #991b1b)" }}>
                  {incidentsPanel.message}
                </div>
                {incidentsPanel.requestId ? (
                  <div style={{ ...mutedStyle, marginTop: 6 }}>
                    Reference: {incidentsPanel.requestId}
                  </div>
                ) : null}
              </Card>
            ) : (
              <DataTable<Incident>
                ariaLabel="Operational incidents"
                columns={incidentColumns}
                rows={incidents ?? []}
                getRowId={(i) => i.id}
                loading={incidentsPanel.status === "loading"}
                density="comfortable"
                emptyState={
                  <EmptyState
                    compact
                    title="No incidents match the filters"
                    purpose="Operational anomalies matching the selected status and severity appear here."
                  />
                }
                rowActions={(i) => (
                  <div
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      justifyContent: "flex-end",
                    }}
                  >
                    {i.status === "OPEN" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void transitionIncident(i.id, "ack")}
                      >
                        Ack
                      </Button>
                    ) : null}
                    {i.status === "OPEN" || i.status === "ACKNOWLEDGED" ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          onClick={() =>
                            void transitionIncident(i.id, "resolve")
                          }
                        >
                          Resolve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void transitionIncident(i.id, "suppress")
                          }
                        >
                          Suppress
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              />
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: BadgeTone;
}) {
  const accent =
    tone === "risk"
      ? "var(--status-risk-fg, #991b1b)"
      : tone === "pending"
        ? "var(--status-pending-fg, #78350f)"
        : "var(--ink-primary, #0f172a)";
  return (
    <Card padding="compact">
      <div style={{ fontSize: 20, fontWeight: 700, color: accent }}>
        {value}
      </div>
      <div style={{ ...mutedStyle, marginTop: 2 }}>{label}</div>
    </Card>
  );
}

function severityTone(severity: IncidentSeverity): BadgeTone {
  if (severity === "CRITICAL") return "risk";
  if (severity === "HIGH") return "pending";
  if (severity === "WARNING") return "pending";
  return "info";
}

function incidentStatusTone(status: IncidentStatus): BadgeTone {
  if (status === "RESOLVED") return "verified";
  if (status === "ACKNOWLEDGED") return "pending";
  if (status === "SUPPRESSED") return "neutral";
  return "risk";
}

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-muted, #94a3b8)",
};
const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
};
