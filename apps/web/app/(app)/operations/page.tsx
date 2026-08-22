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
import {
  useActiveWorkspaceId,
  usePlatformContext,
} from "../../../lib/platform-context";
import type { CapabilityKey } from "../../../lib/platform-context/types";
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
import { OperationsIntelligencePanel } from "../../../components/ai-copilot/OperationsIntelligencePanel";
import { IncidentAssignmentControl } from "../../../components/operations/IncidentAssignmentControl";

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
  /** CLOSURE PASS — the current owner, now projected by the API. */
  assignedOperatorUserId: string | null;
  assignedAtUtc: string | null;
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
    <PageRouteGate routeId="workspace.operations">
      <div data-hub-page data-hub-page-id="operations">
        <HubQuickActionsBar hubId="operations" />
        <OpsPageInner />
        {/* Phase P7 — bounded AI operational summaries (advisory only). */}
        <OperationsIntelligencePanel />
      </div>
    </PageRouteGate>
  );
}

function OpsPageInner() {
  // =========================================================================
  // CLOSURE PASS (2026-08-22) — PERSONAL WORKSPACES REACH OPERATIONS TOO.
  //
  // This read `useTeamWorkspaceGate()`, which refuses any workspace whose
  // scope is not TEAM and returns `no-workspace`. The console then rendered
  // "No workspace selected — switch to a workspace to use the operations
  // center" for every PERSONAL workspace.
  //
  // That silently cancelled the Phase-4B unlock for the exact context it was
  // written for. A solo Pro investigator IS granted OPERATIONS_VIEW — their
  // package produces conditions — and the route gate lets them through, and
  // then the page told them to switch to a workspace they are already in.
  // A real browser found it; no source-shape test could have, because every
  // line involved was individually correct.
  //
  // `useActiveWorkspaceId` is the canonical personal-aware resolver: after
  // the personal-workspace bootstrap every authenticated user has a real Team
  // row, so there is a workspace id here in both modes. What a caller may
  // actually DO with it stays decided by the capabilities below.
  // =========================================================================
  const teamId = useActiveWorkspaceId();

  // =========================================================================
  // ATTENTION ARCHITECTURE PHASE 6 (2026-08-22) — CAPABILITY-AWARE ACTIONS.
  //
  // The console rendered Ack / Resolve / Suppress unconditionally and let the
  // server refuse. That is three buttons that look available and are not, on
  // a surface where being able to act is the whole point — and it taught
  // operators that a 403 is a normal part of using the product.
  //
  // These are the SERVER-RESOLVED capabilities. The UI does not compare role
  // names, does not read a plan, and does not re-derive who may act; the
  // backend remains authoritative on every mutation and this only decides
  // what to draw.
  //
  // 6.3 — the same booleans give the single-operator (Personal Pro) shape for
  // free: OPERATIONS_ASSIGN is not granted where there is nobody to assign
  // to, so no assignment control renders. There is no PersonalOperationsPage
  // and no plan branch anywhere in this file.
  // =========================================================================
  const { envelope } = usePlatformContext();
  const capabilities: Partial<Record<CapabilityKey, boolean>> =
    envelope?.capabilities ?? {};
  const canAcknowledge = capabilities.OPERATIONS_ACKNOWLEDGE === true;
  const canResolve = capabilities.OPERATIONS_RESOLVE === true;
  const canSuppress = capabilities.OPERATIONS_SUPPRESS === true;
  // PHASE 6.3 — read and named, prefixed to say it has no control YET.
  //
  // Assignment is the capability that separates a shared workspace from a
  // single-operator one, and it is deliberately resolved here so the Personal
  // Pro shape is a CAPABILITY outcome rather than a plan branch. There is no
  // assignment control on this console today, so the binding is unused — and
  // it is kept rather than deleted because deleting it is how the next person
  // adds an assignment button gated on a role-name comparison instead.
  const canAssign = capabilities.OPERATIONS_ASSIGN === true;
  // A VIEWER holds OPERATIONS_VIEW and nothing else: they see the work and
  // the row action column simply is not drawn for them.
  //
  // Assignment counts as acting, so it opens the column too — a workspace
  // whose operators may hand work around but not close it is unusual, and
  // silently hiding their one available action would be wrong.
  const canActOnAnything =
    canAcknowledge || canResolve || canSuppress || canAssign;

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
  /** PHASE 2.2 — did the incident list reach the end of the collection? */
  const [incidentsComplete, setIncidentsComplete] = useState(true);
  /**
   * CLOSURE PASS — a bump token so an assignment refreshes the queue.
   *
   * Assignment changes a row the server owns, so the console re-reads rather
   * than patching local state: an optimistic write here could disagree with
   * what the server accepted (it re-checks eligibility), and a queue that
   * shows an owner the backend refused is the worst possible outcome for a
   * surface whose job is telling you who has what.
   */
  const [reloadToken, setReloadToken] = useState(0);
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
        const value = incidentsR.value as {
          incidents: Incident[];
          completeness?: { complete: boolean; mayAssertAllClear: boolean };
        };
        // PHASE 2.2 / 2.3 — carry the completeness verdict to the render.
        // "No incidents" over a partial read is not the same statement as
        // "no incidents", and an operations console is the last place that
        // difference may be blurred.
        setIncidentsComplete(value.completeness?.complete ?? true);
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
  }, [teamId, status, severity, reloadToken]);

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
      {/*
          CLOSURE PASS (2026-08-22) — the loading/error branches read
          `useTeamWorkspaceGate()`'s state machine, which this page no longer
          uses. The envelope's own state is the authority, and it is the same
          state `PageRouteGate` above already resolved: by the time this
          renders, the context has loaded or the gate has refused. The only
          remaining case worth its own branch is "loaded, but no workspace",
          which is genuinely reachable for an account mid-bootstrap.
      */}
      {!teamId ? (
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
            description={
              canActOnAnything
                ? "Unresolved work this workspace has to act on. Acknowledge, resolve, or suppress from the row actions."
                : "Unresolved work this workspace has to act on. You have read access here; acting on a condition needs an operator role."
            }
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
                  incidentsComplete ? (
                    <EmptyState
                      compact
                      title="No incidents match the filters"
                      purpose="Operational anomalies matching the selected status and severity appear here."
                    />
                  ) : (
                    // PHASE 2.3 — an empty list over an INCOMPLETE read is not
                    // an empty collection, and must not read like one.
                    <EmptyState
                      compact
                      title="Showing part of the list"
                      purpose="More conditions exist beyond this page, so this view is not the full picture. Narrow the filters or page forward to see the rest."
                    />
                  )
                }
                rowActions={
                  // A read-only operator gets no action column at all. An
                  // empty column of nothing is worse than no column: it reads
                  // as "these actions failed to load".
                  canActOnAnything
                    ? (i) => (
                        <div
                          data-ops-row-actions
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            justifyContent: "flex-end",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          {/* Ownership first: "who has this" is the question an
                              operator scanning a queue asks before "what can I
                              do to it". Rendered for every row the caller can
                              act on, including read-only ownership display for
                              those who may see but not reassign. */}
                          {teamId ? (
                            <IncidentAssignmentControl
                              incidentId={i.id}
                              teamId={teamId}
                              assignedOperatorUserId={i.assignedOperatorUserId}
                              canAssign={canAssign}
                              busy={busy}
                              onAssigned={() => setReloadToken((n) => n + 1)}
                            />
                          ) : null}
                          {canAcknowledge && i.status === "OPEN" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              data-ops-action="acknowledge"
                              disabled={busy}
                              onClick={() =>
                                void transitionIncident(i.id, "ack")
                              }
                            >
                              Acknowledge
                            </Button>
                          ) : null}
                          {canResolve &&
                          (i.status === "OPEN" ||
                            i.status === "ACKNOWLEDGED") ? (
                            <Button
                              size="sm"
                              variant="primary"
                              data-ops-action="resolve"
                              disabled={busy}
                              onClick={() =>
                                void transitionIncident(i.id, "resolve")
                              }
                            >
                              Resolve
                            </Button>
                          ) : null}
                          {canSuppress &&
                          (i.status === "OPEN" ||
                            i.status === "ACKNOWLEDGED") ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              data-ops-action="suppress"
                              disabled={busy}
                              onClick={() =>
                                void transitionIncident(i.id, "suppress")
                              }
                            >
                              Suppress
                            </Button>
                          ) : null}
                        </div>
                      )
                    : undefined
                }
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
