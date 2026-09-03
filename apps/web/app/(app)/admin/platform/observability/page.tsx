"use client";

/**
 * Phase Y — Observability operational dashboard.
 *
 * Dense, operator-facing surface for the in-process metrics registry
 * and the alert evaluation result. Lives under the existing Phase 21
 * Operations Center (`/operations`) — does NOT replace it. Polled every 15
 * seconds.
 *
 * SCOPE: PLATFORM. Every number on this page describes the API PROCESS and
 * the platform as a whole. None of it is scoped to a workspace, and switching
 * the active workspace cannot change a single value here.
 *
 * The page reads:
 *   - `GET /v1/admin/platform/metrics`   → counter + gauge snapshot
 *   - `GET /v1/admin/platform/alerts`    → alert evaluation over that snapshot
 *   - `GET /v1/admin/platform/readiness` → runtime readiness aggregator
 *
 * ADM-013 PHASE 1 — WHY THE WORKSPACE ID IS GONE
 * ---------------------------------------------------------------------------
 * This page used to call `/v1/ops/metrics?teamId=…` and `/v1/ops/alerts?teamId=…`
 * with the id of whatever workspace happened to be selected. Those endpoints
 * proved membership of that workspace and then returned the PROCESS-GLOBAL
 * registry, so the id was an authorization ticket and never a filter — the leak
 * that 1afd5e0f closed by moving both payloads behind the platform-admin gate.
 *
 * Passing a workspace id to a global payload is not merely redundant. It makes
 * the page LOOK tenant-scoped, which is how `operational_incidents_open 76`
 * came to be read as the count for a workspace that had two. The parameter is
 * removed rather than defaulted, and the scope is stated on screen.
 *
 * A consequence worth stating: after 1afd5e0f the old URLs return 403 to every
 * non-platform caller and this page rendered its error box for them. It was
 * BROKEN, not merely mis-scoped, until this change.
 *
 * Wording is operator-only. No marketing copy. No truth claims. No
 * raw evidence content.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { formatUserTime } from "../../../../../lib/date";
import {
  Sparkline,
  type SparklineSeverity,
} from "../../../../../components/operational";
import { PageShell, PageHeader } from "../../../../../components/ui";
import { Badge } from "../../../../../components/ui/Badge";

/**
 * ADM-013 PHASE 3 — the canonical platform health authority.
 *
 * This page used to compute its own headline from the process gauges, and the
 * Admin Overview computed its own from the incident table. In production they
 * printed 76 and 72 for the same question. The snapshot is now the ONE body
 * both read; the counters below it are the RAW instrument, kept because an
 * operator debugging the instrument needs it, and deliberately no longer the
 * thing the page leads with.
 */
type PlatformHealthSnapshot = {
  snapshotVersion: number;
  scope: "PLATFORM";
  overall: { state: HealthStateWord; reason: string };
  incidents: {
    openDurable: number | null;
    unresolvedDurable: number | null;
    bySeverity: {
      critical: number | null;
      high: number | null;
      warning: number | null;
      info: number | null;
    };
    platformInternal: number | null;
  };
  signals: {
    activeUnresolved: number | null;
    incidentBacked: number | null;
    additional: number | null;
    byCategory: Record<string, number>;
  };
  distinctAttentionItems: number | null;
  dependencies: SnapshotSubsystem[];
  queues: SnapshotSubsystem;
  workers: SnapshotSubsystem;
  search: SnapshotSubsystem;
  evidencePipeline: SnapshotSubsystem;
  evaluation: {
    lastAttemptUtc: string;
    lastSuccessUtc: string | null;
    freshnessSeconds: number | null;
    stale: boolean;
    sources: Array<{
      id: string;
      label: string;
      outcome: "OK" | "PARTIAL" | "UNAVAILABLE";
      detail: string | null;
    }>;
    partialSources: string[];
    unavailableSources: string[];
  };
};

type HealthStateWord = "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";

type SnapshotSubsystem = {
  id: string;
  label: string;
  state: HealthStateWord;
  reason: string;
  operatorAction: string | null;
  runbookSlug: string | null;
  affectedResource: string | null;
  observedAtUtc: string | null;
};

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

/**
 * The one posture statement every global surface shares.
 *
 * Four things are non-negotiable here and each closes one of the five
 * contradictions this phase records:
 *
 *   * the STATE always carries its REASON — a word with no reason is how
 *     "degraded" came to mean nothing;
 *   * a failed evaluation says so, and never renders as zero or as green;
 *   * FRESHNESS is printed, because a green computed four hours ago and a
 *     green computed now are different claims;
 *   * incidents and signals are reconciled in one sentence, because the two
 *     totals overlap and every surface that printed them side by side invited
 *     a reader to add them.
 */
