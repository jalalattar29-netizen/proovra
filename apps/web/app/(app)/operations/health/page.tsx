"use client";

/**
 * WORKSPACE HEALTH — the tenant half of the observability split.
 *
 * ===========================================================================
 * WHY THIS PAGE EXISTS
 * ===========================================================================
 * `1afd5e0f` moved `/v1/ops/metrics` and `/v1/ops/alerts` behind the
 * platform-admin gate, because their payload was the PROCESS-GLOBAL metric
 * registry and a workspace id had only ever been an authorization ticket over
 * it. That was correct, and it left workspace operators with no answer at all
 * to the question they actually have. `527fcb2e` added the answer on the API
 * side — `GET /v1/teams/:workspaceId/operations/health` and
 * `/operations/alerts`, where every number is a row count inside the caller's
 * own workspace. This is the surface that reads them.
 *
 * ===========================================================================
 * WHY /operations/health AND NOT /workspaces/:workspaceId/operations/health
 * ===========================================================================
 * A deliberate deviation, recorded here so it does not read as an oversight.
 *
 * `apps/web/lib/surface/tiers.ts` declares `{ pathPrefix: "/workspaces", tier:
 * "ENTERPRISE", directAccessPolicy: "redirect", redirectTo:
 * "/collaboration-teams" }`. Every route under `/workspaces` is gated by
 * `EnterpriseSurfaceLayout`, and a Next.js child layout NESTS inside its parent
 * rather than replacing it — so a health page there would REDIRECT a Personal
 * Pro operator to the Teams product. `WORKSPACE_HEALTH_VIEW` is granted to
 * exactly that operator. The explicitly-scoped URL would have produced the dead
 * end this phase exists to remove.
 *
 * `/operations` is the canonical workspace operational surface, is not
 * tier-gated, and already carries the tenant authority. The workspace is named
 * ON THE PAGE — label plus a scope chip — so the scope is explicit where it
 * matters, which is in front of the operator and not only in the URL.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT
 * ===========================================================================
 * No counters. No gauges. No uptime. No queue depth, worker heartbeat, secret
 * fallback count or authorize tally. Those are properties of the API PROCESS:
 * identical for every tenant on the instance, reset on deploy, and actionable
 * by nobody reading this page. They live on `/admin/platform/observability`
 * behind the platform gate.
 *
 * The API module backing this page imports none of `snapshotMetrics`,
 * `evaluateAlerts`, `setGauge` or `bump`, and a test asserts their absence, so
 * the boundary is structural rather than remembered.
 */

import Link from "next/link";

import "./workspace-health.css";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../../components/navigation/OperationalBreadcrumb";
import {
  AppStatusBadge,
  type AppTone,
} from "../../../../components/app-primitives";
import {
  useActiveSpace,
  useActiveSpaceId,
} from "../../../../lib/platform-context";

const POLL_INTERVAL_MS = 30_000;

type HealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "CRITICAL"
  | "STALE"
  | "UNKNOWN";

type WorkspaceHealth = {
  scope: "WORKSPACE";
  workspaceId: string;
  state: Exclude<HealthState, "UNKNOWN">;
  openIncidents: { total: number; bySeverity: Record<string, number> };
  unresolvedIncidents: number;
  lastIncidentActivityUtc: string | null;
  evaluatedAtUtc: string;
};

type WorkspaceAlertRow = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string | null;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  occurrenceCount: number;
  runbookSlug: string | null;
};

type WorkspaceAlerts = {
  scope: "WORKSPACE";
  workspaceId: string;
  items: WorkspaceAlertRow[];
  counts: { total: number; critical: number; high: number };
  evaluatedAtUtc: string;
};

/**
 * A read that FAILED is UNKNOWN — never HEALTHY, never zero.
 *
 * The whole class of defect this phase addresses is a surface rendering a calm
 * state because a collector threw. `state` is only ever the server's word when
 * the server actually answered.
 */
type Loaded<T> =
  | { kind: "LOADING" }
  | { kind: "OK"; value: T; atUtc: string }
  | { kind: "UNAVAILABLE"; message: string; atUtc: string };

