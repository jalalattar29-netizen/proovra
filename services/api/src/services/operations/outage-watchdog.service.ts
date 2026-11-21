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
 *                                within the window, or the newest one FAILED;
 *   BACKUP_OFFHOST_COPY_MISSING  the same, for OFFHOST_COPY rows;
 *   RESTORE_DRILL_MISSING        the same, for RESTORE_DRILL rows;
 *   HOST_DISK_LOW                statfs of the filesystem(s) the API sees (its
 *                                container root is on the Docker data disk);
 *   MONITORING_SOURCE_UNREADABLE one of the sources above could not be read for
 *                                longer than a hold: unreadable is not healthy.
 *
 * Signals go through the existing alert path (`dispatchOpsAlert`, provider
 * resolution webhook > noop). A signal alerts when it starts, reminds while it
 * lasts (default hourly, not every tick), and sends one "resolved" notice when
 * it clears. That state is kept in Redis so a replica taking over the lease
 * does not re-announce an ongoing outage. A start, reminder or resolved notice
 * the receiver did not accept is retried on the next tick (a resolved notice up
 * to RESOLVE_RETRY_LIMIT times), so a transient receiver failure loses nothing
 * and a recovery is announced exactly once.
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
  /** Whether off-host copies are expected (pg-backup-offhost); only with backupExpected. */
  offhostExpected: boolean;
  /** No successful OFFHOST_COPY record within this many hours alerts. */
  offhostStaleHours: number;
  /** Whether scheduled restore drills are expected; only with backupExpected. */
  drillExpected: boolean;
  /** No successful RESTORE_DRILL record within this many hours alerts. */
  drillStaleHours: number;
  /** Filesystems to measure (statfs); empty switches the disk detector off. */
  diskPaths: string[];
  /** A filesystem more used than this (percent, as df computes it) alerts. */
  diskMaxUsedPercent: number;
  /** A filesystem with less free space than this (MiB) alerts. */
  diskMinFreeMb: number;
  /** A monitoring source unreadable for this long alerts (0: on the first tick). */
  unreadableHoldMinutes: number;
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
  // The off-host copy runs hourly; the cycle (every 6 h) records each new
  // result once, so a healthy record is at most ~7 h old. A day plus two hours.
  offhostExpected: true,
  offhostStaleHours: 26,
  // The drill runs weekly (BACKUP_DRILL_EVERY_SECONDS); a week plus a day.
  drillExpected: true,
  drillStaleHours: 8 * 24,
  diskPaths: ["/"],
  diskMaxUsedPercent: 85,
  // A dump is ~1.07 GB and the drill needs ~3.5 GB of scratch on the same disk.
  diskMinFreeMb: 4096,
  // Two sweep ticks: one failed read is a blip, two are blindness.
  unreadableHoldMinutes: 10,
  reminderMinutes: 60,
});

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Comma-separated absolute paths; "off" switches the disk detector off. */
function readDiskPaths(raw: string | undefined, fallback: string[]): string[] {
  const v = (raw ?? "").trim();
  if (v === "") return [...fallback];
  if (v.toLowerCase() === "off") return [];
  const paths = v.split(",").map((p) => p.trim()).filter((p) => p.startsWith("/") && p.length <= 200);
  return paths.length > 0 ? paths.slice(0, 8) : [...fallback];
}