function PlatformPostureBlock({
  snapshot,
  unavailable,
}: {
  snapshot: PlatformHealthSnapshot | null;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <section
        data-platform-posture
        data-posture-state="UNKNOWN"
        role="status"
        style={postureBlockStyle("UNKNOWN")}
      >
        <div style={postureHeadStyle}>
          <span style={postureStateStyle("UNKNOWN")}>UNKNOWN</span>
          <span style={postureReasonStyle}>
            Platform health could not be evaluated. This is not a statement that
            the platform is healthy — it is a statement that nothing was
            measured.
          </span>
        </div>
      </section>
    );
  }
  if (!snapshot) {
    return (
      <section
        data-platform-posture
        data-posture-state="PENDING"
        style={postureBlockStyle("UNKNOWN")}
      >
        <div style={postureHeadStyle}>
          <span style={postureStateStyle("UNKNOWN")}>EVALUATING</span>
          <span style={postureReasonStyle}>
            The first evaluation has not returned yet.
          </span>
        </div>
      </section>
    );
  }

  const { overall, incidents, signals, evaluation } = snapshot;
  const n = (v: number | null): string =>
    typeof v === "number" ? String(v) : "an unknown number of";

  return (
    <section
      data-platform-posture
      data-posture-state={overall.state}
      style={postureBlockStyle(overall.state)}
    >
      <div style={postureHeadStyle}>
        <span style={postureStateStyle(overall.state)}>{overall.state}</span>
        <span style={postureReasonStyle}>{overall.reason}</span>
      </div>

      <div style={postureMetaStyle}>
        Scope Platform · evaluated {formatUserTime(evaluation.lastAttemptUtc)}
        {evaluation.freshnessSeconds === null
          ? " · no fully-successful evaluation recorded in this process"
          : ` · last complete evaluation ${evaluation.freshnessSeconds}s ago`}
        {evaluation.stale ? " · STALE" : ""}
      </div>

      {evaluation.unavailableSources.length > 0 ? (
        <div style={posturePartialStyle} role="status">
          <strong>Partial evaluation.</strong>{" "}
          {evaluation.unavailableSources.join(", ")} did not answer. Every figure
          those sources feed is reported as unknown, not as zero.
        </div>
      ) : null}

      {/* THE RECONCILIATION. */}
      <div style={postureReconcileStyle} data-posture-reconciliation>
        {n(incidents.openDurable)} open incidents ·{" "}
        {n(signals.activeUnresolved)} unresolved signals ·{" "}
        {n(signals.incidentBacked)} of those signals are linked to those
        incidents · {n(signals.additional)} additional signals require review.
        The two totals are not added: {n(snapshot.distinctAttentionItems)}{" "}
        distinct items need attention.
        {incidents.platformInternal !== null && incidents.platformInternal > 0
          ? ` ${incidents.platformInternal} of the open incidents describe a PLATFORM component and are withheld from every tenant surface.`
          : ""}
      </div>

      <ul style={postureSubsystemListStyle}>
        {[
          snapshot.queues,
          snapshot.workers,
          snapshot.search,
          snapshot.evidencePipeline,
        ].map((sub) => (
          <li key={sub.id} style={postureSubsystemRowStyle}>
            <span style={postureStateStyle(sub.state)}>{sub.state}</span>
            <strong style={postureSubsystemLabelStyle}>{sub.label}</strong>
            <span style={postureSubsystemReasonStyle}>{sub.reason}</span>
            {sub.operatorAction ? (
              <span style={postureSubsystemActionStyle}>
                {sub.operatorAction}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const POSTURE_TONE: Record<HealthStateWord, { bg: string; border: string; ink: string }> = {
  HEALTHY: { bg: "#f0fdf4", border: "#86efac", ink: "#166534" },
  DEGRADED: { bg: "#fffbeb", border: "#fcd34d", ink: "#92400e" },
  CRITICAL: { bg: "#fef2f2", border: "#fca5a5", ink: "#991b1b" },
  // Neutral, not amber. UNKNOWN is not a lesser warning — it is the absence of
  // a measurement, and colouring it like a warning claims an observation that
  // was never made.
  UNKNOWN: { bg: "#f8fafc", border: "#cbd5e1", ink: "#334155" },
};

function postureBlockStyle(state: HealthStateWord): React.CSSProperties {
  const tone = POSTURE_TONE[state];
  return {
    marginBottom: 16,
    padding: "14px 16px",
    background: tone.bg,
    border: `1px solid ${tone.border}`,
    borderRadius: 10,
  };
}

function postureStateStyle(state: HealthStateWord): React.CSSProperties {
  const tone = POSTURE_TONE[state];
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    background: "#ffffff",
    border: `1px solid ${tone.border}`,
    color: tone.ink,
    whiteSpace: "nowrap",
  };
}

const postureHeadStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "baseline",
  flexWrap: "wrap",
};

const postureReasonStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#0f172a",
  fontWeight: 600,
};

const postureMetaStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: "#64748b",
};

const posturePartialStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  background: "#ffffff",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "#334155",
};

const postureReconcileStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12.5,
  lineHeight: 1.6,
  color: "#334155",
};

const postureSubsystemListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "12px 0 0",
  padding: 0,
  display: "grid",
  gap: 6,
};

const postureSubsystemRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  flexWrap: "wrap",
  fontSize: 12.5,
  lineHeight: 1.5,
};

const postureSubsystemLabelStyle: React.CSSProperties = {
  color: "#0f172a",
  textTransform: "capitalize",
};

const postureSubsystemReasonStyle: React.CSSProperties = {
  color: "#475569",
};

const postureSubsystemActionStyle: React.CSSProperties = {
  color: "#334155",
  fontStyle: "italic",
};

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function ObservabilityDashboardPage() {
  return (
    <PageRouteGate routeId="platform.observability">
      <ObservabilityDashboardPageInner />
    </PageRouteGate>
  );
}

function ObservabilityDashboardPageInner() {
  // NO workspace resolution. Deliberate: see the ADM-013 note in the file
  // header. `platform.observability` requires PLATFORM_TELEMETRY_VIEW, which is
  // granted to platform staff only, and the three endpoints below are gated by
  // `requirePlatformAdmin` server-side. There is no id to resolve.
  const [metrics, setMetrics] = useState<MetricsResponse["metrics"] | null>(
    null,
  );
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [readiness, setReadiness] = useState<RuntimeReadinessReport | null>(
    null,
  );
  const [readinessError, setReadinessError] = useState<boolean>(false);
  const [snapshot, setSnapshot] = useState<PlatformHealthSnapshot | null>(null);
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAtUtc, setLastPolledAtUtc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [m, a] = await Promise.all([
          apiFetch("/v1/admin/platform/metrics", {
            method: "GET",
          }) as Promise<MetricsResponse>,
          apiFetch("/v1/admin/platform/alerts", {
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
        const r = (await apiFetch("/v1/admin/platform/readiness", {
          method: "GET",
        })) as RuntimeReadinessReport;
        if (!cancelled) {
          setReadiness(r);
          setReadinessError(false);
        }
      } catch {
        if (!cancelled) setReadinessError(true);
      }
      // The canonical posture. A failure here is NOT rendered as a calm page:
      // the block below says the evaluation did not complete, which is a
      // different statement from "nothing is wrong".
      try {
        const snap = (await apiFetch("/v1/admin/platform/health-snapshot", {
          method: "GET",
        })) as PlatformHealthSnapshot;
        if (!cancelled) {
          setSnapshot(snap);
          setSnapshotUnavailable(false);
        }
      } catch {
        if (!cancelled) {
          setSnapshot(null);
          setSnapshotUnavailable(true);
        }
      }
    };
    tick();
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // Empty dependency list is the point: nothing this page reads varies with
    // the active workspace, so nothing re-fetches when the operator switches.
  }, []);

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

  /** Every non-zero counter and gauge, not just the five on screen. */
  const nonZeroSignalCount = useMemo(() => {
    if (!metrics) return 0;
    return (
      Object.values(metrics.counters).filter((v) => v > 0).length +
      Object.values(metrics.gauges).filter((v) => v > 0).length
    );
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

  // ADM-013 PHASE 1 — the "No workspace selected" branch that stood here is
  // deleted, not disabled. It withheld PLATFORM telemetry until the operator
  // picked a workspace that the payload never consulted, which is the same
  // false tenant-scoping the endpoint change removes.

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Operations"
          title="Platform observability"
          subtitle={
            <>
              Runtime of the API process and the platform as a whole. Not scoped
              to a workspace — switching your active workspace does not change
              any value on this page. Polled every 15 s.
            </>
          }
          contextStrip={
            <>
              <Badge tone="info" subtle>
                Scope: Platform
              </Badge>
              {lastPolledAtUtc ? (
                <Badge tone="neutral" subtle>
                  Last sample {formatUserTime(lastPolledAtUtc)}
                </Badge>
              ) : null}
            </>
          }
          secondaryActions={
            <Link
              href="/operations"
              // 44px hit box; the header keeps its height (admin-console.css).
              className="admin-hit-link"
              style={navLinkStyle}
            >
              ← Operations Center
            </Link>
          }
        />
      }
    >
      {/* ADM-013 PHASE 1 — `RuntimeStatusBanner` is a WORKSPACE surface: it
          takes a teamId and reports that workspace's conditions. On a page whose
          every other number is platform-wide it read as a platform banner, which
          is the conflation this split removes. Workspace runtime state now has
          its own page at /operations/health. */}

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {/* ================================================================== */}
      {/* PLATFORM POSTURE — the canonical authority, above the instrument.   */}
      {/*                                                                     */}
      {/* The raw counter and gauge dump below is the INSTRUMENT. It is kept   */}
      {/* because an operator debugging the instrument needs it, and it is no  */}
      {/* longer what the page leads with: a reader who has to derive posture  */}
      {/* from 522 counters derives a different one each time, which is how    */}
      {/* this page and the Admin Overview came to disagree.                   */}
      {/* ================================================================== */}
      <PlatformPostureBlock
        snapshot={snapshot}
        unavailable={snapshotUnavailable}
      />

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
          {/* Both tables are the top five of a set the browser holds whole, so
              the denominator is a fact rather than a cap. "Top signals" with
              no denominator reads as "these are the signals". */}
          <ResultCount
            shown={topNonZeroCounters.length + topNonZeroGauges.length}
            total={nonZeroSignalCount}
            noun="non-zero signal"
            data-testid="admin-observability-signals-count"
          />
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
                  <div className="apf-table-wrap">
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
                  </div>
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
                  <div className="apf-table-wrap">
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
                  </div>
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
            <code style={codeStyle}>GET /v1/admin/platform/metrics</code> —
            authenticated JSON snapshot used by this dashboard.
          </li>
          <li>
            <code style={codeStyle}>GET /v1/admin/platform/alerts</code> —
            authenticated alert evaluation.
          </li>
          <li>
            {/* The tenant-scoped readiness endpoint is a DIFFERENT authority
                for a different audience — it proves membership of a named
                workspace and is not named here, because naming a workspace
                parameter on this page is what made a global payload read as a
                tenant one. */}
            <code style={codeStyle}>GET /v1/admin/platform/readiness</code> —
            cross-subsystem readiness used by the summary tiles. Platform-gated
            and workspace-independent.
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
  // The tone is an ATTRIBUTE, not a palette lookup. It used to resolve through
  // `SUMMARY_TILE_PALETTE` into inline styles built from the OPS_* token
  // exports, which meant no dark mode and no media query — and it made
  // "unknown" indistinguishable from "neutral" for anyone who could not rely
  // on the colour. See `.apf-tile` in admin-platform.css for what each tone
  // means and why unknown is grey and dashed rather than red.
  return (
    <div
      className="apf-tile"
      data-tone={tone}
      data-summary-tile={label.toLowerCase().replace(/s+/g, "_")}
      data-summary-tone={tone}
    >
      <div className="apf-tile-label">{label}</div>
      <div className="apf-tile-value">{value}</div>
      <div className="apf-tile-hint">{hint}</div>
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
    <div className="apf-stat">
      <div className="apf-tile-label" style={{ marginBottom: 8 }}>
        {caption}
      </div>
      {rows.length === 0 ? (
        <p style={{ ...mutedStyle, margin: 0 }}>{emptyHint}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map(([name, value]) => (
            <li
              key={name}
              className="apf-signal-row"
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
/**
 * The heat-cell severities.
 *
 * A type, not a palette. The colours moved to `.apf-tile[data-tone]` in
 * admin-platform.css alongside the summary tiles', so both use ONE vocabulary.
 * The previous arrangement had two JavaScript palettes that happened to agree
 * and nothing keeping them in agreement.
 */
type HeatSeverity = "warning" | "high" | "critical";
function HeatCell({
  kicker,
  metric,
  value,
  severity,
}: {
  kicker: string;
  metric: string;
  value: number;
  severity: HeatSeverity;
}) {
  return (
    <div
      className="apf-tile"
      data-tone={severity}
      data-heat-cell={kicker.toLowerCase().replace(/\s+/g, "_")}
      data-heat-severity={severity}
    >
      <div className="apf-tile-label">{kicker}</div>
      <div className="apf-tile-value">{value.toLocaleString()}</div>
      <code className="apf-tile-hint apf-mono">{metric}</code>
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
