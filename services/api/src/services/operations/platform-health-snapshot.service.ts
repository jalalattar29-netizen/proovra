/**
 * THE PLATFORM HEALTH SNAPSHOT — one authority, one set of numbers.
 *
 * ===========================================================================
 * THE FIVE CONTRADICTIONS THIS REPLACES
 * ===========================================================================
 * Five surfaces answered "is the platform healthy?" from five independent
 * computations, and in one production sample they disagreed like this:
 *
 *   Admin Overview            72 incidents
 *   Observability gauge       76 incidents
 *   Runtime popover            0 incidents, healthy
 *   Readiness                  green, beside "2 of 111 expected objects missing"
 *   Application header         Status pending
 *
 * Every one of those was internally defensible and all five were wrong
 * together, because nothing owned the question. The differences were not
 * rounding:
 *
 *   * `72` is `operationalIncident.count({ status: "OPEN" })`, straight from
 *     the table, with no scope predicate and no platform-internal exclusion.
 *   * `76` is the process gauge `operational_incidents_open`, written by a
 *     scanner on its own schedule. It reflects the last SCAN, not the table,
 *     and it resets to nothing on deploy.
 *   * `0 / healthy` is that same gauge read from a freshly restarted process,
 *     where "no value recorded" and "zero" are the same thing to the reader.
 *   * `green` beside two missing objects is a rollup that treats an `optional`
 *     severity as "does not count", so a real absence rounds to nothing.
 *   * `Status pending` is a collector that had not answered yet, rendered as a
 *     word that sounds like a state.
 *
 * ===========================================================================
 * THE RULES, AND WHY EACH ONE IS HERE
 * ===========================================================================
 * 1. A COLLECTOR THAT FAILED IS `UNKNOWN`, NEVER ZERO AND NEVER HEALTHY.
 *    Every existing aggregate in this codebase swallows a per-source throw and
 *    contributes nothing — which is correct as "do not fabricate" and wrong as
 *    "and say nothing about it", because a source contributing nothing is
 *    indistinguishable from a source contributing zero. Here a failed source is
 *    NAMED in `unavailableSources` and the states it feeds become `UNKNOWN`.
 *
 * 2. STALE DATA CANNOT CLAIM HEALTHY. A snapshot carries the age of its
 *    newest successful evaluation. Past the staleness bound the overall state
 *    degrades to `UNKNOWN` regardless of what the stale numbers said.
 *
 * 3. MISSING REQUIRED SCHEMA CANNOT CLAIM HEALTHY. Severity decides HOW BAD,
 *    never WHETHER. An `optional` object that is genuinely absent is reported
 *    as absent.
 *
 * 4. A PROCESS RESTART CANNOT ERASE DURABLE INCIDENTS. Incident counts come
 *    from rows, never from the in-process gauge. The gauge is not read here at
 *    all — not filtered, not preferred, not consulted.
 *
 * 5. SUMMARY COUNTS MATCH DRILL-DOWN COUNTS. `openDurableIncidents` is
 *    computed with the SAME predicate the drill-down list uses, from this
 *    module, so a card and the page behind it cannot diverge.
 *
 * 6. PLATFORM AND WORKSPACE STAY DIFFERENT PROJECTIONS. This module is
 *    platform-only and says so in `scope`. The workspace answer is
 *    `workspace-operations.routes.ts`, which reads tenant rows and cannot
 *    reach the process registry.
 *
 * ===========================================================================
 * INCIDENTS ARE NOT ALERTS, AND 72 + 78 IS NOT 150
 * ===========================================================================
 * `buildPlatformAlerts` emits one alert per open incident PLUS the
 * non-incident signals. So "72 open incidents" and "78 unresolved alerts" were
 * never two populations: 72 of the 78 ARE the 72. Rendering them as separate
 * totals invited every reader to add them.
 *
 * The reconciliation is a first-class part of the snapshot rather than
 * something each surface derives:
 *
 *   openDurableIncidents     72   rows in the incident table
 *   activeUnresolvedSignals  78   every alert-worthy signal right now
 *   incidentBackedSignals    72   of those, the ones an incident produced
 *   additionalSignals         6   of those, the ones nothing durable owns
 *   distinctAttentionItems   78   incidents + additional, counted once each
 *
 * `distinctAttentionItems` is the number a human should act on, and it is
 * derived here so that no card can invent a different one.
 */

