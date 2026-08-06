"use client";

/**
 * Phase Y — Observability operational dashboard.
 *
 * Dense, operator-facing surface for the in-process metrics registry
 * and the alert evaluation result. Lives under the existing Phase 21
 * Operations Center (`/operations`) — does NOT replace it. Polled every 15
 * seconds.
 *
 * The page reads:
 *   - `GET /v1/ops/metrics`  → counter + gauge snapshot
 *   - `GET /v1/ops/alerts`   → currently firing alerts
 *
 * Both endpoints are authenticated and workspace-scoped. The page
 * uses the same canonical `useActiveWorkspaceId()` hook as the
 * Reviewer Ops surfaces so the workspace resolution is consistent
 * platform-wide.
 *
 * Wording is operator-only. No marketing copy. No truth claims. No
 * raw evidence content.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { formatUserTime } from "../../../../lib/date";
import {
  OPS_INK,
  OPS_SURFACE,
  OPS_TONES,
  RuntimeStatusBanner,
  Sparkline,
  type SparklineSeverity,
} from "../../../../components/operational";
import { PageShell, PageHeader } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";

type RuntimeReadinessReport = {
  status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
  ranAtUtc: string;
  subsystems: ReadonlyArray<{
    id: string;
    status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
    reasonCode: string;
    detail: string;
  }>;
};

type MetricsResponse = {
  metrics: {
    uptimeSeconds: number;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  };
};

type FiringAlert = {
  id: string;
  metric: string;
  op: string;
  value: number;
  severity: "WARNING" | "HIGH" | "CRITICAL";
  reason: string;
  window: string;
  observedValue: number;
};

type AlertsResponse = {
  firing: FiringAlert[];
  counts: {
    total: number;
    critical: number;
    high: number;
    warning: number;
  };
  evaluatedAtUtc: string;
};

const POLL_INTERVAL_MS = 15_000;

const COUNTER_GROUPS: Array<{
  title: string;
  prefixes: ReadonlyArray<string>;
}> = [
  {
    title: "Lifecycle + governance",
    prefixes: [
      "lifecycle_",
      "governance_",
      "retention_",
      "destruction_",
      "evidence_archived_total",
      "evidence_restored_total",
    ],
  },
  {
    title: "Review workflow",
    prefixes: ["reviewer_", "review_sla_", "workflows_", "workflow_"],
  },
  {
    title: "Notifications + audit",
    prefixes: [
      "notification_",
      "communication_",
      "alert_",
      "audit_",
      "platform_audit_",
    ],
  },
  {
    title: "Queues + workers",
    prefixes: [
      "queue_",
      "worker_",
      "jobs_",
      "ots_upgrade_",
      "search_indexing_",
    ],
  },
  {
    title: "Identity + access",
    prefixes: [
      "sso_",
      "scim_",
      "session_",
      "trusted_device_",
      "adaptive_",
      "geo_",
      "rbac_",
      "stale_session_",
      "suspicious_",
      "forced_reauth_",
      "privileged_",
    ],
  },
  {
    title: "Observability runtime",
    prefixes: ["observability_"],
  },
];

const GAUGE_GROUPS: Array<{
  title: string;
  prefixes: ReadonlyArray<string>;
}> = [
  {
    title: "Live backlog",
    prefixes: [
      "queue_",
      "lifecycle_",
      "governance_",
      "ots_upgrade_",
      "active_legal_holds",
      "stalled_uploads",
    ],
  },
  {
    title: "Reviewer queues",
    prefixes: ["reviewer_"],
  },
  {
    title: "Identity runtime",
    prefixes: [
      "active_sso_",
      "active_scim_",
      "active_sessions_",
      "stale_session_",
      "high_risk_sessions",
      "idp_in_outage",
      "scim_groups_",
      "quarantined_",
      "privileged_",
      "geo_cache_",
      "trusted_devices_",
    ],
  },
  {
    title: "Observability runtime",
    prefixes: ["observability_", "audit_chain_", "worker_last_heartbeat_"],
  },
];

// The sampled "hot" signals and their ring-buffer size are FIXED configuration —
// they depend on nothing the component renders. Declared at module scope so the
// sampling effect can depend on them honestly instead of re-allocating the array
// on every render (which is what made them an unlistable dependency before).
const SAMPLE_CAP = 20;
const HOT_METRICS: ReadonlyArray<{
  key: string;
  caption: string;
  severity: SparklineSeverity;
  source: "counter" | "gauge";
}> = [
  {
    key: "reviewer_sla_breach_total",
    caption: "SLA breaches",
    severity: "high",
    source: "counter",
  },
  {
    key: "reviewer_escalation_raised_total",
    caption: "Escalation rate",
    severity: "high",
    source: "counter",
  },
  {
    key: "queue_depth",
    caption: "Queue depth",
    severity: "warning",
    source: "gauge",
  },
  {
    key: "worker_retries_total",
    caption: "Worker retries",
    severity: "warning",
    source: "counter",
  },
  {
    key: "webhook_invalid_signature_total",
    caption: "Webhook bad-sig",
    severity: "warning",
    source: "counter",
  },
  {
    key: "governance_incident_opened_total",
    caption: "Governance incidents",
    severity: "high",
    source: "counter",
  },
];

function classifyForGroup<T extends string>(
  name: T,
  groups: Array<{ title: string; prefixes: ReadonlyArray<string> }>,
): string {
  for (const g of groups) {
    if (g.prefixes.some((p) => name.startsWith(p) || name === p)) {
      return g.title;
    }
  }
  return "Other";
}

function severityBadgeStyle(
  severity: "WARNING" | "HIGH" | "CRITICAL",
): React.CSSProperties {
  const palette: Record<typeof severity, [string, string, string]> = {
    WARNING: ["#fffbeb", "#fcd34d", "#92400e"],
    HIGH: ["#fff7ed", "#fed7aa", "#9a3412"],
    CRITICAL: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[severity];
  return {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function ObservabilityDashboardPage() {
  return (
    <PageRouteGate routeId="platform.observability">
      <ObservabilityDashboardPageInner />
    </PageRouteGate>
  );
}

function ObservabilityDashboardPageInner() {
  // PageRouteGate guarantees ALLOWED; activeSpaceId resolves the
  // teamId without re-running the legacy workspace gate.
  const teamId = useActiveSpaceId();
  const [metrics, setMetrics] = useState<MetricsResponse["metrics"] | null>(
    null,
  );
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [readiness, setReadiness] = useState<RuntimeReadinessReport | null>(
    null,
  );
  const [readinessError, setReadinessError] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAtUtc, setLastPolledAtUtc] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [m, a] = await Promise.all([
          apiFetch(
            `/v1/ops/metrics?teamId=${encodeURIComponent(teamId)}`,
            { method: "GET" },
          ) as Promise<MetricsResponse>,
          apiFetch(`/v1/ops/alerts?teamId=${encodeURIComponent(teamId)}`, {
            method: "GET",
          }) as Promise<AlertsResponse>,
        ]);
        if (cancelled) return;
        setMetrics(m.metrics);
        setAlerts(a);
        setLastPolledAtUtc(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Unable to load." }).message);
      }
      // Runtime readiness — used by the summary rollup. Failure here
      // sets a flag so the rollup shows "Unknown" rather than implying
      // HEALTHY.
      try {
        const r = (await apiFetch(
          `/admin/runtime/readiness?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as RuntimeReadinessReport;
        if (!cancelled) {
          setReadiness(r);
          setReadinessError(false);
        }
      } catch {
        if (!cancelled) setReadinessError(true);
      }
    };
    tick();
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [teamId]);

  const counterGroups = useMemo(() => {
    if (!metrics) return new Map<string, [string, number][]>();
    const groups = new Map<string, [string, number][]>();
    for (const [name, value] of Object.entries(metrics.counters)) {
      const title = classifyForGroup(name, COUNTER_GROUPS);
      const existing = groups.get(title) ?? [];
      existing.push([name, value]);
      groups.set(title, existing);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a[0].localeCompare(b[0]));
    }
    return groups;
  }, [metrics]);

  const gaugeGroups = useMemo(() => {
    if (!metrics) return new Map<string, [string, number][]>();
    const groups = new Map<string, [string, number][]>();
    for (const [name, value] of Object.entries(metrics.gauges)) {
      const title = classifyForGroup(name, GAUGE_GROUPS);
      const existing = groups.get(title) ?? [];
      existing.push([name, value]);
      groups.set(title, existing);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a[0].localeCompare(b[0]));
    }
    return groups;
  }, [metrics]);

  // Phase 28-I — summary-first rollup. Picks the highest-signal counters
  // and gauges so the operator sees risk before the raw metric dump.
  const topNonZeroCounters = useMemo(() => {
    if (!metrics) return [] as Array<[string, number]>;
    return Object.entries(metrics.counters)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [metrics]);

  const topNonZeroGauges = useMemo(() => {
    if (!metrics) return [] as Array<[string, number]>;
    return Object.entries(metrics.gauges)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [metrics]);

  const degradedSubsystems = useMemo(() => {
    if (!readiness) return [] as Array<{ id: string; status: string }>;
    return readiness.subsystems
      .filter((s) => s.status !== "HEALTHY")
      .map((s) => ({ id: s.id, status: s.status }));
  }, [readiness]);

  // Phase 28-J — worker + queue subsystem visibility. Real values from
  // the readiness probe, not synthetic.
  const workersSubsystem = useMemo(
    () => readiness?.subsystems.find((s) => s.id === "workers") ?? null,
    [readiness],
  );
  const queuesSubsystem = useMemo(
    () => readiness?.subsystems.find((s) => s.id === "queues") ?? null,
    [readiness],
  );
  // Phase 24-B — search indexing subsystem readiness.
  const searchIndexingSubsystem = useMemo(
    () => readiness?.subsystems.find((s) => s.id === "search_indexing") ?? null,
    [readiness],
  );

  // Phase 28-J — rolling sample buffers for sparklines. Each metric we
  // care about gets a bounded queue of the last 20 polled values. This
  // is in-page session data only — not historical / persistent. Caller
  // sees REAL observed values, never fabricated counters.
  const [samples, setSamples] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!metrics) return;
    setSamples((prev) => {
      const next: Record<string, number[]> = { ...prev };
      for (const hot of HOT_METRICS) {
        const v =
          hot.source === "counter"
            ? metrics.counters[hot.key] ?? 0
            : metrics.gauges[hot.key] ?? 0;
        const buffer = next[hot.key] ? [...next[hot.key]] : [];
        buffer.push(v);
        while (buffer.length > SAMPLE_CAP) buffer.shift();
        next[hot.key] = buffer;
      }
      return next;
    });
    // We deliberately want to record one sample per polled `metrics`
    // snapshot, so depend on `metrics` only.
  }, [metrics]);

  // Phase 28-J — operational heat surfaces. Real signals derived from
  // the current gauge snapshot.
  const operationalHeat = useMemo(() => {
    if (!metrics) return null;
    const gaugeRows = Object.entries(metrics.gauges).filter(([, v]) => v > 0);
    const hottestQueue =
      gaugeRows
        .filter(([k]) => k.startsWith("queue_"))
        .sort((a, b) => b[1] - a[1])[0] ?? null;
    const slaPressure =
      gaugeRows
        .filter(
          ([k]) =>
            k.includes("reviewer_") &&
            (k.includes("breach") || k.includes("due") || k.includes("overdue")),
        )
        .sort((a, b) => b[1] - a[1])[0] ?? null;
    const escalationPressure =
      gaugeRows
        .filter(([k]) => k.includes("escalation"))
        .sort((a, b) => b[1] - a[1])[0] ?? null;
    const retryPressure =
      gaugeRows
        .filter(([k]) => k.includes("retry") || k.includes("retries"))
        .sort((a, b) => b[1] - a[1])[0] ?? null;
    return {
      hottestQueue,
      slaPressure,
      escalationPressure,
      retryPressure,
    };
  }, [metrics]);

  if (!teamId) {
    return (
      <PageShell
        header={
          <PageHeader
            eyebrow="Operations"
            title="Observability"
            subtitle="Switch to a workspace to view operational telemetry."
          />
        }
      >
        <Card>
          <EmptyState
            compact
            title="No workspace selected"
            purpose="Switch to a workspace to view operational telemetry."
          />
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Operations"
          title="Observability"
          subtitle={
            <>
              Internal operator surface. In-process metrics + alert evaluation
              for the API runtime. Polled every 15 s.
              {lastPolledAtUtc
                ? ` Last sample: ${formatUserTime(lastPolledAtUtc)}`
                : ""}
            </>
          }
          contextStrip={
            lastPolledAtUtc ? (
              <Badge tone="neutral" subtle>
                Last sample {formatUserTime(lastPolledAtUtc)}
              </Badge>
            ) : null
          }
          secondaryActions={
            <Link href="/operations" style={navLinkStyle}>
              ← Operations Center
            </Link>
          }
        />
      }
    >
      <RuntimeStatusBanner teamId={teamId} />

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {alerts && alerts.counts.total > 0 ? (
        <section style={alertRibbonStyle}>
          <div style={alertRibbonHeaderStyle}>
            <strong>{alerts.counts.total} alert{alerts.counts.total === 1 ? "" : "s"} firing</strong>
            <span style={mutedStyle}>
              {alerts.counts.critical} critical · {alerts.counts.high} high · {alerts.counts.warning} warning
            </span>
          </div>
          <ul style={alertListStyle}>
            {alerts.firing.map((a) => (
              <li key={a.id} style={alertRowStyle}>
                <span style={severityBadgeStyle(a.severity)}>{a.severity}</span>
                <strong style={alertIdStyle}>{a.id}</strong>
                <span style={mutedStyle}>
                  {a.metric} {a.op} {a.value} · observed {a.observedValue} · window {a.window}
                </span>
                <div style={alertReasonStyle}>{a.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : alerts ? (
        <section style={okRibbonStyle}>
          <strong>No alerts firing</strong>
          <span style={mutedStyle}>
            {Object.keys(metrics?.counters ?? {}).length} counters · {Object.keys(metrics?.gauges ?? {}).length} gauges
            · uptime {metrics?.uptimeSeconds ?? 0}s
          </span>
        </section>
      ) : null}

      {/* Phase 28-I — summary-first rollup. Alerts firing, degraded
          subsystems, top non-zero counters, top non-zero gauges. */}
      <section
        data-observability-summary
        aria-label="Observability summary"
        style={summaryGridStyle}
      >
        <SummaryTile
          label="Alerts firing"
          value={alerts ? alerts.counts.total : "—"}
          tone={
            !alerts
              ? "neutral"
              : alerts.counts.critical > 0
                ? "critical"
                : alerts.counts.high > 0
                  ? "high"
                  : alerts.counts.warning > 0
                    ? "warning"
                    : "healthy"
          }
          hint={
            alerts
              ? `${alerts.counts.critical} critical · ${alerts.counts.high} high · ${alerts.counts.warning} warning`
              : "Loading…"
          }
        />
        <SummaryTile
          label="Degraded subsystems"
          value={
            readinessError
              ? "?"
              : !readiness
                ? "—"
                : degradedSubsystems.length
          }
          tone={
            readinessError
              ? "unknown"
              : !readiness
                ? "neutral"
                : degradedSubsystems.length === 0
                  ? "healthy"
                  : readiness.status === "CRITICAL"
                    ? "critical"
                    : "warning"
          }
          hint={
            readinessError
              ? "Readiness unavailable — treat as unknown"
              : !readiness
                ? "Loading…"
                : degradedSubsystems.length === 0
                  ? "All subsystems healthy"
                  : degradedSubsystems.map((s) => s.id).join(", ")
          }
        />
        <SummaryTile
          label="Runtime uptime"
          value={
            metrics ? `${Math.round(metrics.uptimeSeconds / 60)}m` : "—"
          }
          tone="neutral"
          hint={
            metrics
              ? "Since last api restart — all counters reset on restart"
              : "Loading…"
          }
        />
        <SummaryTile
          label="Worker heartbeat"
          value={
            readinessError
              ? "?"
              : !workersSubsystem
                ? "—"
                : workersSubsystem.status
          }
          tone={
            readinessError
              ? "unknown"
              : !workersSubsystem
                ? "neutral"
                : workersSubsystem.status === "CRITICAL"
                  ? "critical"
                  : workersSubsystem.status === "DEGRADED"
                    ? "warning"
                    : workersSubsystem.status === "UNKNOWN"
                      ? "unknown"
                      : "healthy"
          }
          hint={
            readinessError
              ? "Readiness unavailable — treat as unknown"
              : !workersSubsystem
                ? "Loading…"
                : workersSubsystem.detail || workersSubsystem.reasonCode
          }
        />
        <SummaryTile
          label="Queue health"
          value={
            readinessError
              ? "?"
              : !queuesSubsystem
                ? "—"
                : queuesSubsystem.status
          }
          tone={
            readinessError
              ? "unknown"
              : !queuesSubsystem
                ? "neutral"
                : queuesSubsystem.status === "CRITICAL"
                  ? "critical"
                  : queuesSubsystem.status === "DEGRADED"
                    ? "warning"
                    : queuesSubsystem.status === "UNKNOWN"
                      ? "unknown"
                      : "healthy"
          }
          hint={
            readinessError
              ? "Readiness unavailable — treat as unknown"
              : !queuesSubsystem
                ? "Loading…"
                : queuesSubsystem.detail || queuesSubsystem.reasonCode
          }
        />
        <SummaryTile
          label="Search indexing"
          value={
            readinessError
              ? "?"
              : !searchIndexingSubsystem
                ? "—"
                : searchIndexingSubsystem.status
          }
          tone={
            readinessError
              ? "unknown"
              : !searchIndexingSubsystem
                ? "neutral"
                : searchIndexingSubsystem.status === "CRITICAL"
                  ? "critical"
                  : searchIndexingSubsystem.status === "DEGRADED"
                    ? "warning"
                    : searchIndexingSubsystem.status === "UNKNOWN"
                      ? "unknown"
                      : "healthy"
          }
          hint={
            readinessError
              ? "Readiness unavailable — treat as unknown"
              : !searchIndexingSubsystem
                ? "Loading…"
                : searchIndexingSubsystem.detail ||
                  searchIndexingSubsystem.reasonCode
          }
        />
      </section>

      {/* Phase 28-J — operational heat row. Real values from the gauge
          snapshot; only the buckets that have non-zero hottest values
          render a card. */}
      {operationalHeat &&
      (operationalHeat.hottestQueue ||
        operationalHeat.slaPressure ||
        operationalHeat.escalationPressure ||
        operationalHeat.retryPressure) ? (
        <section
          data-observability-heat
          aria-label="Operational heat"
          style={{
            ...cardStyle,
            marginTop: 12,
          }}
        >
          <h2 style={sectionTitleStyle}>Operational heat</h2>
          <p style={mutedStyle}>
            Where the system is under the most operator pressure right now.
            Values are the current gauges, not synthetic.
          </p>
          <div style={heatGridStyle}>
            {operationalHeat.hottestQueue ? (
              <HeatCell
                kicker="Hottest queue"
                metric={operationalHeat.hottestQueue[0]}
                value={operationalHeat.hottestQueue[1]}
                severity={
                  operationalHeat.hottestQueue[1] > 100 ? "high" : "warning"
                }
              />
            ) : null}
            {operationalHeat.slaPressure ? (
              <HeatCell
                kicker="Highest SLA pressure"
                metric={operationalHeat.slaPressure[0]}
                value={operationalHeat.slaPressure[1]}
                severity="high"
              />
            ) : null}
            {operationalHeat.escalationPressure ? (
              <HeatCell
                kicker="Active escalation pressure"
                metric={operationalHeat.escalationPressure[0]}
                value={operationalHeat.escalationPressure[1]}
                severity="high"
              />
            ) : null}
            {operationalHeat.retryPressure ? (
              <HeatCell
                kicker="Highest retry source"
                metric={operationalHeat.retryPressure[0]}
                value={operationalHeat.retryPressure[1]}
                severity="warning"
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Phase 28-J — live sparklines for the highest-signal operational
          metrics. Built from a rolling sample buffer of polled values,
          NOT fabricated. */}
      {metrics ? (
        <section
          data-observability-sparklines
          aria-label="Live operational trends"
          style={{
            ...cardStyle,
            marginTop: 12,
          }}
        >
          <h2 style={sectionTitleStyle}>Live trends</h2>
          <p style={mutedStyle}>
            Last {SAMPLE_CAP} polled samples (~{(SAMPLE_CAP * 15) / 60} min) for
            the most operationally-relevant counters + gauges. Delta is the
            change since the first sample observed this session.
          </p>
          <div style={sparklineGridStyle}>
            {HOT_METRICS.map((hot) => {
              const buffer = samples[hot.key] ?? [];
              const first = buffer[0] ?? 0;
              const last = buffer[buffer.length - 1] ?? 0;
              const delta = buffer.length >= 2 ? last - first : null;
              return (
                <Sparkline
                  key={hot.key}
                  caption={hot.caption}
                  values={buffer}
                  severity={hot.severity}
                  delta={delta}
                  deltaWindow="this session"
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {!metrics ? null : (
        <section style={cardStyle} aria-label="Top non-zero counters">
          <h2 style={sectionTitleStyle}>Top signals</h2>
          <p style={mutedStyle}>
            Non-zero counters + gauges with the largest current values. Open
            a group below for the full metric list.
          </p>
          <div style={twoColStyle}>
            <SignalList
              caption="Top non-zero counters"
              rows={topNonZeroCounters}
              emptyHint="All counters at 0 since restart."
            />
            <SignalList
              caption="Top non-zero gauges"
              rows={topNonZeroGauges}
              emptyHint="All gauges at 0 — no current backlog."
            />
          </div>
        </section>
      )}

      {!metrics ? (
        <p style={mutedStyle}>Loading metrics…</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Counters</h2>
            <p style={mutedStyle}>
              Monotonic since this api instance started ({metrics.uptimeSeconds}s ago).
              All values reset on restart.
            </p>
            {[...counterGroups.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([title, rows]) => (
                <details key={title} style={groupStyle}>
                  <summary style={groupSummaryStyle}>
                    {title} <span style={groupCountStyle}>({rows.length})</span>
                  </summary>
                  <table style={tableStyle}>
                    <tbody>
                      {rows.map(([name, value]) => (
                        <tr key={name}>
                          <td style={tdMonoStyle}>{name}</td>
                          <td style={tdNumStyle(value)}>{value.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
          </section>

          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Gauges</h2>
            <p style={mutedStyle}>
              Last-write-wins. A non-zero gauge typically reflects current
              backlog / outstanding state.
            </p>
            {[...gaugeGroups.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([title, rows]) => (
                <details key={title} style={groupStyle}>
                  <summary style={groupSummaryStyle}>
                    {title} <span style={groupCountStyle}>({rows.length})</span>
                  </summary>
                  <table style={tableStyle}>
                    <tbody>
                      {rows.map(([name, value]) => (
                        <tr key={name}>
                          <td style={tdMonoStyle}>{name}</td>
                          <td style={tdNumStyle(value)}>{value.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
          </section>
        </>
      )}

      <details style={{ ...cardStyle, marginTop: 16 }}>
        <summary
          style={{ ...sectionTitleStyle, cursor: "pointer", marginBottom: 0 }}
        >
          Scrape endpoints + raw API references
        </summary>
        <ul style={{ ...listStyle, marginTop: 12 }}>
          <li>
            <code style={codeStyle}>GET /metrics</code> — Prometheus exposition
            format. Public; optionally gated by <code style={codeStyle}>METRICS_SCRAPE_TOKEN</code>.
          </li>
          <li>
            <code style={codeStyle}>GET /v1/ops/metrics?teamId=…</code> —
            authenticated JSON snapshot used by this dashboard.
          </li>
          <li>
            <code style={codeStyle}>GET /v1/ops/alerts?teamId=…</code> —
            authenticated alert evaluation.
          </li>
          <li>
            <code style={codeStyle}>GET /admin/runtime/readiness?teamId=…</code> —
            cross-subsystem readiness used by the summary tiles + runtime banner.
          </li>
          <li>
            <code style={codeStyle}>GET /readyz</code> — readiness probe (DB ping).
          </li>
          <li>
            <code style={codeStyle}>GET /healthz</code> — liveness probe.
          </li>
        </ul>
      </details>
    </PageShell>
  );
}

// -----------------------------------------------------------------------------
// Summary-first helpers (Phase 28-I)
// -----------------------------------------------------------------------------

type SummaryTone =
  | "neutral"
  | "healthy"
  | "warning"
  | "high"
  | "critical"
  | "unknown";

const SUMMARY_TILE_PALETTE: Record<
  SummaryTone,
  { bg: string; border: string; ink: string; kicker: string }
> = {
  neutral: {
    bg: OPS_SURFACE.card,
    border: OPS_SURFACE.border,
    ink: OPS_INK.default,
    kicker: OPS_INK.subtle,
  },
  healthy: {
    bg: OPS_TONES.healthy.bg,
    border: OPS_TONES.healthy.border,
    ink: OPS_TONES.healthy.ink,
    kicker: OPS_TONES.healthy.kicker,
  },
  warning: {
    bg: OPS_TONES.warning.bg,
    border: OPS_TONES.warning.border,
    ink: OPS_TONES.warning.ink,
    kicker: OPS_TONES.warning.kicker,
  },
  high: {
    bg: OPS_TONES.high.bg,
    border: OPS_TONES.high.border,
    ink: OPS_TONES.high.ink,
    kicker: OPS_TONES.high.kicker,
  },
  critical: {
    bg: OPS_TONES.critical.bg,
    border: OPS_TONES.critical.border,
    ink: OPS_TONES.critical.ink,
    kicker: OPS_TONES.critical.kicker,
  },
  unknown: {
    bg: OPS_TONES.unknown.bg,
    border: OPS_TONES.unknown.border,
    ink: OPS_TONES.unknown.ink,
    kicker: OPS_TONES.unknown.kicker,
  },
};

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint: string;
  tone: SummaryTone;
}) {
  const palette = SUMMARY_TILE_PALETTE[tone];
  return (
    <div
      data-summary-tile={label.toLowerCase().replace(/\s+/g, "_")}
      data-summary-tone={tone}
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: palette.kicker,
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: palette.ink,
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 12,
          color: palette.ink,
          opacity: 0.85,
          lineHeight: 1.4,
        }}
      >
        {hint}
      </div>
    </div>
  );
}

function SignalList({
  caption,
  rows,
  emptyHint,
}: {
  caption: string;
  rows: ReadonlyArray<[string, number]>;
  emptyHint: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${OPS_SURFACE.border}`,
        borderRadius: 8,
        background: OPS_SURFACE.cardMuted,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          fontWeight: 700,
          color: OPS_INK.subtle,
          marginBottom: 8,
        }}
      >
        {caption}
      </div>
      {rows.length === 0 ? (
        <p style={{ ...mutedStyle, margin: 0 }}>{emptyHint}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map(([name, value]) => (
            <li
              key={name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                fontSize: 12,
                color: OPS_INK.default,
                borderTop: `1px solid ${OPS_SURFACE.border}`,
              }}
            >
              <code style={tdMonoStyle}>{name}</code>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                {value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles — enterprise/SOC dense layout
// -----------------------------------------------------------------------------

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "#334155",
  marginBottom: 8,
};
const cardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginTop: 16,
};
const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 12,
  marginTop: 8,
};
const heatGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginTop: 8,
};
const sparklineGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 14,
  marginTop: 8,
};
const heatCellPalette = {
  warning: {
    bg: OPS_TONES.warning.bg,
    border: OPS_TONES.warning.border,
    ink: OPS_TONES.warning.ink,
    kicker: OPS_TONES.warning.kicker,
  },
  high: {
    bg: OPS_TONES.high.bg,
    border: OPS_TONES.high.border,
    ink: OPS_TONES.high.ink,
    kicker: OPS_TONES.high.kicker,
  },
  critical: {
    bg: OPS_TONES.critical.bg,
    border: OPS_TONES.critical.border,
    ink: OPS_TONES.critical.ink,
    kicker: OPS_TONES.critical.kicker,
  },
} as const;
function HeatCell({
  kicker,
  metric,
  value,
  severity,
}: {
  kicker: string;
  metric: string;
  value: number;
  severity: keyof typeof heatCellPalette;
}) {
  const palette = heatCellPalette[severity];
  return (
    <div
      data-heat-cell={kicker.toLowerCase().replace(/\s+/g, "_")}
      data-heat-severity={severity}
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: palette.kicker,
          fontWeight: 700,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: palette.ink,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
        }}
      >
        {value.toLocaleString()}
      </div>
      <code
        style={{
          fontSize: 11,
          color: palette.ink,
          opacity: 0.85,
          fontFamily:
            "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        }}
      >
        {metric}
      </code>
    </div>
  );
}
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: 13,
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
const alertRibbonStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 12,
};
const alertRibbonHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  marginBottom: 8,
};
const alertListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const alertRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto auto 1fr",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 0",
  borderTop: "1px solid #fecaca",
  fontSize: 13,
};
const alertIdStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
};
const alertReasonStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#7f1d1d",
  gridColumn: "1 / -1",
};
const okRibbonStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  color: "#166534",
  borderRadius: 12,
  display: "flex",
  alignItems: "baseline",
  gap: 12,
};
const groupStyle: React.CSSProperties = {
  marginTop: 8,
  border: "1px solid #f1f5f9",
  borderRadius: 8,
};
const groupSummaryStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  color: "#334155",
  cursor: "pointer",
};
const groupCountStyle: React.CSSProperties = {
  marginLeft: 6,
  color: "#94a3b8",
  fontWeight: 400,
  fontSize: 12,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
};
const tdMonoStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderTop: "1px solid #f8fafc",
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
};
function tdNumStyle(value: number): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderTop: "1px solid #f8fafc",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    fontWeight: value > 0 ? 600 : 400,
    color: value > 0 ? "#0f172a" : "#94a3b8",
  };
}
const listStyle: React.CSSProperties = {
  paddingLeft: 20,
  margin: "8px 0 0",
  fontSize: 13,
  lineHeight: 1.7,
  color: "#334155",
};
const codeStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  background: "#f1f5f9",
  padding: "2px 6px",
  borderRadius: 4,
};
