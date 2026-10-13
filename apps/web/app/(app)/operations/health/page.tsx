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
 * it. `527fcb2e` added the tenant answer on the API side —
 * `GET /v1/teams/:workspaceId/operations/health` and `/operations/alerts`,
 * where every number is a row count inside the caller's own workspace. This is
 * the surface that reads them.
 *
 * ===========================================================================
 * WHY /operations/health AND NOT /workspaces/:workspaceId/operations/health
 * ===========================================================================
 * Every route under `/workspaces` is gated by `EnterpriseSurfaceLayout`, so a
 * health page there would REDIRECT a Personal Pro operator to the Teams
 * product. `/operations` is the canonical workspace operational surface, is
 * not tier-gated, and already carries the tenant authority. The workspace is
 * named ON THE PAGE — label plus a scope chip.
 *
 * ===========================================================================
 * THE 2026-10-12 CONTRACT
 * ===========================================================================
 * `state` is CRITICAL | DEGRADED | ATTENTION | HEALTHY | UNKNOWN. UNKNOWN is
 * the server's answer when discovery never ran, is stale, failed or was
 * partial (`unknownReason` says which, in a bounded vocabulary) — and it is
 * rendered as Unknown with that reason in plain words, never as Healthy.
 * ATTENTION is "unresolved conditions remain, none critical or high". Counts
 * are the canonical UNRESOLVED set (open, acknowledged or suppressed), and
 * "Not yet acknowledged" is OPEN only. The alerts list is capped at the 100
 * most severe and says so when `complete` is false.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT
 * ===========================================================================
 * No counters. No gauges. No uptime. No queue depth, worker heartbeat, secret
 * fallback count or authorize tally — properties of the API PROCESS, which
 * live on `/admin/platform/observability` behind the platform gate.
 */

import Link from "next/link";

import "./workspace-health.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { identifierLabel } from "@proovra/shared";
import { categoryLabel } from "../_lib/vocabulary";
import { localizeCondition } from "@proovra/shared/i18n";
import {
  fillOperationsCopy,
  useOpsCopy,
  useOpsLocale,
  useOpsNumber,
  type OperationsCopy,
} from "../_lib/copy";

const POLL_INTERVAL_MS = 30_000;

type HealthState = "CRITICAL" | "DEGRADED" | "ATTENTION" | "HEALTHY" | "UNKNOWN";

type WorkspaceHealth = {
  scope: "WORKSPACE";
  workspaceId: string;
  /** A value this build does not know is rendered as UNKNOWN, never Healthy. */
  state: HealthState | string;
  /** Why the state is UNKNOWN (bounded), null otherwise. */
  unknownReason?: string | null;
  readiness?: string;
  /** The canonical UNRESOLVED set (open, acknowledged or suppressed). */
  openIncidents: { total: number; bySeverity: Record<string, number> };
  unresolvedIncidents: number;
  /** OPEN only: unresolved and not yet acknowledged by anybody. */
  untriagedIncidents?: number;
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
  /** The code the title/summary were rendered from; absent on an older server. */
  message?: { code: string | null; params: Record<string, unknown> | null; titleSource: "SOURCE_LABEL" | "CONDITION" } | null;
};

/** One alert's title and summary in the reader's language (stored text for legacy rows). */
function alertText(row: WorkspaceAlertRow, locale: string): { title: string; summary: string | null } {
  const text = localizeCondition(locale, {
    title: row.title,
    safeSummary: row.safeSummary ?? "",
    message: row.message ?? null,
    titleSource: row.message?.titleSource ?? null,
  });
  return { title: text.title, summary: text.summary.length > 0 ? text.summary : null };
}

type WorkspaceAlerts = {
  scope: "WORKSPACE";
  workspaceId: string;
  /** Most-severe-first, capped at 100. */
  items: WorkspaceAlertRow[];
  /** Over EVERY unresolved condition, not the capped rows. */
  counts: { total: number; critical: number; high: number };
  /** False when the item list is capped below the total. */
  complete?: boolean;
  evaluatedAtUtc: string;
};

/**
 * A read that FAILED is UNKNOWN — never HEALTHY, never zero. `state` is only
 * ever the server's word when the server actually answered.
 */
type Loaded<T> =
  | { kind: "LOADING" }
  | { kind: "OK"; value: T; atUtc: string }
  | { kind: "UNAVAILABLE"; message: string; atUtc: string };

const STATE_TONE: Record<HealthState, AppTone> = {
  HEALTHY: "green",
  ATTENTION: "amber",
  DEGRADED: "orange",
  CRITICAL: "red",
  // UNKNOWN is the absence of a verdict, not a calm one.
  UNKNOWN: "slate",
};

const KNOWN_STATES: ReadonlyArray<HealthState> = [
  "CRITICAL",
  "DEGRADED",
  "ATTENTION",
  "HEALTHY",
  "UNKNOWN",
];

/** Normalise the wire state: anything unrecognised is UNKNOWN. */
function healthStateOf(raw: unknown): HealthState {
  return typeof raw === "string" && (KNOWN_STATES as ReadonlyArray<string>).includes(raw)
    ? (raw as HealthState)
    : "UNKNOWN";
}

