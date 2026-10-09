"use client";

/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE D/E — Org admin /
 * Operational Readiness tab.
 *
 * A customer-facing, ORG-SCOPED operational health surface. It answers
 * "is my organization's evidence platform operating normally right now?"
 * using ONLY the existing, gated, workspace-scoped health endpoints. It
 * does NOT build a new monitoring system, does NOT expose platform-wide
 * internals, secrets, DB connection strings, or any other tenant's data.
 *
 * ORG-SAFETY MODEL
 *   Every health endpoint below is WORKSPACE(team)-scoped and already
 *   gated server-side (member / role / permission checks). An org contains
 *   one or more workspaces. This page:
 *     1. Lists ONLY this org's workspaces via GET /v1/orgs/:id/workspaces
 *        (server-gated to org members; returns identity only).
 *     2. Lets the admin pick one workspace, then reads that workspace's
 *        real health. No cross-tenant fan-out, no platform aggregate.
 *   The server gates do the real enforcement; a non-member simply gets a
 *   404/403 that renders as an honest per-panel error.
 *
 * ENDPOINTS CONSUMED (all REAL, all org/workspace-scoped, all gated)
 *   GET /v1/orgs/:id/workspaces        — this org's workspaces (identity)
 *   GET /v1/ops/health?teamId=         — db up/down and open incidents by
 *                                        severity (ops.routes.ts). Process-wide
 *                                        configuration facts are platform-only
 *                                        (OPS-010) and are not read here.
 *   GET /v1/sso/health?teamId=         — per-SSO-connection status, cert
 *                                        expiry band, recommended action
 *   GET /v1/integrations/health?teamId= — webhook/API-key health, delivery
 *                                        success rate (null if none),
 *                                        failing endpoints, avg latency
 *   GET /v1/ops/incidents?teamId=&category= — evidence-operations signals
 *                                        (REPORT / PACKAGE / STORAGE)
 *
 * HONESTY
 *   - No fabricated availability figures. Every status is derived from a
 *     real response field. Degraded / unknown / not-configured render
 *     truthfully. "Last checked" reflects the actual response timestamp
 *     (or the client fetch time when the endpoint returns no timestamp).
 *   - When a signal has no org-scoped source (timestamping / anchoring)
 *     we render an explicit "Not surfaced at organization scope" row —
 *     we NEVER invent a status.
 *   - Per-panel bounded state machine: one endpoint failing (503/403)
 *     never blanks the rest of the page.
 *
 * CONSTITUTIONAL CHECKS
 *   - Wrapped in <PageRouteGate routeId="account.organization_admin_readiness">.
 *   - Read-only: no mutating apiFetch verbs, no window.confirm.
 *   - Only org/workspace-scoped endpoints; NO platform-internal surfaces
 *     (no raw-metrics counters, no schema-status probe, no queue internals).
 *   - toSafeUserError is the only non-ApiError display path.
 *   - Shared design system: Card / Badge (deep-imported).
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../../../lib/api";
import { usePlatformContext } from "../../../../../../lib/platform-context";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../../../lib/date";
import { Card } from "../../../../../../components/ui/Card";
import { Badge, type BadgeTone } from "../../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { identityProviderLabel } from "../../../../../../lib/labels/identityOrgLabels";
import { SEVERITY_VOCABULARY, STATUS_VOCABULARY } from "../../../../operations/_lib/vocabulary";
import type { IncidentSeverity, IncidentStatus } from "../../../../operations/_lib/types";

// ---------------------------------------------------------------------------
// Per-panel bounded state machine (mirrors the /operations page). A single
// endpoint failure never blanks the whole page.
// ---------------------------------------------------------------------------

type PanelState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; checkedAt: string }
  | { status: "error"; message: string };

const PANEL_LOADING = { status: "loading" } as const;

function panelError(err: unknown, fallback: string): { status: "error"; message: string } {
  return {
    status: "error",
    message: toSafeUserError(err, { message: fallback }).message,
  };
}

// ---------------------------------------------------------------------------
// Wire types — mirror the existing endpoint payload shapes.
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  workspaceId: string;
  name: string;
  isPersonal: boolean;
}
interface WorkspacesResponse {
  organizationId: string;
  summary: { totalWorkspaces: number };
  workspaces: WorkspaceRow[];
}

