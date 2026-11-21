/**
 * THE OUTAGE WATCHDOG — makes the 2026-11-20/21 worker outage detectable.
 *
 * =============================================================================
 * WHAT HAPPENED
 * =============================================================================
 * The production worker crash-looped for ~25 h (306 restarts). Every start
 * reached the schema-head gate, found the database behind its build
 * (HEAD_NOT_APPLIED) and exited before it registered a lease or wrote a
 * heartbeat. Its previous instance had shut down cleanly, so the fleet read
 * STOPPED ("nothing here indicates a fault"); queues aged; scheduled
 * reconciliation (governance_reconciliation_runs) stopped for ~25.7 h. Every
 * one of those facts was readable by a surface somebody had to open. Nothing
 * pushed any of them to anyone: `dispatchOpsAlert` had no caller at all.
 *
 * =============================================================================
 * WHAT THIS DOES
 * =============================================================================
 * Runs in the API process (which stays up when the worker cannot start), as a
 * step of the platform maintenance sweep (every 5 minutes, under a lease, so
 * one replica evaluates per tick). Each detector reads an existing authority:
 *
 *   WORKER_SCHEMA_HEAD_REFUSAL   the refusal the worker records in Redis before
 *                                it exits (services/worker/src/boot-signal.ts);
 *   WORKER_RESTART_LOOP          the worker's own boot records (same file): N
 *                                process starts within the window;
 *   WORKER_NOT_LIVE              worker_leases via getWorkerFleetHealth: fewer
 *                                live instances than expected, INCLUDING a
 *                                fleet whose last instance stopped cleanly;
 *   QUEUE_BACKLOG_STALLED        BullMQ counts via getQueueInventory: a work
 *                                queue whose oldest waiting job is too old, or
 *                                whose waiting count passes the ceiling;
 *   RECONCILIATION_RUNS_MISSING  the newest worker-scheduled
 *                                governance_reconciliation_runs row is too old;
 *   DATABASE_BACKUP_MISSING      platform_backup_records: no successful backup
 *                                within the window, or the newest one FAILED.
 *
 * Signals go through the existing alert path (`dispatchOpsAlert`, provider
 * resolution webhook > noop). A signal alerts when it starts, reminds while it
 * lasts (default hourly, not every tick), and sends one "resolved" notice when
 * it clears. That state is kept in Redis so a replica taking over the lease
 * does not re-announce an ongoing outage.
 *
 * TRANSPORT DEPENDENCY: the only provider is a webhook (OPS_ALERT_WEBHOOK_URL,
 * read by the API from the server's env file). Unset, every dispatch is a
 * no-op; each undelivered alert is then logged at WARN as
 * `ops_watchdog.alert_undelivered`, and the summary counts it, so "nobody was
 * told" is itself visible. The receiver (PagerDuty, Slack incoming webhook, an
 * ops endpoint) is external and is not configured by this repository.
 *
 * WHAT IT CANNOT SEE: an API that is itself down. That needs a check from
 * outside the host (an uptime monitor on /readyz); see
 * docs/runbooks/disaster-recovery.md.
 */

import type { AlertCategory } from "@proovra/shared";
import {
  OPS_WORKER_BOOT_EVENTS_KEY,
  OPS_WORKER_SCHEMA_REFUSAL_KEY,
} from "@proovra/shared";

import type { AlertDispatchResult, AlertInput } from "../alerts/provider.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export type OutageWatchdogConfig = {
  /** Worker process starts within `restartWindowMinutes` that make a loop. */
  restartThreshold: number;
  restartWindowMinutes: number;
  /** A recorded schema refusal younger than this is current. */
  refusalWindowMinutes: number;
  /** Live worker instances the deployment expects; 0 switches the detector off. */
  expectedWorkers: number;
  /** A fleet below `expectedWorkers` for longer than this alerts. */
  workerNotLiveGraceMinutes: number;
  /** A work queue whose oldest waiting job is older than this is stalled. */
  queueStalledMinutes: number;
  /** A work queue with more waiting jobs than this is a backlog. */
  queueBacklogCeiling: number;
  /** The newest worker-scheduled reconciliation run older than this alerts. */
  reconciliationStaleMinutes: number;
  /** Whether scheduled database backups are expected (the compose `backup` profile). */
  backupExpected: boolean;
  /** No successful backup within this many hours alerts. */
  backupStaleHours: number;
  /** An ongoing signal is re-sent this often. */
  reminderMinutes: number;
};