/** The plain-words reason for an UNKNOWN state. */
function unknownReasonText(reason: string | null | undefined, copy: OperationsCopy): string {
  const table = copy.health.unknownReason as Record<string, string | undefined>;
  return (reason ? table[reason] : undefined) ?? copy.health.unknownReason.DEFAULT;
}

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

/** The word the operations queue uses for the same severity value. */
function severityLabel(severity: string, copy: OperationsCopy): string {
  const entry = (copy.severity as Record<string, { label: string } | undefined>)[
    severity.toUpperCase()
  ];
  return entry?.label ?? identifierLabel(severity);
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
  const copy = useOpsCopy();
  const locale = useOpsLocale();
  const fmt = useOpsNumber();
  const [health, setHealth] = useState<Loaded<WorkspaceHealth>>({
    kind: "LOADING",
  });
  const [alerts, setAlerts] = useState<Loaded<WorkspaceAlerts>>({
    kind: "LOADING",
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const workspaceRef = useRef<string | null>(workspaceId);
  workspaceRef.current = workspaceId;

  // A workspace switch shows LOADING, never the previous workspace's verdict
  // under the new workspace's name.
  const [scopeId, setScopeId] = useState<string | null>(workspaceId);
  if (scopeId !== workspaceId) {
    setScopeId(workspaceId);
    setHealth({ kind: "LOADING" });
    setAlerts({ kind: "LOADING" });
  }

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId) return;
    const ws = workspaceId;
    let cancelled = false;
    const stale = () => cancelled || workspaceRef.current !== ws;

    const tick = async () => {
      const atUtc = new Date().toISOString();
      // Read the two independently. One collector failing degrades its own
      // panel to Unavailable — not the page, and not the other panel.
      try {
        const h = (await apiFetch(
          `/v1/teams/${encodeURIComponent(ws)}/operations/health`,
        )) as WorkspaceHealth;
        if (!stale()) setHealth({ kind: "OK", value: h, atUtc });
      } catch (err) {
        if (!stale()) {
          setHealth({
            kind: "UNAVAILABLE",
            message: toSafeUserError(err, {
              message: copy.health.healthUnavailable,
            }).message,
            atUtc,
          });
        }
      }
      try {
        const a = (await apiFetch(
          `/v1/teams/${encodeURIComponent(ws)}/operations/alerts`,
        )) as WorkspaceAlerts;
        if (!stale()) setAlerts({ kind: "OK", value: a, atUtc });
      } catch (err) {
        if (!stale()) {
          setAlerts({
            kind: "UNAVAILABLE",
            message: toSafeUserError(err, {
              message: copy.health.alertsUnavailable,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshToken]);

  const state: HealthState =
    health.kind === "OK" ? healthStateOf(health.value.state) : "UNKNOWN";

  const workspaceLabel = activeSpace?.displayName ?? "this workspace";

  const severityRows = useMemo(() => {
    if (health.kind !== "OK") return [];
    const by = health.value.openIncidents.bySeverity ?? {};
    return (["CRITICAL", "HIGH", "WARNING", "INFO"] as const)
      .map((s) => ({ severity: s as string, count: by[s] ?? 0 }))
      .filter((r) => r.count > 0);
  }, [health]);

  const breadcrumb = (
    <OperationalBreadcrumb
      routeId="workspace.operations_health"
      items={[{ label: copy.pageTitle, href: "/operations" }, { label: copy.health.breadcrumb }]}
    />
  );

  if (!workspaceId) {
    return (
      <div className="wsh">
        {breadcrumb}
        <p className="wsh__note">{copy.health.noWorkspace}</p>
      </div>
    );
  }

  return (
    <div className="wsh">
      {breadcrumb}

      <header className="app-page-header wsh__header">
        <div className="app-page-header__text">
          <h1 className="app-page-header__title">{copy.health.title}</h1>
          <p className="app-page-header__subtitle">
            {copy.health.subtitleLead} <strong>{workspaceLabel}</strong>.{" "}
            {copy.health.subtitleTail}
          </p>
        </div>
        <div className="app-page-header__actions">
          <AppStatusBadge tone="blue">{copy.health.scopeLabel}</AppStatusBadge>
          <button
            type="button"
            className="app-secondary-action"
            onClick={refresh}
          >
            {copy.refresh}
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
            {copy.health.postureHeading}
          </h2>
        </div>
        <div className="app-panel__body">
          {health.kind === "LOADING" ? (
            <p className="wsh__note" role="status">{copy.health.evaluating}</p>
          ) : health.kind === "UNAVAILABLE" ? (
            <div className="wsh__unknown" role="status" data-wsh-state="UNAVAILABLE">
              <AppStatusBadge tone="slate">{copy.health.state.UNKNOWN}</AppStatusBadge>
              <p>
                {health.message}{" "}
                {fillOperationsCopy(copy.health.attempted, { time: formatUserTime(health.atUtc) })}{" "}
                {copy.health.healthUnavailableNote}
              </p>
            </div>
          ) : (
            <>
              <div className="wsh__state" data-wsh-state={state}>
                {/* The state is a WORD as well as a colour. */}
                <AppStatusBadge tone={STATE_TONE[state]}>
                  {copy.health.state[state]}
                </AppStatusBadge>
                <span className="wsh__state-reason" data-wsh-state-reason>
                  {state === "UNKNOWN"
                    ? unknownReasonText(health.value.unknownReason, copy)
                    : copy.health.reason[state]}
                </span>
              </div>
              <dl className="wsh__facts">
                <div>
                  <dt>{copy.health.factUnresolved}</dt>
                  <dd data-wsh-unresolved>{fmt(health.value.openIncidents.total)}</dd>
                </div>
                <div>
                  <dt>{copy.health.factUntriaged}</dt>
                  <dd data-wsh-untriaged>
                    {typeof health.value.untriagedIncidents === "number"
                      ? fmt(health.value.untriagedIncidents)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>{copy.health.factLastActivity}</dt>
                  <dd>
                    {health.value.lastIncidentActivityUtc
                      ? formatUserTime(health.value.lastIncidentActivityUtc)
                      : copy.health.noActivity}
                  </dd>
                </div>
                <div>
                  <dt>{copy.health.factEvaluated}</dt>
                  <dd>{formatUserTime(health.value.evaluatedAtUtc)}</dd>
                </div>
              </dl>
              {severityRows.length > 0 ? (
                <ul className="wsh__severities">
                  {severityRows.map((r) => (
                    <li key={r.severity}>
                      <AppStatusBadge tone={severityTone(r.severity)}>
                        {severityLabel(r.severity, copy)}
                      </AppStatusBadge>
                      <span>{fillOperationsCopy(copy.health.severityCount, { n: fmt(r.count) })}</span>
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
            {copy.health.conditionsHeading}
          </h2>
          <Link className="app-secondary-action" href="/operations">
            {copy.health.openQueue}
          </Link>
        </div>
        <div className="app-panel__body">
          {alerts.kind === "LOADING" ? (
            <p className="wsh__note" role="status">{copy.loading}</p>
          ) : alerts.kind === "UNAVAILABLE" ? (
            <div className="wsh__unknown" role="status">
              <AppStatusBadge tone="slate">{copy.health.state.UNKNOWN}</AppStatusBadge>
              <p>
                {alerts.message}{" "}
                {fillOperationsCopy(copy.health.attempted, { time: formatUserTime(alerts.atUtc) })}{" "}
                {copy.health.alertsUnavailableNote}
              </p>
            </div>
          ) : alerts.value.items.length === 0 ? (
            // An empty list is an all-clear only when the posture says so.
            <p className="wsh__note" data-wsh-alerts-empty>
              {state === "HEALTHY"
                ? fillOperationsCopy(copy.health.alertsEmpty, {
                    time: formatUserTime(alerts.value.evaluatedAtUtc),
                  })
                : copy.health.alertsEmptyUnconfirmed}
            </p>
          ) : (
            <>
              {alerts.value.complete === false ? (
                <p className="wsh__note" role="status" data-wsh-alerts-incomplete>
                  {fillOperationsCopy(copy.health.alertsIncomplete, {
                    shown: fmt(alerts.value.items.length),
                    total: fmt(alerts.value.counts.total),
                  })}
                </p>
              ) : null}
              <div className="app-table-surface app-table-surface--scroll">
                <table className="app-table">
                  <caption className="app-visually-hidden">
                    {copy.health.conditionsHeading}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{copy.colSeverity}</th>
                      <th scope="col">{copy.colCondition}</th>
                      <th scope="col">{copy.health.colCategory}</th>
                      <th scope="col">{copy.colStatus}</th>
                      <th scope="col">{copy.colFirstSeen}</th>
                      <th scope="col">{copy.health.colLastSeen}</th>
                      <th scope="col">{copy.health.colOccurrences}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.value.items.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <AppStatusBadge tone={severityTone(row.severity)}>
                            {severityLabel(row.severity, copy)}
                          </AppStatusBadge>
                        </td>
                        <td className="app-table__primary">
                          {alertText(row, locale).title}
                          {alertText(row, locale).summary ? (
                            <span className="app-table__muted">
                              {alertText(row, locale).summary}
                            </span>
                          ) : null}
                        </td>
                        <td className="app-table__muted">{categoryLabel(row.category, copy)}</td>
                        <td className="app-table__muted">
                          {(copy.status as Record<string, { label: string } | undefined>)[row.status]?.label ??
                            identifierLabel(row.status)}
                        </td>
                        <td className="app-table__muted">
                          {formatUserTime(row.firstSeenAtUtc)}
                        </td>
                        <td className="app-table__muted">
                          {formatUserTime(row.lastSeenAtUtc)}
                        </td>
                        <td className="app-table__muted">
                          {fmt(row.occurrenceCount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </section>

      <p className="wsh__footnote">{copy.health.footnote}</p>
    </div>
  );
}