import { prisma } from "../../db.js";
import {
  platformInternalIncidentWhere,
} from "../observability/incident-scope.js";
import {
  buildPlatformAlerts,
  type AlertSource,
  type PlatformAlert,
} from "../admin/alerts.service.js";
import { getQueueInventory, getWorkerHealth } from "./queue-inventory.service.js";
import { runReadinessCheck } from "../../runtime/runtime-readiness.js";
import { buildEvidenceHealthSnapshot } from "./evidence-health.service.js";

/** Bumped when the SHAPE changes, so a stale client can refuse rather than guess. */
export const PLATFORM_HEALTH_SNAPSHOT_VERSION = 1 as const;

/**
 * How old a successful evaluation may be before the snapshot stops claiming a
 * healthy state.
 *
 * Two minutes is not a tuning knob picked for comfort: every source below is
 * read live on each call, so a snapshot older than that means the CALLER is
 * showing a cached body, and a cached green is the failure mode rule 2 exists
 * for.
 */
export const SNAPSHOT_STALENESS_BOUND_SECONDS = 120;

export type HealthState = "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";

/** Why a source is not contributing. Never inferred — always recorded. */
export type SourceOutcome = "OK" | "PARTIAL" | "UNAVAILABLE";

export type SourceReport = {
  /** Stable id. Rendered by operators and asserted by tests. */
  id: string;
  label: string;
  outcome: SourceOutcome;
  /** Operator-safe. Never a stack, never a connection string. */
  detail: string | null;
};

/**
 * A subsystem's state, with everything a reader needs to act on it.
 *
 * `reason`, `scope`, `observedAtUtc` and `operatorAction` are REQUIRED, not
 * optional. A state word with no reason is how "degraded" came to mean
 * "something, somewhere, at some point" — and an amber pill nobody can act on
 * teaches operators to stop reading amber pills.
 */
export type SubsystemHealth = {
  id: string;
  label: string;
  state: HealthState;
  reason: string;
  /** What an operator should do. `null` ONLY when the state is HEALTHY. */
  operatorAction: string | null;
  /** Runbook slug where one exists for this subsystem. */
  runbookSlug: string | null;
  /** The affected resource, when the state names one. */
  affectedResource: string | null;
  observedAtUtc: string | null;
};

export type IncidentBreakdown = {
  /** Distinct OPEN rows. `null` when the read failed — never 0. */
  openDurable: number | null;
  /** OPEN or ACKNOWLEDGED. */
  unresolvedDurable: number | null;
  bySeverity: {
    critical: number | null;
    high: number | null;
    warning: number | null;
    info: number | null;
  };
  /**
   * Open incidents whose source is declared PLATFORM_INTERNAL — one global
   * condition, written once per workspace by a scanner with no tenant
   * predicate. Counted here so the platform operator sees the real fault, and
   * excluded from every tenant surface by `platformInternalExclusion()`.
   */
  platformInternal: number | null;
};

export type SignalBreakdown = {
  /** Every alert-worthy signal right now. */
  activeUnresolved: number | null;
  /** Of those, the ones an OperationalIncident produced. */
  incidentBacked: number | null;
  /** Of those, the ones nothing durable owns. */
  additional: number | null;
  /** By producing source, so a reader can see WHICH six the six are. */
  byCategory: Record<AlertSource, number>;
};