/** Bounded: an unusable value falls back to the default, never to "off". */
export function readOutageWatchdogConfig(env: NodeJS.ProcessEnv = process.env): OutageWatchdogConfig {
  const d = OUTAGE_WATCHDOG_DEFAULTS;
  return {
    restartThreshold: intEnv(env, "OPS_WATCHDOG_RESTART_THRESHOLD", d.restartThreshold, 2, 1000),
    restartWindowMinutes: intEnv(env, "OPS_WATCHDOG_RESTART_WINDOW_MINUTES", d.restartWindowMinutes, 5, 1440),
    refusalWindowMinutes: intEnv(env, "OPS_WATCHDOG_REFUSAL_WINDOW_MINUTES", d.refusalWindowMinutes, 5, 1440),
    // Unset: the deployment's own replica count (WORKER_REPLICAS, which the
    // API reads from the same env file the compose file interpolates).
    expectedWorkers: intEnv(
      env,
      "OPS_WATCHDOG_EXPECTED_WORKERS",
      intEnv(env, "WORKER_REPLICAS", d.expectedWorkers, 0, 64),
      0,
      64,
    ),
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
    offhostExpected: (env.OPS_WATCHDOG_OFFHOST_EXPECTED ?? "").trim().toLowerCase() !== "false",
    offhostStaleHours: intEnv(env, "OPS_WATCHDOG_OFFHOST_STALE_HOURS", d.offhostStaleHours, 1, 24 * 14),
    drillExpected: (env.OPS_WATCHDOG_DRILL_EXPECTED ?? "").trim().toLowerCase() !== "false",
    drillStaleHours: intEnv(env, "OPS_WATCHDOG_DRILL_STALE_HOURS", d.drillStaleHours, 1, 24 * 60),
    diskPaths: readDiskPaths(env.OPS_WATCHDOG_DISK_PATHS, d.diskPaths),
    diskMaxUsedPercent: intEnv(env, "OPS_WATCHDOG_DISK_MAX_USED_PERCENT", d.diskMaxUsedPercent, 50, 99),
    diskMinFreeMb: intEnv(env, "OPS_WATCHDOG_DISK_MIN_FREE_MB", d.diskMinFreeMb, 0, 10_000_000),
    unreadableHoldMinutes: intEnv(env, "OPS_WATCHDOG_UNREADABLE_HOLD_MINUTES", d.unreadableHoldMinutes, 0, 1440),
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
  /**
   * false: this queue could not be probed this tick (Redis refused, or the
   * inventory budget ran out); its counts are not a measurement. Default true.
   */
  readable?: boolean;
};

/** One process start the worker recorded about itself. */
export type BootFact = { workerId: string; atMs: number };

/** The newest success and the newest record of ONE platform_backup_records kind. */
export type BackupKindFact = {
  newestSucceededAtMs: number | null;
  newestRecord: { outcome: string; atMs: number } | null;
};

/**
 * DATABASE_BACKUP at the top level; `offhost` (OFFHOST_COPY) and `drill`
 * (RESTORE_DRILL) beside it. A kind left undefined was not read: its detector
 * is silent and an ongoing alert from it is carried, never resolved.
 */
export type BackupFact = BackupKindFact & {
  offhost?: BackupKindFact;
  drill?: BackupKindFact;
};

/** One measured filesystem. */
export type DiskFact = { path: string; totalBytes: number; freeBytes: number; usedPercent: number };

export type OutageFacts = {
  nowMs: number;
  /** null: Redis could not be read (the detectors that need it stay silent). */
  boots: BootFact[] | null;
  schemaRefusal: SchemaRefusalFact | null;
  /** false: the refusal record could not be read (default: readable when boots were). */
  schemaRefusalReadable?: boolean;
  fleet: FleetFact | null;
  queues: QueueFact[] | null;
  /** undefined: unreadable; null: no run of these kinds was ever recorded. */
  newestReconciliationRunAtMs: number | null | undefined;
  backups: BackupFact | null;
  /** undefined: not measured (no disk detector wired); null: statfs failed (unreadable). */
  disk?: DiskFact[] | null;
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

  if (facts.boots) {
    // Counted PER WORKER IDENTITY: a deploy of N replicas starts N new
    // identities once each and is not a loop; a container that keeps exiting
    // restarts under the same identity (its hostname survives a restart).
    const since = now - config.restartWindowMinutes * MIN;
    const perWorker = new Map<string, number>();
    for (const b of facts.boots) {
      if (b.atMs >= since && b.atMs <= now) perWorker.set(b.workerId, (perWorker.get(b.workerId) ?? 0) + 1);
    }
    let starts = 0;
    let loopingWorker = "";
    for (const [id, n] of perWorker) if (n > starts) { starts = n; loopingWorker = id; }
    if (starts >= config.restartThreshold) {
      out.push({
        category: "WORKER_RESTART_LOOP",
        severity: "HIGH",
        title: "Worker is restarting repeatedly",
        summary:
          `${starts} process starts of worker ${loopingWorker} in the last ${config.restartWindowMinutes} min ` +
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
    if (!q.isWorkQueue || q.readable === false) continue;
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

  // The off-host copy and the restore drill: the same two questions (newest
  // run FAILED? newest success too old or absent?) of their own rows.
  const kindSignal = (
    fact: BackupKindFact | undefined,
    staleHours: number,
    what: { category: AlertCategory; fingerprint: string; noun: string; failedTitle: string; staleTitle: string; hint: string },
  ) => {
    if (!fact) return;
    const limit = staleHours * 60 * MIN;
    const newestOk = fact.newestSucceededAtMs;
    const lastFailed = fact.newestRecord?.outcome === "FAILED";
    if (newestOk !== null && now - newestOk <= limit && !lastFailed) return;
    const parts = [
      newestOk === null
        ? `No successful ${what.noun} is recorded`
        : `The newest successful ${what.noun} is ${Math.round((now - newestOk) / (60 * MIN))} h old (limit ${staleHours} h)`,
    ];
    if (lastFailed) parts.push(`the latest ${what.noun} FAILED ${minutesAgo(now, fact.newestRecord!.atMs)} min ago`);
    out.push({
      category: what.category,
      severity: "HIGH",
      title: lastFailed ? what.failedTitle : what.staleTitle,
      summary: `${parts.join("; ")}. ${what.hint}`,
      fingerprint: what.fingerprint,
    });
  };
  if (config.backupExpected && backups) {
    if (config.offhostExpected) {
      kindSignal(backups.offhost, config.offhostStaleHours, {
        category: "BACKUP_OFFHOST_COPY_MISSING",
        fingerprint: "backup-offhost-copy-missing",
        noun: "off-host backup copy",
        failedTitle: "Off-host backup copy failed",
        staleTitle: "No recent off-host backup copy",
        hint:
          "Backups exist only on the production host. Check the pg-backup-offhost service log and BACKUP_S3_URI / " +
          "BACKUP_AWS_* in the env file; set OPS_WATCHDOG_OFFHOST_EXPECTED=false only where copies are deliberately elsewhere.",
      });
    }
    if (config.drillExpected) {
      kindSignal(backups.drill, config.drillStaleHours, {
        category: "RESTORE_DRILL_MISSING",
        fingerprint: "restore-drill-missing",
        noun: "restore drill",
        failedTitle: "Backup restore drill failed",
        staleTitle: "No recent backup restore drill",
        hint:
          "No recent backup is proven to restore. Read the pg-backup service log for the drill's FAILED line " +
          "(disk space, checksum, counts or schema).",
      });
    }
  }

  for (const d of facts.disk ?? []) {
    const freeMb = Math.floor(d.freeBytes / (1024 * 1024));
    const overPercent = d.usedPercent > config.diskMaxUsedPercent;
    const underFree = freeMb < config.diskMinFreeMb;
    if (!overPercent && !underFree) continue;
    out.push({
      category: "HOST_DISK_LOW",
      severity: d.usedPercent >= 95 || freeMb < 1024 ? "CRITICAL" : "HIGH",
      title: `Disk almost full: ${d.path}`,
      summary:
        `${d.path} is ${d.usedPercent}% used with ${(freeMb / 1024).toFixed(1)} GB free ` +
        `(limits: ${config.diskMaxUsedPercent}% used, ${config.diskMinFreeMb} MB free). ` +
        `Backups refuse to run, and the database dump and drill need several GB, when the disk is short.`,
      fingerprint: `disk-low:${d.path}`.slice(0, 200),
    });
  }

  // Unreadable is not healthy: a source the watchdog could not read for longer
  // than the hold is itself an alert (the detectors that need it are blind).
  for (const source of unreadableSources(facts, config)) {
    out.push({
      category: "MONITORING_SOURCE_UNREADABLE",
      severity: "HIGH",
      title: `Outage watchdog cannot read ${source.label}`,
      summary:
        `The watchdog could not read ${source.label} (${source.detail}). The detectors that depend on it are blind: ` +
        `an unreadable source is not reported healthy, and alerts already open from it stay open until it is read again.`,
      fingerprint: `source-unreadable:${source.name}`,
      holdMinutes: config.unreadableHoldMinutes,
    });
  }

  return out;
}

/** The sources this tick could not read, among those a detector is configured to use. */
export function unreadableSources(
  facts: OutageFacts,
  config: OutageWatchdogConfig,
): Array<{ name: string; label: string; detail: string }> {
  const out: Array<{ name: string; label: string; detail: string }> = [];
  if (facts.boots === null || facts.schemaRefusalReadable === false) {
    out.push({ name: "redis", label: "the worker's boot and schema-refusal records", detail: "Redis read failed" });
  }
  if (config.expectedWorkers > 0 && (facts.fleet === null || facts.fleet.state === "UNAVAILABLE")) {
    out.push({ name: "worker-leases", label: "the worker leases", detail: facts.fleet?.reason ?? "database read failed" });
  }
  if (facts.queues === null || facts.queues.some((q) => q.isWorkQueue && q.readable === false)) {
    const names = (facts.queues ?? []).filter((q) => q.isWorkQueue && q.readable === false).map((q) => q.queueName);
    out.push({
      name: "queues",
      label: "the job queues",
      detail: names.length > 0 ? `not probed: ${names.slice(0, 5).join(", ")}` : "queue inventory failed",
    });
  }
  if (facts.newestReconciliationRunAtMs === undefined) {
    out.push({ name: "reconciliation-runs", label: "the reconciliation run records", detail: "database read failed" });
  }
  if (config.backupExpected && facts.backups === null) {
    out.push({ name: "backup-records", label: "the backup records", detail: "database read failed" });
  }
  if (config.diskPaths.length > 0 && facts.disk === null) {
    out.push({ name: "disk", label: "the disk usage", detail: "statfs failed" });
  }
  return out;
}

/**
 * Whether THIS tick read the source a signal comes from. A signal that is not
 * raised because its source could not be read is not "cleared": resolving it
 * then would flap (Resolved, then a fresh start alert on the next good read).
 */
export function signalSourceReadable(facts: OutageFacts, category: AlertCategory, fingerprint: string): boolean {
  switch (category) {
    case "WORKER_SCHEMA_HEAD_REFUSAL":
      return facts.schemaRefusalReadable ?? facts.boots !== null;
    case "WORKER_RESTART_LOOP":
      return facts.boots !== null;
    case "WORKER_NOT_LIVE":
      return facts.fleet !== null && facts.fleet.state !== "UNAVAILABLE";
    case "QUEUE_BACKLOG_STALLED": {
      if (facts.queues === null) return false;
      const name = fingerprint.startsWith("queue-backlog:") ? fingerprint.slice("queue-backlog:".length) : "";
      const q = facts.queues.find((x) => x.queueName === name);
      // A queue no longer listed was measured as absent; one listed unreadable was not measured.
      return q ? q.readable !== false : true;
    }
    case "RECONCILIATION_RUNS_MISSING":
      return facts.newestReconciliationRunAtMs !== undefined;
    case "DATABASE_BACKUP_MISSING":
      return facts.backups !== null;
    case "BACKUP_OFFHOST_COPY_MISSING":
      return facts.backups !== null && facts.backups.offhost !== undefined;
    case "RESTORE_DRILL_MISSING":
      return facts.backups !== null && facts.backups.drill !== undefined;
    case "HOST_DISK_LOW": {
      if (facts.disk === undefined || facts.disk === null) return false;
      const path = fingerprint.startsWith("disk-low:") ? fingerprint.slice("disk-low:".length) : "";
      // A path no longer measured is not "cleared": nothing was read for it.
      return facts.disk.some((d) => d.path === path);
    }
    // Computed from this tick's own facts: always a measurement.
    case "MONITORING_SOURCE_UNREADABLE":
      return true;
    default:
      return true;
  }
}

// -----------------------------------------------------------------------------
// Dispatch with start / reminder / resolved
// -----------------------------------------------------------------------------

/**
 * lastAlertMs null: seen, not announced yet (inside its hold, or the start
 * notice was not accepted and is retried next tick). resolveAttempts: the
 * signal cleared after it was announced, and that many resolved notices were
 * not accepted; the next tick retries.
 */
export type WatchdogStateEntry = {
  category: AlertCategory;
  title: string;
  firstSeenMs: number;
  lastAlertMs: number | null;
  resolveAttempts?: number;
};

/** A resolved notice the receiver keeps refusing is given up after this many ticks (logged). */
export const RESOLVE_RETRY_LIMIT = 12;
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
  /** Ongoing signals whose source could not be read this tick (kept, not resolved). */
  carried: string[];
  /** Dispatches that reached no receiver (no provider, or the provider failed). */
  undelivered: number;
};

export async function runOutageWatchdog(deps: OutageWatchdogDeps): Promise<OutageWatchdogSummary> {
  const config = deps.config ?? readOutageWatchdogConfig();
  const facts = await deps.readFacts();
  const signals = detectOutageSignals(facts, config);
  const state = await deps.loadState().catch(() => ({}) as WatchdogState);
  const now = facts.nowMs;
  const summary: OutageWatchdogSummary = { active: [], alerted: [], reminded: [], resolved: [], carried: [], undelivered: 0 };

  /** true when the receiver accepted it. */
  const send = async (input: AlertInput, signalKey: string): Promise<boolean> => {
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
    return result.ok;
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
    const entry: WatchdogStateEntry = prior ?? { category: s.category, title: s.title, firstSeenMs: now, lastAlertMs: null };
    state[s.fingerprint] = entry;
    // Back before its resolved notice was accepted: the receiver never heard it
    // clear, so it is simply still ongoing (no second start notice).
    delete entry.resolveAttempts;
    if (entry.lastAlertMs === null) {
      if (now - entry.firstSeenMs < (s.holdMinutes ?? 0) * MIN) continue;
      // Not accepted: stays unannounced and is retried on the next tick.
      if (await send(input, s.fingerprint)) entry.lastAlertMs = now;
      summary.alerted.push(s.fingerprint);
    } else if (now - entry.lastAlertMs >= config.reminderMinutes * MIN) {
      const delivered = await send(
        {
          ...input,
          title: `Still ongoing: ${s.title}`.slice(0, 180),
          safeSummary: `Ongoing for ${minutesAgo(now, entry.firstSeenMs)} min. ${s.summary}`.slice(0, 400),
          fingerprint: `${s.fingerprint}:reminder`.slice(0, 200),
        },
        s.fingerprint,
      );
      if (delivered) entry.lastAlertMs = now;
      summary.reminded.push(s.fingerprint);
    }
  }

  for (const [fingerprint, entry] of Object.entries(state)) {
    if (seen.has(fingerprint)) continue;
    // Unreadable this tick: carried forward untouched, neither resolved nor re-announced.
    if (!signalSourceReadable(facts, entry.category, fingerprint)) {
      summary.carried.push(fingerprint);
      continue;
    }
    // Never announced (it cleared inside its hold, or its start notice was
    // never accepted): nothing to resolve.
    if (entry.lastAlertMs === null) {
      delete state[fingerprint];
      continue;
    }
    const delivered = await send(
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
    if (delivered) {
      delete state[fingerprint];
      summary.resolved.push(fingerprint);
      continue;
    }
    // Not accepted: kept, and retried next tick, so the recovery is announced
    // once it can be; given up (logged) after RESOLVE_RETRY_LIMIT ticks.
    entry.resolveAttempts = (entry.resolveAttempts ?? 0) + 1;
    if (entry.resolveAttempts >= RESOLVE_RETRY_LIMIT) {
      delete state[fingerprint];
      deps.logger?.warn({ signal: fingerprint, attempts: entry.resolveAttempts }, "ops_watchdog.resolve_abandoned");
    }
  }

  await deps.saveState(state).catch(() => undefined);
  if (summary.active.length > 0 || summary.resolved.length > 0 || summary.carried.length > 0) {
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

/** Members are "<workerId>|<pid>|<epoch ms>" (services/worker/src/boot-signal.ts). */
export function parseBoots(members: string[]): BootFact[] {
  const out: BootFact[] = [];
  for (const m of members) {
    const parts = m.split("|");
    const at = Number(parts[parts.length - 1]);
    if (parts.length >= 3 && Number.isFinite(at)) out.push({ workerId: parts.slice(0, -2).join("|"), atMs: at });
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
  /** Absent: the disk is not measured (facts.disk undefined). */
  readDisk?: () => Promise<DiskFact[]>;
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
  let schemaRefusalReadable = redis !== null;
  const [boots, schemaRefusal, fleet, queues, run, backups] = await Promise.all([
    redis
      ? settle(async () =>
          parseBoots(
            await redis.zrangebyscore(OPS_WORKER_BOOT_EVENTS_KEY, nowMs - input.config.restartWindowMinutes * MIN, "+inf"),
          ),
        )
      : Promise.resolve(null),
    redis
      ? (async () => {
          try {
            return parseSchemaRefusal(await redis.get(OPS_WORKER_SCHEMA_REFUSAL_KEY));
          } catch {
            schemaRefusalReadable = false;
            return null;
          }
        })()
      : Promise.resolve(null),
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
      const readKind = async (kind: "DATABASE_BACKUP" | "OFFHOST_COPY" | "RESTORE_DRILL"): Promise<BackupKindFact> => {
        const [ok, newest] = await Promise.all([
          input.prisma.platformBackupRecord.findFirst({
            where: { kind, outcome: "SUCCEEDED" },
            orderBy: { recordedAtUtc: "desc" },
            select: { outcome: true, recordedAtUtc: true },
          }),
          input.prisma.platformBackupRecord.findFirst({
            where: { kind },
            orderBy: { recordedAtUtc: "desc" },
            select: { outcome: true, recordedAtUtc: true },
          }),
        ]);
        return {
          newestSucceededAtMs: ok ? ok.recordedAtUtc.getTime() : null,
          newestRecord: newest ? { outcome: newest.outcome, atMs: newest.recordedAtUtc.getTime() } : null,
        };
      };
      // One read: all three kinds, or none (null, unreadable).
      const [database, offhost, drill] = await Promise.all([
        readKind("DATABASE_BACKUP"),
        readKind("OFFHOST_COPY"),
        readKind("RESTORE_DRILL"),
      ]);
      return { ...database, offhost, drill };
    }),
  ]);
  let disk: DiskFact[] | null | undefined;
  if (input.readDisk && input.config.diskPaths.length > 0) {
    disk = await settle(input.readDisk);
  }
  return {
    nowMs,
    boots,
    schemaRefusal,
    schemaRefusalReadable,
    fleet,
    queues,
    newestReconciliationRunAtMs: run,
    backups,
    ...(disk !== undefined ? { disk } : {}),
  };
}

/**
 * statfs of each path, as `df` computes it: used = blocks - bfree, and the
 * percentage is used / (used + bavail). Any failure fails the whole read
 * (readOutageFacts then reports the disk unreadable, never healthy).
 */
export async function readDiskUsage(
  paths: string[],
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>,
): Promise<DiskFact[]> {
  const out: DiskFact[] = [];
  for (const path of paths) {
    const s = await statfs(path);
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    if (!(s.blocks > 0) || used + avail <= 0) throw new Error("statfs returned no blocks");
    out.push({
      path,
      totalBytes: s.blocks * s.bsize,
      freeBytes: avail,
      usedPercent: Math.ceil((used * 100) / (used + avail)),
    });
  }
  return out;
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