export const OUTAGE_WATCHDOG_DEFAULTS: Readonly<OutageWatchdogConfig> = Object.freeze({
  // A deploy starts one process per worker; a refusing worker starts about
  // every 5 minutes (20 schema checks x 15 s), i.e. ~12 per hour.
  restartThreshold: 4,
  restartWindowMinutes: 60,
  refusalWindowMinutes: 30,
  expectedWorkers: 1,
  workerNotLiveGraceMinutes: 10,
  queueStalledMinutes: 30,
  queueBacklogCeiling: 1000,
  // Retention runs every 15 min and the destruction sweep every 5 min.
  reconciliationStaleMinutes: 60,
  backupExpected: true,
  // Two missed 6-hourly cycles plus an hour.
  backupStaleHours: 13,
  reminderMinutes: 60,
});

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Bounded: an unusable value falls back to the default, never to "off". */
export function readOutageWatchdogConfig(env: NodeJS.ProcessEnv = process.env): OutageWatchdogConfig {
  const d = OUTAGE_WATCHDOG_DEFAULTS;
  return {
    restartThreshold: intEnv(env, "OPS_WATCHDOG_RESTART_THRESHOLD", d.restartThreshold, 2, 1000),
    restartWindowMinutes: intEnv(env, "OPS_WATCHDOG_RESTART_WINDOW_MINUTES", d.restartWindowMinutes, 5, 1440),
    refusalWindowMinutes: intEnv(env, "OPS_WATCHDOG_REFUSAL_WINDOW_MINUTES", d.refusalWindowMinutes, 5, 1440),
    expectedWorkers: intEnv(env, "OPS_WATCHDOG_EXPECTED_WORKERS", d.expectedWorkers, 0, 64),
    workerNotLiveGraceMinutes: intEnv(env, "OPS_WATCHDOG_WORKER_GRACE_MINUTES", d.workerNotLiveGraceMinutes, 1, 1440),
    queueStalledMinutes: intEnv(env, "OPS_WATCHDOG_QUEUE_STALLED_MINUTES", d.queueStalledMinutes, 1, 1440),
    queueBacklogCeiling: intEnv(env, "OPS_WATCHDOG_QUEUE_BACKLOG_CEILING", d.queueBacklogCeiling, 1, 10_000_000),
    reconciliationStaleMinutes: intEnv(
      env,
      "OPS_WATCHDOG_RECONCILIATION_STALE_MINUTES",
      d.reconciliationStaleMinutes,
      5,
      7 * 1440,
    ),
    backupExpected: (env.OPS_WATCHDOG_BACKUP_EXPECTED ?? "").trim().toLowerCase() !== "false",
    backupStaleHours: intEnv(env, "OPS_WATCHDOG_BACKUP_STALE_HOURS", d.backupStaleHours, 1, 24 * 14),
    reminderMinutes: intEnv(env, "OPS_WATCHDOG_REMINDER_MINUTES", d.reminderMinutes, 5, 7 * 1440),
  };
}

// -----------------------------------------------------------------------------
// Facts the detectors read
// -----------------------------------------------------------------------------

export type SchemaRefusalFact = { kind: string; expected: string; workerId: string; atMs: number };

export type FleetFact = {
  /** getWorkerFleetHealth().state */
  state: "HEALTHY" | "STALE" | "STOPPED" | "NOT_MEASURED" | "UNAVAILABLE";
  liveInstances: number;
  lastHeartbeatAgeSeconds: number | null;
  reason: string;
};

export type QueueFact = {
  queueName: string;
  waiting: number;
  oldestWaitingAgeMs: number | null;
  /** Dead-letter sinks and disabled/unconfigured queues are not work backlogs. */
  isWorkQueue: boolean;
};