export type PlatformHealthSnapshot = {
  snapshotVersion: typeof PLATFORM_HEALTH_SNAPSHOT_VERSION;
  scope: "PLATFORM";

  overall: {
    state: HealthState;
    /** One sentence naming what decided the state. Never empty. */
    reason: string;
  };

  incidents: IncidentBreakdown;
  signals: SignalBreakdown;

  /**
   * Incidents plus signals nothing durable owns, counted once each.
   *
   * THE number to act on. `null` when either input is unknown, because a
   * partial sum presented as a total is the arithmetic this field exists to
   * stop.
   */
  distinctAttentionItems: number | null;

  dependencies: SubsystemHealth[];
  queues: SubsystemHealth;
  workers: SubsystemHealth;
  search: SubsystemHealth;
  evidencePipeline: SubsystemHealth;

  evaluation: {
    /** When this evaluation was STARTED. Always present. */
    lastAttemptUtc: string;
    /**
     * When an evaluation last completed with every source OK. `null` means no
     * fully-successful evaluation has happened in this process — which is a
     * different statement from "everything is fine".
     */
    lastSuccessUtc: string | null;
    /** Age of `lastSuccessUtc`. `null` when there has never been one. */
    freshnessSeconds: number | null;
    /** True when `freshnessSeconds` exceeds the bound, or is null. */
    stale: boolean;
    sources: SourceReport[];
    partialSources: string[];
    unavailableSources: string[];
  };
};

// ---------------------------------------------------------------------------
// Process-local memory of the last fully-successful evaluation.
//
// Deliberately NOT a durable row: this is a freshness fact about THIS process,
// and persisting it would let one instance's success make another instance's
// stale read look fresh. It is also deliberately not the incident count — the
// counts always come from the table, so a restart loses the freshness marker
// and never a number. Rule 4.
// ---------------------------------------------------------------------------
let lastFullySuccessfulEvaluationUtc: string | null = null;

/** Test seam. Never called by production code. */
export function __resetPlatformHealthSnapshotFreshness(): void {
  lastFullySuccessfulEvaluationUtc = null;
}

/**
 * Run one source, recording its outcome rather than swallowing it.
 *
 * The `catch` returns `null` like every other aggregate in this codebase — the
 * difference is the `SourceReport` that goes with it, so a caller can tell
 * "measured zero" from "could not measure".
 */
async function runSource<T>(
  id: string,
  label: string,
  fn: () => Promise<T>,
  reports: SourceReport[],
): Promise<T | null> {
  try {
    const value = await fn();
    reports.push({ id, label, outcome: "OK", detail: null });
    return value;
  } catch {
    reports.push({
      id,
      label,
      outcome: "UNAVAILABLE",
      // Operator-safe: names the source, never the error. The technical cause
      // is logged by the route, which has the request logger.
      detail: `${label} could not be read. Values it feeds are reported as unknown, not as zero.`,
      });
    return null;
  }
}

/** Worst-first ordering, so a rollup can take the maximum. */
const STATE_RANK: Record<HealthState, number> = {
  CRITICAL: 3,
  DEGRADED: 2,
  UNKNOWN: 1,
  HEALTHY: 0,
};

function worst(states: ReadonlyArray<HealthState>): HealthState {
  let out: HealthState = "HEALTHY";
  for (const s of states) if (STATE_RANK[s] > STATE_RANK[out]) out = s;
  return out;
}

/**
 * UNKNOWN outranks HEALTHY but NOT DEGRADED or CRITICAL.
 *
 * A failed collector must never round down to healthy — that is rule 1. It
 * must also never mask a fault another collector actually observed: if queues
 * are down and search is unreadable, the answer is CRITICAL with search marked
 * unknown, not UNKNOWN with the outage hidden behind it.
 */

// ---------------------------------------------------------------------------
// The build.
// ---------------------------------------------------------------------------