interface OpsHealth {
  ok: boolean;
  database: string; // "up" | "down"
  incidents: { openTotal: number; openHigh: number; openCritical: number };
}

interface SsoConnectionHealth {
  connectionId: string;
  provider: string;
  status: string;
  health: "HEALTHY" | "DEGRADED" | "OUTAGE" | "DISABLED" | "UNCONFIGURED";
  cert: {
    notAfterUtc: string | null;
    expiryBand: "ok" | "warning" | "expiring" | "expired";
    daysUntilExpiry: number | null;
  };
  recommendedAction: string | null;
}
interface SsoHealthSnapshot {
  teamId: string;
  generatedAtUtc: string;
  overallStatus: "HEALTHY" | "DEGRADED" | "OUTAGE" | "DISABLED" | "UNCONFIGURED";
  connections: SsoConnectionHealth[];
}

interface IntegrationsHealth {
  generatedAtUtc: string;
  activeApiKeys: number;
  activeWebhooks: number;
  deliveriesLast24h: number;
  successRateLast24h: number | null;
  failedDeliveriesLast24h: number;
  endpointsCurrentlyFailing: number;
  averageLatencyMsLast24h: number | null;
}

interface IncidentRow {
  id: string;
  category: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "SUPPRESSED";
  title: string;
  safeSummary: string;
  occurrenceCount: number;
  lastSeenAtUtc: string;
}

export default function OrganizationAdminReadinessPage() {
  return (
    <PageRouteGate routeId="account.organization_admin_readiness">
      <ReadinessTab />
    </PageRouteGate>
  );
}

function ReadinessTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  // Workspace picker — only this org's workspaces (server-gated).
  const [workspacesPanel, setWorkspacesPanel] =
    useState<PanelState<WorkspaceRow[]>>(PANEL_LOADING);
  const [teamId, setTeamId] = useState<string | null>(null);

  // Health panels (independent).
  const [opsPanel, setOpsPanel] = useState<PanelState<OpsHealth>>(PANEL_LOADING);
  const [ssoPanel, setSsoPanel] =
    useState<PanelState<SsoHealthSnapshot>>(PANEL_LOADING);
  const [integrationsPanel, setIntegrationsPanel] =
    useState<PanelState<IntegrationsHealth>>(PANEL_LOADING);
  const [evidencePanel, setEvidencePanel] =
    useState<PanelState<IncidentRow[]>>(PANEL_LOADING);
  // OPS-034 — the organisation's Operations, rolled up server-side from each
  // workspace's own summary, over the workspaces this person may read.
  const [rollupPanel, setRollupPanel] =
    useState<PanelState<OperationsRollup>>(PANEL_LOADING);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setRollupPanel(PANEL_LOADING);
    apiFetch(`/v1/orgs/${encodeURIComponent(orgId)}/operations/rollup`, { method: "GET" })
      .then((res) => {
        if (cancelled) return;
        setRollupPanel({ status: "ready", data: res as OperationsRollup, checkedAt: new Date().toISOString() });
      })
      .catch((err) => {
        if (cancelled) return;
        setRollupPanel(panelError(err, "Unable to load Operations across this organization."));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // 1) Load this org's workspaces.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setWorkspacesPanel(PANEL_LOADING);
    apiFetch(`/v1/orgs/${encodeURIComponent(orgId)}/workspaces`, {
      method: "GET",
    })
      .then((res) => {
        if (cancelled) return;
        const value = res as WorkspacesResponse;
        const rows = value.workspaces ?? [];
        setWorkspacesPanel({
          status: "ready",
          data: rows,
          checkedAt: new Date().toISOString(),
        });
        setTeamId((prev) => prev ?? rows[0]?.workspaceId ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setWorkspacesPanel(
          panelError(err, "Unable to load this organization's workspaces."),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // 2) Load per-workspace health for the selected workspace. Each request
  //    resolves independently via Promise.allSettled so one failing
  //    endpoint never blanks the others.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = `?teamId=${encodeURIComponent(teamId)}`;

    setOpsPanel(PANEL_LOADING);
    setSsoPanel(PANEL_LOADING);
    setIntegrationsPanel(PANEL_LOADING);
    setEvidencePanel(PANEL_LOADING);

    // Evidence-operations readiness: reuse the incidents endpoint filtered
    // to the evidence-pipeline categories that EXIST at org scope. We pull
    // OPEN incidents across those categories and roll them up per surface.
    const evidenceCategories = ["REPORT", "PACKAGE", "STORAGE"] as const;

    Promise.allSettled([
      apiFetch(`/v1/ops/health${qs}`, { method: "GET" }),
      apiFetch(`/v1/sso/health${qs}`, { method: "GET" }),
      apiFetch(`/v1/integrations/health${qs}`, { method: "GET" }),
      apiFetch(`/v1/ops/incidents${qs}&status=OPEN`, { method: "GET" }),
    ]).then(([opsR, ssoR, intR, incR]) => {
      if (cancelled) return;
      const now = new Date().toISOString();

      if (opsR.status === "fulfilled") {
        setOpsPanel({
          status: "ready",
          data: opsR.value as OpsHealth,
          checkedAt: now,
        });
      } else {
        setOpsPanel(panelError(opsR.reason, "Unable to load operational status."));
      }

      if (ssoR.status === "fulfilled") {
        const value = ssoR.value as { snapshot: SsoHealthSnapshot };
        setSsoPanel({
          status: "ready",
          data: value.snapshot,
          checkedAt: value.snapshot?.generatedAtUtc ?? now,
        });
      } else {
        setSsoPanel(panelError(ssoR.reason, "Unable to load SSO health."));
      }

      if (intR.status === "fulfilled") {
        const value = intR.value as { health: IntegrationsHealth };
        setIntegrationsPanel({
          status: "ready",
          data: value.health,
          checkedAt: value.health?.generatedAtUtc ?? now,
        });
      } else {
        setIntegrationsPanel(
          panelError(intR.reason, "Unable to load integrations health."),
        );
      }

      if (incR.status === "fulfilled") {
        const value = incR.value as { incidents: IncidentRow[] };
        const rows = (value.incidents ?? []).filter((i) =>
          (evidenceCategories as ReadonlyArray<string>).includes(i.category),
        );
        setEvidencePanel({ status: "ready", data: rows, checkedAt: now });
      } else {
        setEvidencePanel(
          panelError(incR.reason, "Unable to load evidence-operations readiness."),
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const workspaces =
    workspacesPanel.status === "ready" ? workspacesPanel.data : [];

  return (
    <section
      data-testid="org-admin-readiness"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="admin"
        data-section="readiness-intro"
        title="Operational readiness"
        subtitle={
          <>
            Live operational health for a workspace in this organization,
            read directly from the platform&apos;s health endpoints. Every
            status below reflects a real signal at the time shown next to
            &ldquo;Last checked&rdquo; — there are no fabricated availability
            figures.
          </>
        }
      >
        <WorkspacePicker
          panel={workspacesPanel}
          selected={teamId}
          onSelect={setTeamId}
          workspaces={workspaces}
        />
      </Card>

      <OperationsRollupSection panel={rollupPanel} orgId={orgId} />

      {teamId ? (
        <>
          <OperationalStatusSection panel={opsPanel} />
          <SsoHealthSection panel={ssoPanel} />
          <IntegrationsHealthSection panel={integrationsPanel} />
          <EvidenceOperationsSection panel={evidencePanel} />
        </>
      ) : workspacesPanel.status === "ready" ? (
        <Card variant="admin" data-section="readiness-no-workspace">
          <EmptyState
            title="Select a workspace"
            purpose="Choose a workspace above to view its operational readiness."
          />
        </Card>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// OPS-034 — Operations across this organization
// ---------------------------------------------------------------------------

type OperationsRollup = {
  organizationId: string;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    summary: {
      open: number;
      critical: number;
      high: number;
      warning: number;
      info: number;
      unassigned: number;
      readiness: string;
      mayAssertAllClear: boolean;
    };
  }>;
  totals: { open: number; critical: number; high: number; warning: number; info: number; unassigned: number };
  coverage: {
    workspacesInOrganization: number;
    workspacesIncluded: number;
    workspacesNotReadable: number;
    complete: boolean;
  };
};

/**
 * The organisation's unresolved Operations conditions, by workspace.
 *
 * Read-only and thin: the numbers are each workspace's own Operations summary,
 * summed by the server over the workspaces this person may read. A workspace
 * they cannot read is counted, never named, and the totals say they are
 * partial — an organisation role is not membership of every workspace.
 */
function OperationsRollupSection({
  panel,
  orgId,
}: {
  panel: PanelState<OperationsRollup>;
  orgId: string;
}) {
  if (panel.status === "loading") {
    return (
      <SectionCard section="operations-rollup" title="Operations across this organization" panel={panel}>
        {null}
      </SectionCard>
    );
  }
  if (panel.status === "error") {
    return (
      <SectionCard section="operations-rollup" title="Operations across this organization" panel={panel}>
        {null}
      </SectionCard>
    );
  }
  const r = panel.data;
  return (
    <SectionCard section="operations-rollup" title="Operations across this organization" panel={panel}>
      <p style={mutedStyle} data-rollup-totals>
        {r.totals.open === 1 ? "1 unresolved condition" : `${r.totals.open} unresolved conditions`}
        {" · "}
        {r.totals.critical} critical · {r.totals.high} high · {r.totals.unassigned} unassigned
      </p>
      {r.coverage.workspacesNotReadable > 0 ? (
        <p style={mutedStyle} data-rollup-partial>
          {r.coverage.workspacesNotReadable === 1
            ? "1 workspace in this organization is not included, because you are not an Operations reader there."
            : `${r.coverage.workspacesNotReadable} workspaces in this organization are not included, because you are not an Operations reader there.`}
        </p>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} data-rollup-workspaces>
        {r.workspaces.map((w) => (
          <li key={w.workspaceId} data-rollup-workspace={w.workspaceId}>
            <strong>{w.name}</strong>{" "}
            <span style={mutedStyle}>
              {w.summary.open} unresolved · {w.summary.critical} critical · {w.summary.high} high
            </span>
          </li>
        ))}
      </ul>
      <OrganizationIncidentList orgId={orgId} workspaces={r.workspaces} />
    </SectionCard>
  );
}

type OrgIncidentRow = {
  id: string;
  title: string;
  severity: string;
  status: string;
  lastSeenAtUtc: string;
  workspaceId: string | null;
  workspaceName: string | null;
};

/**
 * OPS-034 — the drilldown: the ORIGINAL conditions across the readable
 * workspaces, filterable by workspace and severity, paged by the server. A row
 * opens in its own workspace's Operations page, where every action runs
 * against that original condition.
 */
function OrganizationIncidentList({
  orgId,
  workspaces,
}: {
  orgId: string;
  workspaces: OperationsRollup["workspaces"];
}) {
  const router = useRouter();
  const { switchWorkspace } = usePlatformContext();
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [rows, setRows] = useState<OrgIncidentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(
    (next: string | null) => {
      const qs = new URLSearchParams();
      if (workspaceFilter) qs.set("workspaceId", workspaceFilter);
      if (severityFilter) qs.set("severity", severityFilter);
      if (next) qs.set("cursor", next);
      setState("loading");
      apiFetch(`/v1/orgs/${encodeURIComponent(orgId)}/operations/incidents?${qs.toString()}`, { method: "GET" })
        .then((res) => {
          const v = res as { incidents: OrgIncidentRow[]; pagination: { nextCursor: string | null } };
          setRows((prev) => (next ? [...prev, ...(v.incidents ?? [])] : (v.incidents ?? [])));
          setCursor(v.pagination?.nextCursor ?? null);
          setState("ready");
        })
        .catch(() => setState("error"));
    },
    [orgId, workspaceFilter, severityFilter],
  );
  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 12 }} data-rollup-incidents>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={mutedStyle}>
          Workspace{" "}
          <select value={workspaceFilter} onChange={(e) => setWorkspaceFilter(e.target.value)} data-rollup-filter-workspace>
            <option value="">All readable workspaces</option>
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label style={mutedStyle}>
          Severity{" "}
          <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} data-rollup-filter-severity>
            <option value="">Any</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>
        </label>
      </div>
      {state === "error" ? (
        <div style={errorBoxStyle} data-rollup-incidents-error>
          The conditions across this organization could not be loaded.
        </div>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {rows.map((i) => (
          <li key={i.id} data-rollup-incident={i.id}>
            <button
              type="button"
              className="app-secondary-action"
              onClick={async () => {
                if (!i.workspaceId) return;
                await switchWorkspace(i.workspaceId);
                router.push(`/operations?incident=${encodeURIComponent(i.id)}`);
              }}
              data-rollup-open={i.id}
            >
              {i.title}
            </button>{" "}
            <span style={mutedStyle}>
              {i.workspaceName ?? "—"} ·{" "}
              {(SEVERITY_VOCABULARY[i.severity as IncidentSeverity] ?? SEVERITY_VOCABULARY.INFO).label} ·{" "}
              {(STATUS_VOCABULARY[i.status as IncidentStatus] ?? STATUS_VOCABULARY.OPEN).label}
            </span>
          </li>
        ))}
      </ul>
      {cursor ? (
        <button type="button" className="app-secondary-action" onClick={() => load(cursor)} data-rollup-more>
          Load more
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace picker
// ---------------------------------------------------------------------------

function WorkspacePicker({
  panel,
  selected,
  onSelect,
  workspaces,
}: {
  panel: PanelState<WorkspaceRow[]>;
  selected: string | null;
  onSelect: (id: string) => void;
  workspaces: WorkspaceRow[];
}) {
  if (panel.status === "loading") {
    return <p style={mutedStyle}>Loading workspaces…</p>;
  }
  if (panel.status === "error") {
    return (
      <div data-testid="readiness-workspaces-error" style={errorBoxStyle}>
        {panel.message}
      </div>
    );
  }
  if (workspaces.length === 0) {
    return (
      <EmptyState
        title="No workspaces"
        purpose="This organization has no workspaces to report readiness for yet."
      />
    );
  }
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}>
        Workspace
      </span>
      <select
        data-testid="readiness-workspace-select"
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        style={selectStyle}
      >
        {workspaces.map((w) => (
          <option key={w.workspaceId} value={w.workspaceId}>
            {w.name}
            {w.isPersonal ? " (personal)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — Operational status
// ---------------------------------------------------------------------------

function OperationalStatusSection({ panel }: { panel: PanelState<OpsHealth> }) {
  return (
    <SectionCard
      section="operational-status"
      title="Operational status"
      panel={panel}
    >
      {panel.status === "ready" ? (
        <>
          <div style={gridStyle}>
            <StatCell
              label="Database"
              badge={
                panel.data.database === "up"
                  ? { tone: "verified", text: "Reachable" }
                  : { tone: "risk", text: "Unreachable" }
              }
            />
            <StatCell
              label="Open incidents"
              badge={{
                tone: panel.data.incidents.openTotal > 0 ? "pending" : "verified",
                text: String(panel.data.incidents.openTotal),
              }}
            />
            <StatCell
              label="High severity (open)"
              badge={{
                tone: panel.data.incidents.openHigh > 0 ? "risk" : "verified",
                text: String(panel.data.incidents.openHigh),
              }}
            />
            <StatCell
              label="Critical (open)"
              badge={{
                tone: panel.data.incidents.openCritical > 0 ? "risk" : "verified",
                text: String(panel.data.incidents.openCritical),
              }}
            />
          </div>
          <LastChecked at={panel.checkedAt} />
        </>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — Identity / SSO health (only when the org has SSO)
// ---------------------------------------------------------------------------

const SSO_TONE: Record<SsoHealthSnapshot["overallStatus"], BadgeTone> = {
  HEALTHY: "verified",
  DEGRADED: "pending",
  OUTAGE: "risk",
  DISABLED: "neutral",
  UNCONFIGURED: "neutral",
};

const CERT_TONE: Record<SsoConnectionHealth["cert"]["expiryBand"], BadgeTone> = {
  ok: "verified",
  warning: "pending",
  expiring: "pending",
  expired: "risk",
};

function SsoHealthSection({ panel }: { panel: PanelState<SsoHealthSnapshot> }) {
  // When SSO is not configured for the workspace the endpoint still
  // responds with an UNCONFIGURED overall status and no connections — we
  // render that honestly rather than hiding the section.
  return (
    <SectionCard
      section="sso-health"
      title="Identity & SSO health"
      panel={panel}
    >
      {panel.status === "ready" ? (
        panel.data.connections.length === 0 ? (
          <>
            <EmptyState
              title="No SSO connections"
              purpose="This workspace has no configured SSO connections. Federated sign-in health will appear here once a SAML or OIDC connection is bound."
            />
            <LastChecked at={panel.checkedAt} />
          </>
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <span style={labelStyle}>Overall</span>{" "}
              <Badge tone={SSO_TONE[panel.data.overallStatus]}>
                {panel.data.overallStatus}
              </Badge>
            </div>
            <ul style={listStyle} data-testid="sso-connection-list">
              {panel.data.connections.map((c) => (
                <li key={c.connectionId} style={rowStyle} data-sso-connection={c.connectionId}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {identityProviderLabel(c.provider)}
                    </div>
                    <div style={mutedStyle}>
                      Cert{" "}
                      <Badge tone={CERT_TONE[c.cert.expiryBand]} subtle>
                        {c.cert.expiryBand}
                        {c.cert.daysUntilExpiry != null
                          ? ` · ${c.cert.daysUntilExpiry}d`
                          : ""}
                      </Badge>
                      {c.recommendedAction ? ` · ${c.recommendedAction}` : ""}
                    </div>
                  </div>
                  <Badge tone={SSO_TONE[c.health]}>{c.health}</Badge>
                </li>
              ))}
            </ul>
            <LastChecked at={panel.checkedAt} />
          </>
        )
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — Integrations health
// ---------------------------------------------------------------------------

function IntegrationsHealthSection({
  panel,
}: {
  panel: PanelState<IntegrationsHealth>;
}) {
  return (
    <SectionCard
      section="integrations-health"
      title="Integrations health"
      panel={panel}
    >
      {panel.status === "ready" ? (
        <>
          <div style={gridStyle}>
            <StatCell
              label="Delivery success (24h)"
              badge={
                panel.data.successRateLast24h == null
                  ? { tone: "neutral", text: "—" } // honest null: no deliveries
                  : {
                      tone:
                        panel.data.successRateLast24h >= 0.99
                          ? "verified"
                          : panel.data.successRateLast24h >= 0.9
                            ? "pending"
                            : "risk",
                      text: `${Math.round(panel.data.successRateLast24h * 100)}%`,
                    }
              }
            />
            <StatCell
              label="Endpoints failing"
              badge={{
                tone: panel.data.endpointsCurrentlyFailing > 0 ? "risk" : "verified",
                text: String(panel.data.endpointsCurrentlyFailing),
              }}
            />
            <StatCell
              label="Failed deliveries (24h)"
              badge={{
                tone: panel.data.failedDeliveriesLast24h > 0 ? "pending" : "verified",
                text: String(panel.data.failedDeliveriesLast24h),
              }}
            />
            <StatCell
              label="Avg latency (24h)"
              badge={{
                tone: "neutral",
                text:
                  panel.data.averageLatencyMsLast24h == null
                    ? "—" // honest null: no measured deliveries
                    : `${panel.data.averageLatencyMsLast24h} ms`,
              }}
            />
            <StatCell
              label="Active webhooks"
              badge={{ tone: "neutral", text: String(panel.data.activeWebhooks) }}
            />
            <StatCell
              label="Active API keys"
              badge={{ tone: "neutral", text: String(panel.data.activeApiKeys) }}
            />
          </div>
          <p style={mutedStyle}>
            Delivery success rate and average latency show &ldquo;—&rdquo;
            when there were no deliveries in the last 24 hours (no data,
            not zero).
          </p>
          <LastChecked at={panel.checkedAt} />
        </>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — Evidence-operations readiness
//
// Report generation, verification-package generation, and storage /
// object-lock health are surfaced from OPEN operational incidents in the
// REPORT / PACKAGE / STORAGE categories (an org-safe signal). Timestamping
// (TSA) and anchoring (OTS) have NO org-scoped health signal — we say so
// honestly rather than inventing a status.
// ---------------------------------------------------------------------------

const EVIDENCE_SURFACES: ReadonlyArray<{
  key: string;
  label: string;
  category: string | null; // null => not surfaced at org scope
  description: string;
}> = [
  {
    key: "report",
    label: "Report generation",
    category: "REPORT",
    description: "PDF evidence-report rendering pipeline.",
  },
  {
    key: "package",
    label: "Verification-package generation",
    category: "PACKAGE",
    description: "Portable verification-package assembly.",
  },
  {
    key: "storage",
    label: "Storage & object-lock",
    category: "STORAGE",
    description: "Object storage availability and write-once retention.",
  },
  {
    key: "timestamping",
    label: "Timestamping (TSA)",
    category: null,
    description: "RFC 3161 trusted timestamping authority.",
  },
  {
    key: "anchoring",
    label: "Anchoring (OTS)",
    category: null,
    description: "OpenTimestamps blockchain anchoring.",
  },
];

function EvidenceOperationsSection({ panel }: { panel: PanelState<IncidentRow[]> }) {
  const bySurface = useMemo(() => {
    const map = new Map<string, IncidentRow[]>();
    if (panel.status === "ready") {
      for (const inc of panel.data) {
        const list = map.get(inc.category) ?? [];
        list.push(inc);
        map.set(inc.category, list);
      }
    }
    return map;
  }, [panel]);

  return (
    <SectionCard
      section="evidence-operations"
      title="Evidence-operations readiness"
      panel={panel}
    >
      {panel.status === "ready" ? (
        <>
          <ul style={listStyle} data-testid="evidence-surface-list">
            {EVIDENCE_SURFACES.map((surface) => {
              const incidents = surface.category
                ? bySurface.get(surface.category) ?? []
                : [];
              const hasCritical = incidents.some(
                (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
              );
              let badge: { tone: BadgeTone; text: string };
              if (surface.category == null) {
                badge = { tone: "neutral", text: "Not surfaced at organization scope" };
              } else if (incidents.length === 0) {
                badge = { tone: "verified", text: "Operating normally" };
              } else if (hasCritical) {
                badge = { tone: "risk", text: `${incidents.length} open incident(s)` };
              } else {
                badge = { tone: "pending", text: `${incidents.length} open incident(s)` };
              }
              return (
                <li
                  key={surface.key}
                  style={rowStyle}
                  data-evidence-surface={surface.key}
                  data-surfaced={surface.category == null ? "false" : "true"}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{surface.label}</div>
                    <div style={mutedStyle}>{surface.description}</div>
                    {incidents.slice(0, 3).map((i) => (
                      <div key={i.id} style={{ ...mutedStyle, marginTop: 4 }}>
                        {i.title} · last {formatUserDateTime(i.lastSeenAtUtc)}
                      </div>
                    ))}
                  </div>
                  <Badge tone={badge.tone}>{badge.text}</Badge>
                </li>
              );
            })}
          </ul>
          <p style={mutedStyle}>
            Report / package / storage readiness reflects open operational
            incidents in those categories for the selected workspace.
            Timestamping and anchoring have no organization-scoped health
            signal, so their state is reported honestly as not surfaced here.
          </p>
          <LastChecked at={panel.checkedAt} />
        </>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Shared presentational helpers
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  title,
  panel,
  children,
}: {
  section: string;
  title: string;
  panel: PanelState<unknown>;
  children: React.ReactNode;
}) {
  return (
    <Card variant="admin" data-section={`readiness-${section}`} title={title}>
      {panel.status === "loading" ? (
        <p style={mutedStyle}>Loading…</p>
      ) : panel.status === "error" ? (
        <div data-testid={`readiness-${section}-error`} style={errorBoxStyle}>
          {panel.message}
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function StatCell({
  label,
  badge,
}: {
  label: string;
  badge: { tone: BadgeTone; text: string };
}) {
  return (
    <div style={statStyle}>
      <div style={{ marginBottom: 6 }}>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

function LastChecked({ at }: { at: string }) {
  return (
    <div data-testid="readiness-last-checked" style={{ ...mutedStyle, marginTop: 12 }}>
      Last checked: {formatUserDateTime(at)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles (token-driven, consistent with the org-admin tabs)
// ---------------------------------------------------------------------------

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-secondary, #64748b)",
};
const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-secondary, #475569)",
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  marginBottom: 4,
};
const statStyle: React.CSSProperties = {
  padding: 12,
  background: "var(--surface-subtle, #f8fafc)",
  border: "1px solid var(--border-subtle, #e2e8f0)",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 0",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  flexWrap: "wrap",
};
const errorBoxStyle: React.CSSProperties = {
  padding: 12,
  background: "var(--status-risk-bg, #fef2f2)",
  color: "var(--status-risk-fg, #7f1d1d)",
  border: "1px solid var(--status-risk-border, #fecaca)",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--border-strong, #cbd5e1)",
  borderRadius: 6,
  fontSize: 14,
  background: "#fff",
  color: "var(--ink-primary, #0f172a)",
  maxWidth: 360,
};