export type BackupFact = {
  newestSucceededAtMs: number | null;
  newestRecord: { outcome: string; atMs: number } | null;
};

export type OutageFacts = {
  nowMs: number;
  /** null: Redis could not be read (the detectors that need it stay silent). */
  bootStartsMs: number[] | null;
  schemaRefusal: SchemaRefusalFact | null;
  fleet: FleetFact | null;
  queues: QueueFact[] | null;
  /** undefined: unreadable; null: no run of these kinds was ever recorded. */
  newestReconciliationRunAtMs: number | null | undefined;
  backups: BackupFact | null;
};

export type OutageSignal = {
  category: AlertCategory;
  severity: "WARNING" | "HIGH" | "CRITICAL";
  title: string;
  summary: string;
  fingerprint: string;
  /** The signal must stay active this long before it is announced (default 0). */
  holdMinutes?: number;
};

const MIN = 60_000;

function minutesAgo(nowMs: number, atMs: number): number {
  return Math.max(0, Math.round((nowMs - atMs) / MIN));
}

// -----------------------------------------------------------------------------
// Detectors (pure)
// -----------------------------------------------------------------------------

export function detectOutageSignals(facts: OutageFacts, config: OutageWatchdogConfig): OutageSignal[] {
  const out: OutageSignal[] = [];
  const now = facts.nowMs;

  const refusal = facts.schemaRefusal;
  if (refusal && now - refusal.atMs <= config.refusalWindowMinutes * MIN) {
    out.push({
      category: "WORKER_SCHEMA_HEAD_REFUSAL",
      severity: "CRITICAL",
      title: "Worker refuses to start: database schema is behind its build",
      summary:
        `A worker (${refusal.workerId}) refused to start ${minutesAgo(now, refusal.atMs)} min ago: ${refusal.kind}, ` +
        `it expects migration ${refusal.expected}. No job is processed until that migration is applied ` +
        `(or the worker is rolled back to the release the database matches).`,
      fingerprint: "worker-schema-head-refusal",
    });
  }

  if (facts.bootStartsMs) {
    const since = now - config.restartWindowMinutes * MIN;
    const starts = facts.bootStartsMs.filter((t) => t >= since && t <= now).length;
    if (starts >= config.restartThreshold) {
      out.push({
        category: "WORKER_RESTART_LOOP",
        severity: "HIGH",
        title: "Worker is restarting repeatedly",
        summary:
          `${starts} worker process starts in the last ${config.restartWindowMinutes} min ` +
          `(threshold ${config.restartThreshold}). Read the worker container's log for the exit reason.`,
        fingerprint: "worker-restart-loop",
      });
    }
  }

  const fleet = facts.fleet;
  if (config.expectedWorkers > 0 && fleet && fleet.state !== "UNAVAILABLE") {
    const below = fleet.liveInstances < config.expectedWorkers;
    const age = fleet.lastHeartbeatAgeSeconds;
    // A fleet below expectation for longer than the grace: its newest heartbeat
    // (any instance) is older than the grace, or none was ever written. A clean
    // STOPPED fleet counts: production expects a running worker.
    const longEnough = age === null || age >= config.workerNotLiveGraceMinutes * 60;
    if (below && (fleet.liveInstances > 0 || longEnough)) {
      out.push({
        category: "WORKER_NOT_LIVE",
        severity: fleet.liveInstances === 0 ? "CRITICAL" : "HIGH",
        title:
          fleet.liveInstances === 0
            ? "No live worker: jobs and scheduled reconciliation are not running"
            : "Fewer live workers than expected",
        summary:
          `${fleet.liveInstances} live worker instance(s), ${config.expectedWorkers} expected; fleet ${fleet.state}` +
          (age === null ? ", no heartbeat recorded" : `, newest heartbeat ${Math.round(age / 60)} min old`) +
          `. ${fleet.reason}`,
        fingerprint: "worker-not-live",
        // A partial fleet has a fresh heartbeat (its live instance), so the
        // grace is applied as a hold instead: a rolling recreate does not alert.
        holdMinutes: fleet.liveInstances > 0 ? config.workerNotLiveGraceMinutes : 0,
      });
    }
  }

  for (const q of facts.queues ?? []) {
    if (!q.isWorkQueue) continue;
    const stalled = q.waiting > 0 && q.oldestWaitingAgeMs !== null && q.oldestWaitingAgeMs >= config.queueStalledMinutes * MIN;
    const backlog = q.waiting > config.queueBacklogCeiling;
    if (!stalled && !backlog) continue;
    out.push({
      category: "QUEUE_BACKLOG_STALLED",
      severity: "HIGH",
      title: `Queue ${q.queueName} is ${stalled ? "stalled" : "backed up"}`,
      summary:
        `${q.waiting} waiting job(s) on ${q.queueName}` +
        (q.oldestWaitingAgeMs !== null ? `, the oldest ${Math.round(q.oldestWaitingAgeMs / MIN)} min old` : "") +
        ` (limits: ${config.queueStalledMinutes} min, ${config.queueBacklogCeiling} jobs).`,
      fingerprint: `queue-backlog:${q.queueName}`.slice(0, 200),
    });
  }

  const newestRun = facts.newestReconciliationRunAtMs;
  if (typeof newestRun === "number" && now - newestRun > config.reconciliationStaleMinutes * MIN) {
    out.push({
      category: "RECONCILIATION_RUNS_MISSING",
      severity: "HIGH",
      title: "Scheduled reconciliation has stopped",
      summary:
        `The newest worker-scheduled reconciliation run started ${minutesAgo(now, newestRun)} min ago ` +
        `(limit ${config.reconciliationStaleMinutes} min). Retention, destruction and integrity sweeps are not running.`,
      fingerprint: "reconciliation-runs-missing",
    });
  }

  const backups = facts.backups;
  if (config.backupExpected && backups) {
    const limit = config.backupStaleHours * 60 * MIN;
    const newestOk = backups.newestSucceededAtMs;
    const lastFailed = backups.newestRecord?.outcome === "FAILED";
    if (newestOk === null || now - newestOk > limit || lastFailed) {
      const parts = [
        newestOk === null
          ? "No successful database backup is recorded"
          : `The newest successful database backup is ${Math.round((now - newestOk) / (60 * MIN))} h old (limit ${config.backupStaleHours} h)`,
      ];
      if (lastFailed) parts.push(`the latest backup run FAILED ${minutesAgo(now, backups.newestRecord!.atMs)} min ago`);
      out.push({
        category: "DATABASE_BACKUP_MISSING",
        severity: "HIGH",
        title: lastFailed ? "Database backup failed" : "No recent database backup",
        summary:
          `${parts.join("; ")}. Check the pg-backup service (compose profile "backup") and its log; ` +
          `set OPS_WATCHDOG_BACKUP_EXPECTED=false only where backups are deliberately elsewhere.`,
        fingerprint: "database-backup-missing",
      });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Dispatch with start / reminder / resolved
// -----------------------------------------------------------------------------

/** lastAlertMs null: seen, still inside its hold, not announced yet. */
export type WatchdogStateEntry = { category: AlertCategory; title: string; firstSeenMs: number; lastAlertMs: number | null };
export type WatchdogState = Record<string, WatchdogStateEntry>;

export type OutageWatchdogDeps = {
  readFacts: () => Promise<OutageFacts>;
  dispatch: (input: AlertInput) => Promise<AlertDispatchResult>;
  loadState: () => Promise<WatchdogState>;
  saveState: (state: WatchdogState) => Promise<void>;
  config?: OutageWatchdogConfig;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void; info: (obj: Record<string, unknown>, msg: string) => void };
};

export type OutageWatchdogSummary = {
  active: string[];
  alerted: string[];
  reminded: string[];
  resolved: string[];
  /** Dispatches that reached no receiver (no provider, or the provider failed). */
  undelivered: number;
};

export async function runOutageWatchdog(deps: OutageWatchdogDeps): Promise<OutageWatchdogSummary> {
  const config = deps.config ?? readOutageWatchdogConfig();
  const facts = await deps.readFacts();
  const signals = detectOutageSignals(facts, config);
  const state = await deps.loadState().catch(() => ({}) as WatchdogState);
  const now = facts.nowMs;
  const summary: OutageWatchdogSummary = { active: [], alerted: [], reminded: [], resolved: [], undelivered: 0 };

  const send = async (input: AlertInput, signalKey: string) => {
    let result: AlertDispatchResult;
    try {
      result = await deps.dispatch(input);
    } catch {
      result = { ok: false, provider: "unknown", reason: "dispatch_threw" };
    }
    if (!result.ok) {
      summary.undelivered += 1;
      deps.logger?.warn(
        { signal: signalKey, category: input.category, severity: input.severity, title: input.title, summary: input.safeSummary, reason: result.reason },
        "ops_watchdog.alert_undelivered",
      );
    }
  };

  const seen = new Set<string>();
  for (const s of signals) {
    seen.add(s.fingerprint);
    summary.active.push(s.fingerprint);
    const prior = state[s.fingerprint];
    const input: AlertInput = {
      category: s.category,
      severity: s.severity,
      title: s.title.slice(0, 180),
      safeSummary: s.summary.slice(0, 400),
      fingerprint: s.fingerprint,
      runbookSlug: "disaster-recovery",
    };
    const entry = prior ?? { category: s.category, title: s.title, firstSeenMs: now, lastAlertMs: null };
    state[s.fingerprint] = entry;
    if (entry.lastAlertMs === null) {
      if (now - entry.firstSeenMs < (s.holdMinutes ?? 0) * MIN) continue;
      await send(input, s.fingerprint);
      entry.lastAlertMs = now;
      summary.alerted.push(s.fingerprint);
    } else if (now - entry.lastAlertMs >= config.reminderMinutes * MIN) {
      await send(
        {
          ...input,
          title: `Still ongoing: ${s.title}`.slice(0, 180),
          safeSummary: `Ongoing for ${minutesAgo(now, entry.firstSeenMs)} min. ${s.summary}`.slice(0, 400),
          fingerprint: `${s.fingerprint}:reminder`.slice(0, 200),
        },
        s.fingerprint,
      );
      entry.lastAlertMs = now;
      summary.reminded.push(s.fingerprint);
    }
  }

  for (const [fingerprint, entry] of Object.entries(state)) {
    if (seen.has(fingerprint)) continue;
    delete state[fingerprint];
    // Never announced (it cleared inside its hold): nothing to resolve.
    if (entry.lastAlertMs === null) continue;
    await send(
      {
        category: entry.category,
        severity: "INFO",
        title: `Resolved: ${entry.title}`.slice(0, 180),
        safeSummary: `Cleared after ${minutesAgo(now, entry.firstSeenMs)} min.`,
        fingerprint: `${fingerprint}:resolved`.slice(0, 200),
        runbookSlug: "disaster-recovery",
      },
      fingerprint,
    );
    summary.resolved.push(fingerprint);
  }

  await deps.saveState(state).catch(() => undefined);
  if (summary.active.length > 0 || summary.resolved.length > 0) {
    deps.logger?.info({ ...summary }, "ops_watchdog.evaluated");
  }
  return summary;
}

// -----------------------------------------------------------------------------
// Default wiring
// -----------------------------------------------------------------------------

/** The governance_reconciliation_runs kinds the WORKER schedules. */
export const WORKER_SCHEDULED_RECONCILIATION_KINDS = [
  "RETENTION",
  "DESTRUCTION_SWEEP",
  "IMMUTABLE_STORAGE",
  "INTEGRITY_RECHECK",
  "CAPTURE_REAPER",
  "ARCHIVE_RESTORE",
] as const;

export const OUTAGE_WATCHDOG_STATE_KEY = "ops:watchdog:state";

/** The narrow Redis surface the default wiring uses. */
export type WatchdogRedis = {
  zrangebyscore(key: string, min: number | string, max: number | string, ...args: string[]): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
};

export function parseBootStarts(members: string[]): number[] {
  const out: number[] = [];
  for (const m of members) {
    const at = Number(m.split("|").pop());
    if (Number.isFinite(at)) out.push(at);
  }
  return out;
}

export function parseSchemaRefusal(raw: string | null): SchemaRefusalFact | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SchemaRefusalFact>;
    if (typeof v.kind !== "string" || typeof v.expected !== "string" || typeof v.atMs !== "number") return null;
    return { kind: v.kind, expected: v.expected, workerId: typeof v.workerId === "string" ? v.workerId : "unknown", atMs: v.atMs };
  } catch {
    return null;
  }
}