export async function buildPlatformHealthSnapshot(): Promise<PlatformHealthSnapshot> {
  const startedAt = new Date();
  const lastAttemptUtc = startedAt.toISOString();
  const sources: SourceReport[] = [];

  // ---- Incidents: from ROWS, never from the process gauge (rule 4) --------
  const incidentRows = await runSource(
    "incidents",
    "Operational incident table",
    async () => {
      const [openBySeverity, unresolved, platformInternal] = await Promise.all([
        prisma.operationalIncident.groupBy({
          by: ["severity"],
          where: { status: "OPEN" },
          _count: { _all: true },
        }),
        prisma.operationalIncident.count({
          where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        }),
        prisma.operationalIncident.count({
          where: { ...platformInternalIncidentWhere(), status: "OPEN" },
        }),
      ]);
      return { openBySeverity, unresolved, platformInternal };
    },
    sources,
  );

  const bySeverity = new Map<string, number>();
  if (incidentRows) {
    for (const row of incidentRows.openBySeverity) {
      bySeverity.set(String(row.severity).toUpperCase(), row._count._all);
    }
  }
  const openDurable = incidentRows
    ? incidentRows.openBySeverity.reduce((n, r) => n + r._count._all, 0)
    : null;

  const incidents: IncidentBreakdown = {
    openDurable,
    unresolvedDurable: incidentRows ? incidentRows.unresolved : null,
    bySeverity: {
      critical: incidentRows ? (bySeverity.get("CRITICAL") ?? 0) : null,
      high: incidentRows ? (bySeverity.get("HIGH") ?? 0) : null,
      warning: incidentRows ? (bySeverity.get("WARNING") ?? 0) : null,
      info: incidentRows ? (bySeverity.get("INFO") ?? 0) : null,
    },
    platformInternal: incidentRows ? incidentRows.platformInternal : null,
  };

  // ---- Signals, and the reconciliation against incidents ------------------
  const alertResult = await runSource(
    "signals",
    "Platform alert signals",
    () => buildPlatformAlerts(),
    sources,
  );

  const emptyByCategory: Record<AlertSource, number> = {
    incident: 0,
    security: 0,
    operational: 0,
    delivery: 0,
    health: 0,
    billing: 0,
    identity: 0,
  };

  let signals: SignalBreakdown;
  if (!alertResult) {
    signals = {
      activeUnresolved: null,
      incidentBacked: null,
      additional: null,
      byCategory: emptyByCategory,
    };
  } else {
    const byCategory = { ...emptyByCategory };
    for (const a of alertResult.items as ReadonlyArray<PlatformAlert>) {
      byCategory[a.source] += 1;
    }
    const incidentBacked = byCategory.incident;
    signals = {
      activeUnresolved: alertResult.total,
      incidentBacked,
      additional: alertResult.total - incidentBacked,
      byCategory,
    };
  }

  /**
   * Incidents plus the signals nothing durable owns.
   *
   * NOT `openDurable + activeUnresolved`, which double-counts every incident,
   * and not `activeUnresolved` alone, which under-counts when the alert
   * builder's `take: 100` truncates a larger incident population. Taking the
   * larger of the two incident figures is deliberate: the table is the
   * authority on how many incidents exist, and the alert list is the authority
   * on how many non-incident signals exist.
   */
  const distinctAttentionItems =
    openDurable === null || signals.additional === null
      ? null
      : openDurable + signals.additional;

  // ---- Queues + workers ---------------------------------------------------
  const inventory = await runSource(
    "queues",
    "Queue inventory",
    () => getQueueInventory(),
    sources,
  );
  const workers = await runSource(
    "workers",
    "Worker heartbeat",
    () => getWorkerHealth(),
    sources,
  );

  const nowIso = new Date().toISOString();

  const queueHealth: SubsystemHealth = (() => {
    if (!inventory) {
      return {
        id: "queues",
        label: "Queues",
        state: "UNKNOWN",
        reason:
          "The queue inventory could not be read, so queue depth and failure counts are unknown for this evaluation.",
        operatorAction:
          "Check Redis reachability from the API process, then re-evaluate.",
        runbookSlug: "queue-inventory-unavailable",
        affectedResource: null,
        observedAtUtc: nowIso,
      };
    }
    const outage = inventory.filter((q) => q.health === "outage");
    const failed = inventory.filter((q) => q.counts.failed > 0);
    const degraded = inventory.filter((q) => q.health === "degraded");
    if (outage.length > 0) {
      return {
        id: "queues",
        label: "Queues",
        state: "CRITICAL",
        reason: `${outage.length} queue${outage.length === 1 ? " is" : "s are"} unreachable.`,
        operatorAction: "Restore the queue backend, then replay failed jobs.",
        runbookSlug: "queue-outage",
        affectedResource: outage.map((q) => q.label).join(", "),
        observedAtUtc: nowIso,
      };
    }
    if (failed.length > 0 || degraded.length > 0) {
      // Deduplicated by queue name. A queue that is BOTH backed up and holding
      // failed jobs appears in both lists, and naming it twice in one sentence
      // reads as two affected queues.
      const affected = [...new Map(
        [...failed, ...degraded].map((q) => [q.queueName, q]),
      ).values()];
      const totalFailed = failed.reduce((n, q) => n + q.counts.failed, 0);
      return {
        id: "queues",
        label: "Queues",
        state: "DEGRADED",
        reason:
          totalFailed > 0
            ? `${totalFailed} failed job${totalFailed === 1 ? "" : "s"} across ${failed.length} queue${failed.length === 1 ? "" : "s"}.`
            : `${degraded.length} queue${degraded.length === 1 ? " is" : "s are"} backed up.`,
        operatorAction:
          "Inspect the failed jobs before replaying — a replay of a poisoned job re-fails it.",
        runbookSlug: "queue-failed-jobs",
        affectedResource: affected.map((q) => q.label).join(", "),
        observedAtUtc: nowIso,
      };
    }
    return {
      id: "queues",
      label: "Queues",
      state: "HEALTHY",
      reason: `${inventory.length} queue${inventory.length === 1 ? "" : "s"} reachable with no failed jobs.`,
      operatorAction: null,
      runbookSlug: null,
      affectedResource: null,
      observedAtUtc: nowIso,
    };
  })();

  const workerHealth: SubsystemHealth = (() => {
    if (!workers) {
      return {
        id: "workers",
        label: "Workers",
        state: "UNKNOWN",
        reason:
          "Worker heartbeat could not be read, so worker liveness is unknown for this evaluation.",
        operatorAction:
          "Check Redis reachability from the API process, then re-evaluate.",
        runbookSlug: "queue-inventory-unavailable",
        affectedResource: null,
        observedAtUtc: nowIso,
      };
    }
    const missing = workers.filter((w) => w.status === "missing");
    const degraded = workers.filter((w) => w.status === "degraded");
    const unknown = workers.filter((w) => w.status === "unknown");
    if (missing.length > 0) {
      return {
        id: "workers",
        label: "Workers",
        state: "CRITICAL",
        reason: `${missing.length} worker${missing.length === 1 ? " is" : "s are"} unreachable.`,
        operatorAction:
          "Confirm the worker deployment is running and connected before replaying anything.",
        runbookSlug: "worker-heartbeat-stale",
        affectedResource: missing.map((w) => w.queueName).join(", "),
        observedAtUtc: nowIso,
      };
    }
    if (degraded.length > 0) {
      return {
        id: "workers",
        label: "Workers",
        state: "DEGRADED",
        reason: `${degraded.length} worker${degraded.length === 1 ? " is" : "s are"} stalled or backed up.`,
        operatorAction: "Inspect stalled jobs; a stalled job holds its lock until the lease expires.",
        runbookSlug: "worker-heartbeat-stale",
        affectedResource: degraded.map((w) => w.queueName).join(", "),
        observedAtUtc: nowIso,
      };
    }
    if (unknown.length > 0) {
      return {
        id: "workers",
        label: "Workers",
        state: "UNKNOWN",
        reason: `${unknown.length} worker${unknown.length === 1 ? " reports" : "s report"} no usable status.`,
        operatorAction: "Confirm the worker publishes telemetry for these queues.",
        runbookSlug: "worker-heartbeat-stale",
        affectedResource: unknown.map((w) => w.queueName).join(", "),
        observedAtUtc: nowIso,
      };
    }
    return {
      id: "workers",
      label: "Workers",
      state: "HEALTHY",
      reason: `${workers.length} worker${workers.length === 1 ? "" : "s"} reporting activity.`,
      operatorAction: null,
      runbookSlug: null,
      affectedResource: null,
      observedAtUtc: nowIso,
    };
  })();

  // ---- Readiness: dependencies + search + schema --------------------------
  const readiness = await runSource(
    "readiness",
    "Runtime readiness",
    () => runReadinessCheck(prisma, null),
    sources,
  );

  function subsystemFromReadiness(
    id: string,
    label: string,
    runbookSlug: string | null,
  ): SubsystemHealth {
    if (!readiness) {
      return {
        id,
        label,
        state: "UNKNOWN",
        reason: `Runtime readiness did not complete, so ${label.toLowerCase()} state is unknown for this evaluation.`,
        operatorAction: "Re-run readiness; if it keeps failing, inspect the API logs.",
        runbookSlug,
        affectedResource: null,
        observedAtUtc: nowIso,
      };
    }
    const row = readiness.subsystems.find((s) => s.id === id);
    if (!row) {
      return {
        id,
        label,
        state: "UNKNOWN",
        reason: `Readiness returned no probe for ${label.toLowerCase()}. An absent probe is not a passing probe.`,
        operatorAction: "Confirm the probe is registered in runtime-readiness.",
        runbookSlug,
        affectedResource: null,
        observedAtUtc: readiness.ranAtUtc,
      };
    }
    const state = row.status as HealthState;
    return {
      id,
      label,
      state,
      reason: row.detail,
      operatorAction:
        state === "HEALTHY"
          ? null
          : (row.remediationHint ??
            "No remediation is recorded for this probe; escalate rather than guessing."),
      runbookSlug,
      affectedResource: null,
      observedAtUtc: readiness.ranAtUtc,
    };
  }

  const searchHealth = subsystemFromReadiness(
    "search_indexing",
    "Search",
    "search-indexing-lag",
  );

  /**
   * Dependencies = every readiness probe that is not one this snapshot already
   * reports on its own axis. Enumerated by EXCLUSION rather than by an
   * allowlist: a probe added to readiness and forgotten here would silently
   * stop being part of the platform's health, which is the class of omission
   * this whole module exists to close.
   */
  const OWN_AXES = new Set(["search_indexing", "queues", "workers"]);

  /**
   * ONE MEANING, ONE LABEL.
   *
   * `queues` and `workers` used to appear TWICE in this payload with opposite
   * states, because two probes answering different questions were both called
   * by the subsystem's name:
   *
   *   snapshot.queues / snapshot.workers   read Redis: is the queue reachable,
   *                                        is the fleet heartbeating?
   *   readiness "queues" / "workers"       read Postgres: is there an open
   *                                        HIGH/CRITICAL worker incident, and
   *                                        has a reviewer reconcile run lately?
   *
   * Both are worth knowing and neither is wrong. What was wrong was giving them
   * the same name, so one screen could say HEALTHY and DEGRADED about "queues"
   * at the same instant and both be reporting faithfully.
   *
   * The Redis-derived pair keeps the subsystem names, because that is what an
   * operator means by "are the queues up". The Postgres-derived pair is
   * renamed to what it actually measures and stays in the payload, because
   * deleting a real signal to resolve a naming collision would trade a
   * contradiction for a blind spot.
   */
  const RENAMED_AXES: Record<string, { id: string; label: string }> = {
    queues: {
      id: "worker_incident_backlog",
      label: "worker incident backlog",
    },
    workers: {
      id: "reviewer_reconcile",
      label: "reviewer reconcile sweep",
    },
  };

  const dependencies: SubsystemHealth[] = readiness
    ? readiness.subsystems
        .filter((s) => !OWN_AXES.has(s.id))
        .map((s) => ({
          id: s.id,
          label: s.id.replace(/_/g, " "),
          state: s.status as HealthState,
          reason: s.detail,
          operatorAction:
            s.status === "HEALTHY"
              ? null
              : (s.remediationHint ??
                "No remediation is recorded for this probe; escalate rather than guessing."),
          runbookSlug: null,
          affectedResource: null,
          observedAtUtc: readiness.ranAtUtc,
        }))
    : [];

  /**
   * The two renamed axes, re-added under names that say what they measure.
   * Same probe, same state, same remediation — only the label is corrected, so
   * an operator reading "worker incident backlog: DEGRADED" beside
   * "workers: HEALTHY" sees two facts rather than a contradiction.
   */
  if (readiness) {
    for (const probe of readiness.subsystems) {
      const renamed = RENAMED_AXES[probe.id];
      if (!renamed) continue;
      dependencies.push({
        id: renamed.id,
        label: renamed.label,
        state: probe.status as HealthState,
        reason: probe.detail,
        operatorAction:
          probe.status === "HEALTHY"
            ? null
            : (probe.remediationHint ??
              "No remediation is recorded for this probe; escalate rather than guessing."),
        runbookSlug: null,
        affectedResource: null,
        observedAtUtc: readiness.ranAtUtc,
      });
    }
  }

  // ---- Evidence pipeline --------------------------------------------------
  const evidence = await runSource(
    "evidence_pipeline",
    "Evidence pipeline health",
    () => buildEvidenceHealthSnapshot(),
    sources,
  );

  const evidencePipeline: SubsystemHealth = (() => {
    if (!evidence) {
      return {
        id: "evidence_pipeline",
        label: "Evidence pipeline",
        state: "UNKNOWN",
        reason:
          "The evidence-pipeline snapshot could not be assembled, so timestamping and report state are unknown for this evaluation.",
        operatorAction: "Re-evaluate; if it keeps failing, inspect the API logs.",
        runbookSlug: null,
        affectedResource: null,
        observedAtUtc: nowIso,
      };
    }
    const tsa = evidence.preservation.tsaFailures;
    const noReport = evidence.evidence.withoutReport;
    // `null` is NOT zero. A metric that could not be measured leaves the
    // pipeline state unknown rather than letting the metrics that DID answer
    // vote it healthy.
    if (tsa === null || noReport === null) {
      return {
        id: "evidence_pipeline",
        label: "Evidence pipeline",
        state: "UNKNOWN",
        reason:
          "At least one evidence-pipeline metric could not be measured, so the pipeline state is not established.",
        operatorAction: "Inspect the evidence-health snapshot for the unmeasured metric.",
        runbookSlug: null,
        affectedResource: null,
        observedAtUtc: evidence.generatedAtUtc,
      };
    }
    if (tsa > 0 || noReport > 0) {
      return {
        id: "evidence_pipeline",
        label: "Evidence pipeline",
        state: "DEGRADED",
        reason: `${tsa} record${tsa === 1 ? "" : "s"} with a failed timestamp; ${noReport} signed record${noReport === 1 ? "" : "s"} with no report. These populations OVERLAP — see Evidence health for the distinct total.`,
        operatorAction:
          "Open Evidence health and filter by cohort before retrying anything.",
        runbookSlug: "evidence-integrity-recovery",
        affectedResource: null,
        observedAtUtc: evidence.generatedAtUtc,
      };
    }
    return {
      id: "evidence_pipeline",
      label: "Evidence pipeline",
      state: "HEALTHY",
      reason: "No failed timestamps and no signed records missing a report.",
      operatorAction: null,
      runbookSlug: null,
      affectedResource: null,
      observedAtUtc: evidence.generatedAtUtc,
    };
  })();

  // ---- Freshness ----------------------------------------------------------
  const unavailableSources = sources
    .filter((s) => s.outcome === "UNAVAILABLE")
    .map((s) => s.id);
  const partialSources = sources
    .filter((s) => s.outcome === "PARTIAL")
    .map((s) => s.id);

  if (unavailableSources.length === 0 && partialSources.length === 0) {
    lastFullySuccessfulEvaluationUtc = lastAttemptUtc;
  }

  const lastSuccessUtc = lastFullySuccessfulEvaluationUtc;
  const freshnessSeconds =
    lastSuccessUtc === null
      ? null
      : Math.max(
          0,
          Math.round((Date.now() - Date.parse(lastSuccessUtc)) / 1000),
        );
  const stale =
    freshnessSeconds === null ||
    freshnessSeconds > SNAPSHOT_STALENESS_BOUND_SECONDS;

  // ---- Overall ------------------------------------------------------------
  const incidentState: HealthState =
    incidents.openDurable === null
      ? "UNKNOWN"
      : (incidents.bySeverity.critical ?? 0) > 0
        ? "CRITICAL"
        : (incidents.bySeverity.high ?? 0) > 0
          ? "DEGRADED"
          : "HEALTHY";

  const composed = worst([
    incidentState,
    queueHealth.state,
    workerHealth.state,
    searchHealth.state,
    evidencePipeline.state,
    ...dependencies.map((d) => d.state),
  ]);

  /**
   * Rule 2 applied LAST and only downward. A stale evaluation cannot upgrade a
   * fault it observed into an unknown, and cannot leave a green standing.
   */
  const overallState: HealthState =
    composed === "HEALTHY" && stale ? "UNKNOWN" : composed;

  const overallReason = ((): string => {
    if (overallState === "UNKNOWN" && composed === "HEALTHY") {
      return lastSuccessUtc === null
        ? "No evaluation has yet completed with every source available, so a healthy state cannot be claimed."
        : `Every source that answered reported healthy, but the last fully-successful evaluation is ${freshnessSeconds}s old (bound ${SNAPSHOT_STALENESS_BOUND_SECONDS}s).`;
    }
    if (unavailableSources.length > 0 && overallState === "UNKNOWN") {
      return `Unable to evaluate: ${unavailableSources.join(", ")} did not answer. This is not a statement that the platform is healthy.`;
    }
    const drivers = [
      queueHealth,
      workerHealth,
      searchHealth,
      evidencePipeline,
      ...dependencies,
    ].filter((s) => s.state === overallState);
    if (overallState === "HEALTHY") {
      return "Every source answered and none reported a fault.";
    }
    if (incidentState === overallState && drivers.length === 0) {
      return `${incidents.bySeverity.critical ?? 0} critical and ${incidents.bySeverity.high ?? 0} high open incidents.`;
    }
    return drivers.length > 0
      ? `${drivers.map((d) => d.label).join(", ")} — ${drivers[0]!.reason}`
      : "At least one source reported a non-healthy state.";
  })();

  return {
    snapshotVersion: PLATFORM_HEALTH_SNAPSHOT_VERSION,
    scope: "PLATFORM",
    overall: { state: overallState, reason: overallReason },
    incidents,
    signals,
    distinctAttentionItems,
    dependencies,
    queues: queueHealth,
    workers: workerHealth,
    search: searchHealth,
    evidencePipeline,
    evaluation: {
      lastAttemptUtc,
      lastSuccessUtc,
      freshnessSeconds,
      stale,
      sources,
      partialSources,
      unavailableSources,
    },
  };
}