const STATE_TONE: Record<HealthState, AppTone> = {
  HEALTHY: "green",
  DEGRADED: "amber",
  CRITICAL: "red",
  // Amber, not slate: STALE is an observation that something stopped
  // reporting, which is a warning. UNKNOWN is the absence of any observation.
  STALE: "amber",
  UNKNOWN: "slate",
};

const STATE_WORD: Record<HealthState, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  CRITICAL: "Critical",
  STALE: "Stale",
  UNKNOWN: "Unknown",
};

function severityTone(severity: string): AppTone {
  switch (severity.toUpperCase()) {
    case "CRITICAL":
      return "red";
    case "HIGH":
      return "orange";
    case "WARNING":
      return "amber";
    default:
      return "slate";
  }
}

export default function WorkspaceHealthPage() {
  return (
    <PageRouteGate routeId="workspace.operations_health">
      <WorkspaceHealthPageInner />
    </PageRouteGate>
  );
}

function WorkspaceHealthPageInner() {
  const workspaceId = useActiveSpaceId();
  const activeSpace = useActiveSpace();
  const [health, setHealth] = useState<Loaded<WorkspaceHealth>>({
    kind: "LOADING",
  });
  const [alerts, setAlerts] = useState<Loaded<WorkspaceAlerts>>({
    kind: "LOADING",
  });
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    const tick = async () => {
      const atUtc = new Date().toISOString();
      // Read the two independently. One collector failing must degrade its own
      // panel to Unavailable — not blank the page, and not let the other panel
      // imply the whole workspace was evaluated.
      try {
        const h = (await apiFetch(
          `/v1/teams/${encodeURIComponent(workspaceId)}/operations/health`,
        )) as WorkspaceHealth;
        if (!cancelled) setHealth({ kind: "OK", value: h, atUtc });
      } catch (err) {
        if (!cancelled) {
          setHealth({
            kind: "UNAVAILABLE",
            message: toSafeUserError(err, {
              message: "Workspace health could not be evaluated.",
            }).message,
            atUtc,
          });
        }
      }
      try {
        const a = (await apiFetch(
          `/v1/teams/${encodeURIComponent(workspaceId)}/operations/alerts`,
        )) as WorkspaceAlerts;
        if (!cancelled) setAlerts({ kind: "OK", value: a, atUtc });
      } catch (err) {
        if (!cancelled) {
          setAlerts({
            kind: "UNAVAILABLE",
            message: toSafeUserError(err, {
              message: "Workspace conditions could not be listed.",
            }).message,
            atUtc,
          });
        }
      }
    };

    void tick();
    const handle = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [workspaceId, refreshToken]);

  const state: HealthState =
    health.kind === "OK" ? health.value.state : "UNKNOWN";

  const workspaceLabel = activeSpace?.displayName ?? "this workspace";

  const severityRows = useMemo(() => {
    if (health.kind !== "OK") return [];
    const by = health.value.openIncidents.bySeverity;
    return (["CRITICAL", "HIGH", "WARNING", "INFO"] as const)
      .map((s) => ({ severity: s as string, count: by[s] ?? 0 }))
      .filter((r) => r.count > 0);
  }, [health]);

  const breadcrumb = (
    <OperationalBreadcrumb
      routeId="workspace.operations_health"
      items={[{ label: "Operations", href: "/operations" }, { label: "Health" }]}
    />
  );

  if (!workspaceId) {
    return (
      <main className="wsh">
        {breadcrumb}
        <p className="wsh__note">
          No workspace is currently selected. Workspace health describes one
          workspace at a time.
        </p>
      </main>
    );
  }

  return (
    <main className="wsh">
      {breadcrumb}

      <header className="app-page-header wsh__header">
        <div className="app-page-header__text">
          <h1 className="app-page-header__title">Workspace health</h1>
          <p className="app-page-header__subtitle">
            Unresolved operational conditions recorded against{" "}
            <strong>{workspaceLabel}</strong>. Every figure below is a record in
            this workspace — none of it is platform runtime.
          </p>
        </div>
        <div className="app-page-header__actions">
          <AppStatusBadge tone="blue">Scope: Workspace</AppStatusBadge>
          <button
            type="button"
            className="app-secondary-action"
            onClick={refresh}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Posture                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="app-panel wsh__posture"
        aria-labelledby="wsh-posture"
      >
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="wsh-posture">
            Current posture
          </h2>
        </div>
        <div className="app-panel__body">
          {health.kind === "LOADING" ? (
            <p className="wsh__note">Evaluating…</p>
          ) : health.kind === "UNAVAILABLE" ? (
            <div className="wsh__unknown" role="status">
              <AppStatusBadge tone="slate">Unknown</AppStatusBadge>
              <p>
                {health.message} Attempted {formatUserTime(health.atUtc)}. This
                is not a statement that the workspace is healthy — the
                evaluation did not complete.
              </p>
            </div>
          ) : (
            <>
              <div className="wsh__state">
                <AppStatusBadge tone={STATE_TONE[state]}>
                  {STATE_WORD[state]}
                </AppStatusBadge>
                <span className="wsh__state-reason">
                  {state === "CRITICAL"
                    ? "At least one critical condition is open in this workspace."
                    : state === "DEGRADED"
                      ? "At least one high-severity condition is open in this workspace."
                      : "No critical or high-severity conditions are open in this workspace."}
                </span>
              </div>
              <dl className="wsh__facts">
                <div>
                  <dt>Open conditions</dt>
                  <dd>{health.value.openIncidents.total}</dd>
                </div>
                <div>
                  <dt>Open or acknowledged</dt>
                  <dd>{health.value.unresolvedIncidents}</dd>
                </div>
                <div>
                  <dt>Last condition activity</dt>
                  <dd>
                    {health.value.lastIncidentActivityUtc
                      ? formatUserTime(health.value.lastIncidentActivityUtc)
                      : "No activity recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Evaluated</dt>
                  <dd>{formatUserTime(health.value.evaluatedAtUtc)}</dd>
                </div>
              </dl>
              {severityRows.length > 0 ? (
                <ul className="wsh__severities">
                  {severityRows.map((r) => (
                    <li key={r.severity}>
                      <AppStatusBadge tone={severityTone(r.severity)}>
                        {r.severity}
                      </AppStatusBadge>
                      <span>{r.count} open</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Conditions                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="app-panel" aria-labelledby="wsh-conditions">
        <div className="app-panel__head app-panel__head-row">
          <h2 className="app-panel__title" id="wsh-conditions">
            Unresolved conditions
          </h2>
          <Link className="app-secondary-action" href="/operations">
            Open the conditions queue
          </Link>
        </div>
        <div className="app-panel__body">
          {alerts.kind === "LOADING" ? (
            <p className="wsh__note">Loading…</p>
          ) : alerts.kind === "UNAVAILABLE" ? (
            <div className="wsh__unknown" role="status">
              <AppStatusBadge tone="slate">Unknown</AppStatusBadge>
              <p>
                {alerts.message} Attempted {formatUserTime(alerts.atUtc)}. The
                list below is not empty because there is nothing to show; it is
                empty because it could not be read.
              </p>
            </div>
          ) : alerts.value.items.length === 0 ? (
            <p className="wsh__note">
              No unresolved conditions are recorded against this workspace as of{" "}
              {formatUserTime(alerts.value.evaluatedAtUtc)}.
            </p>
          ) : (
            <div className="app-table-surface app-table-surface--scroll">
              <table className="app-table">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Condition</th>
                    <th scope="col">Category</th>
                    <th scope="col">First seen</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Occurrences</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.value.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <AppStatusBadge tone={severityTone(row.severity)}>
                          {row.severity}
                        </AppStatusBadge>
                      </td>
                      <td className="app-table__primary">
                        {row.title}
                        {row.safeSummary ? (
                          <span className="app-table__muted">
                            {row.safeSummary}
                          </span>
                        ) : null}
                      </td>
                      <td className="app-table__muted">{row.category}</td>
                      <td className="app-table__muted">
                        {formatUserTime(row.firstSeenAtUtc)}
                      </td>
                      <td className="app-table__muted">
                        {formatUserTime(row.lastSeenAtUtc)}
                      </td>
                      <td className="app-table__muted">
                        {row.occurrenceCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <p className="wsh__footnote">
        Platform runtime — process counters, queue depth, worker heartbeat and
        dependency probes — is not shown here. It is identical for every
        workspace on the instance and is administered by PROOVRA platform staff.
      </p>
    </main>
  );
}