type WatchdogPrisma = {
  governanceReconciliationRun: {
    findFirst(args: unknown): Promise<{ startedAtUtc: Date } | null>;
  };
  platformBackupRecord: {
    findFirst(args: unknown): Promise<{ outcome: string; recordedAtUtc: Date } | null>;
  };
};

export async function readOutageFacts(input: {
  prisma: WatchdogPrisma;
  redis: WatchdogRedis | null;
  readFleet: () => Promise<FleetFact>;
  readQueues: () => Promise<QueueFact[]>;
  config: OutageWatchdogConfig;
  nowMs?: number;
}): Promise<OutageFacts> {
  const nowMs = input.nowMs ?? Date.now();
  const settle = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch {
      return null;
    }
  };
  const redis = input.redis;
  const [bootStartsMs, schemaRefusal, fleet, queues, run, backups] = await Promise.all([
    redis
      ? settle(async () =>
          parseBootStarts(
            await redis.zrangebyscore(OPS_WORKER_BOOT_EVENTS_KEY, nowMs - input.config.restartWindowMinutes * MIN, "+inf"),
          ),
        )
      : Promise.resolve(null),
    redis ? settle(async () => parseSchemaRefusal(await redis.get(OPS_WORKER_SCHEMA_REFUSAL_KEY))) : Promise.resolve(null),
    settle(input.readFleet),
    settle(input.readQueues),
    (async (): Promise<number | null | undefined> => {
      try {
        const row = await input.prisma.governanceReconciliationRun.findFirst({
          where: { kind: { in: [...WORKER_SCHEDULED_RECONCILIATION_KINDS] } },
          orderBy: { startedAtUtc: "desc" },
          select: { startedAtUtc: true },
        });
        return row ? row.startedAtUtc.getTime() : null;
      } catch {
        return undefined;
      }
    })(),
    settle(async (): Promise<BackupFact> => {
      const [ok, newest] = await Promise.all([
        input.prisma.platformBackupRecord.findFirst({
          where: { kind: "DATABASE_BACKUP", outcome: "SUCCEEDED" },
          orderBy: { recordedAtUtc: "desc" },
          select: { outcome: true, recordedAtUtc: true },
        }),
        input.prisma.platformBackupRecord.findFirst({
          where: { kind: "DATABASE_BACKUP" },
          orderBy: { recordedAtUtc: "desc" },
          select: { outcome: true, recordedAtUtc: true },
        }),
      ]);
      return {
        newestSucceededAtMs: ok ? ok.recordedAtUtc.getTime() : null,
        newestRecord: newest ? { outcome: newest.outcome, atMs: newest.recordedAtUtc.getTime() } : null,
      };
    }),
  ]);
  return {
    nowMs,
    bootStartsMs,
    schemaRefusal,
    fleet,
    queues,
    newestReconciliationRunAtMs: run,
    backups,
  };
}

/** Redis-backed watchdog state with an in-process fallback. */
export function redisWatchdogState(redis: WatchdogRedis | null): Pick<OutageWatchdogDeps, "loadState" | "saveState"> {
  let memory: WatchdogState = {};
  return {
    loadState: async () => {
      if (!redis) return memory;
      try {
        const raw = await redis.get(OUTAGE_WATCHDOG_STATE_KEY);
        return raw ? (JSON.parse(raw) as WatchdogState) : {};
      } catch {
        return memory;
      }
    },
    saveState: async (state) => {
      memory = state;
      if (!redis) return;
      try {
        await redis.set(OUTAGE_WATCHDOG_STATE_KEY, JSON.stringify(state), "EX", 7 * 24 * 3600);
      } catch {
        /* the in-process copy stands */
      }
    },
  };
}
