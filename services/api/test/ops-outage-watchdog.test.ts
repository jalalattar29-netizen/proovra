/**
 * OPS closure (2026-11-21) — the outage watchdog.
 *
 * Production: the worker crash-looped ~25 h (306 restarts) refusing to start
 * because the database schema head was behind its build (HEAD_NOT_APPLIED);
 * scheduled reconciliation stopped ~25.7 h; no backups were running; nothing
 * alerted (dispatchOpsAlert had no caller). These tests replay that state
 * through the real detectors, the real dispatch logic and the real sweep step,
 * with a fake alert provider (the only real transport is an external webhook).
 */
import { afterEach, describe, expect, it } from "vitest";

import { OPS_WORKER_BOOT_EVENTS_KEY, OPS_WORKER_SCHEMA_REFUSAL_KEY } from "@proovra/shared";

import {
  dispatchOpsAlert,
  setAlertProviderForTests,
} from "../src/services/alerts/alert.service.js";
import type { AlertInput, AlertProvider } from "../src/services/alerts/provider.js";
import {
  OUTAGE_WATCHDOG_DEFAULTS,
  OUTAGE_WATCHDOG_STATE_KEY,
  detectOutageSignals,
  readOutageFacts,
  readOutageWatchdogConfig,
  redisWatchdogState,
  runOutageWatchdog,
  type OutageFacts,
  type WatchdogRedis,
} from "../src/services/operations/outage-watchdog.service.js";
import {
  OUTAGE_WATCHDOG_LEASE_KEY,
  runPlatformMaintenanceSweep,
} from "../src/jobs/platform-maintenance-reconciliation.job.js";

const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const HEAD = "20281122000000_derived_asset_storage_reservation";

/** The production state on 2026-11-21, ~25 h into the outage. */
function outageFacts(nowMs = NOW): OutageFacts {
  return {
    nowMs,
    // a refusing worker restarts about every 5 minutes
    bootStartsMs: Array.from({ length: 12 }, (_, i) => nowMs - i * 5 * MIN),
    schemaRefusal: { kind: "HEAD_NOT_APPLIED", expected: HEAD, workerId: "abc123-1", atMs: nowMs - 2 * MIN },
    // the previous instance had shut down cleanly: STOPPED, "nothing indicates a fault"
    fleet: { state: "STOPPED", liveInstances: 0, lastHeartbeatAgeSeconds: 25 * 3600, reason: "Every instance recorded a clean shutdown." },
    queues: [
      { queueName: "report-generation", waiting: 37, oldestWaitingAgeMs: 3 * H, isWorkQueue: true },
      { queueName: "report-dlq", waiting: 5000, oldestWaitingAgeMs: 90 * H, isWorkQueue: false },
    ],
    newestReconciliationRunAtMs: nowMs - Math.round(25.7 * H),
    backups: { newestSucceededAtMs: null, newestRecord: null },
  };
}

/** Everything healthy. */
function healthyFacts(nowMs = NOW): OutageFacts {
  return {
    nowMs,
    bootStartsMs: [nowMs - 3 * H],
    schemaRefusal: null,
    fleet: { state: "HEALTHY", liveInstances: 1, lastHeartbeatAgeSeconds: 20, reason: "1 live" },
    queues: [{ queueName: "report-generation", waiting: 2, oldestWaitingAgeMs: 40_000, isWorkQueue: true }],
    newestReconciliationRunAtMs: nowMs - 4 * MIN,
    backups: { newestSucceededAtMs: nowMs - 2 * H, newestRecord: { outcome: "SUCCEEDED", atMs: nowMs - 2 * H } },
  };
}

const cfg = { ...OUTAGE_WATCHDOG_DEFAULTS };

describe("detectors", () => {
  it("the production outage raises every detector, each saying why", () => {
    const signals = detectOutageSignals(outageFacts(), cfg);
    const byCat = new Map(signals.map((s) => [s.category, s]));
    expect([...byCat.keys()].sort()).toEqual(
      [
        "DATABASE_BACKUP_MISSING",
        "QUEUE_BACKLOG_STALLED",
        "RECONCILIATION_RUNS_MISSING",
        "WORKER_NOT_LIVE",
        "WORKER_RESTART_LOOP",
        "WORKER_SCHEMA_HEAD_REFUSAL",
      ].sort(),
    );
    expect(byCat.get("WORKER_SCHEMA_HEAD_REFUSAL")!.severity).toBe("CRITICAL");
    expect(byCat.get("WORKER_SCHEMA_HEAD_REFUSAL")!.summary).toContain(`HEAD_NOT_APPLIED, it expects migration ${HEAD}`);
    expect(byCat.get("WORKER_RESTART_LOOP")!.summary).toMatch(/^12 worker process starts in the last 60 min/);
    expect(byCat.get("WORKER_NOT_LIVE")!.severity).toBe("CRITICAL");
    expect(byCat.get("WORKER_NOT_LIVE")!.summary).toMatch(/0 live worker instance\(s\), 1 expected; fleet STOPPED/);
    expect(byCat.get("RECONCILIATION_RUNS_MISSING")!.summary).toMatch(/started 1542 min ago/);
    expect(byCat.get("DATABASE_BACKUP_MISSING")!.summary).toMatch(/^No successful database backup is recorded/);
    // only the work queue; the dead-letter sink's retained history is not a backlog
    expect(signals.filter((s) => s.category === "QUEUE_BACKLOG_STALLED").map((s) => s.fingerprint)).toEqual([
      "queue-backlog:report-generation",
    ]);
  });

  it("a healthy platform raises nothing", () => {
    expect(detectOutageSignals(healthyFacts(), cfg)).toEqual([]);
  });

  it("thresholds: just inside each limit is quiet, just past it alerts", () => {
    const quiet = healthyFacts();
    quiet.bootStartsMs = [NOW - 1 * MIN, NOW - 10 * MIN, NOW - 59 * MIN]; // 3 < 4
    quiet.schemaRefusal = { kind: "HEAD_NOT_APPLIED", expected: HEAD, workerId: "w", atMs: NOW - 31 * MIN }; // stale
    quiet.queues = [{ queueName: "q", waiting: 1000, oldestWaitingAgeMs: 29 * MIN, isWorkQueue: true }];
    quiet.newestReconciliationRunAtMs = NOW - 60 * MIN;
    quiet.backups = { newestSucceededAtMs: NOW - 13 * H, newestRecord: { outcome: "SUCCEEDED", atMs: NOW - 13 * H } };
    expect(detectOutageSignals(quiet, cfg)).toEqual([]);

    const loud = healthyFacts();
    loud.bootStartsMs = [NOW - 1 * MIN, NOW - 10 * MIN, NOW - 30 * MIN, NOW - 59 * MIN];
    loud.schemaRefusal = { kind: "HEAD_FAILED", expected: HEAD, workerId: "w", atMs: NOW - 29 * MIN };
    loud.queues = [
      { queueName: "stalled", waiting: 1, oldestWaitingAgeMs: 30 * MIN, isWorkQueue: true },
      { queueName: "backed-up", waiting: 1001, oldestWaitingAgeMs: 60_000, isWorkQueue: true },
    ];
    loud.newestReconciliationRunAtMs = NOW - 61 * MIN;
    loud.backups = { newestSucceededAtMs: NOW - 14 * H, newestRecord: { outcome: "SUCCEEDED", atMs: NOW - 14 * H } };
    expect(detectOutageSignals(loud, cfg).map((s) => s.fingerprint).sort()).toEqual(
      [
        "database-backup-missing",
        "queue-backlog:backed-up",
        "queue-backlog:stalled",
        "reconciliation-runs-missing",
        "worker-restart-loop",
        "worker-schema-head-refusal",
      ].sort(),
    );
  });

  it("a backup whose newest run FAILED alerts even when an older one succeeded", () => {
    const f = healthyFacts();
    f.backups = { newestSucceededAtMs: NOW - 7 * H, newestRecord: { outcome: "FAILED", atMs: NOW - 1 * H } };
    const [s] = detectOutageSignals(f, cfg);
    expect(s!.title).toBe("Database backup failed");
    expect(s!.summary).toMatch(/the latest backup run FAILED 60 min ago/);
  });

  it("a worker fleet that stopped cleanly is NOT live; inside the grace it is quiet", () => {
    const f = healthyFacts();
    f.fleet = { state: "STOPPED", liveInstances: 0, lastHeartbeatAgeSeconds: 9 * 60, reason: "clean" };
    expect(detectOutageSignals(f, cfg)).toEqual([]);
    f.fleet = { state: "STOPPED", liveInstances: 0, lastHeartbeatAgeSeconds: 10 * 60, reason: "clean" };
    expect(detectOutageSignals(f, cfg).map((s) => s.category)).toEqual(["WORKER_NOT_LIVE"]);
    f.fleet = { state: "NOT_MEASURED", liveInstances: 0, lastHeartbeatAgeSeconds: null, reason: "none" };
    expect(detectOutageSignals(f, cfg).map((s) => s.category)).toEqual(["WORKER_NOT_LIVE"]);
  });

  it("unreadable sources raise nothing rather than a guess", () => {
    const f: OutageFacts = {
      nowMs: NOW,
      bootStartsMs: null,
      schemaRefusal: null,
      fleet: { state: "UNAVAILABLE", liveInstances: 0, lastHeartbeatAgeSeconds: null, reason: "db down" },
      queues: null,
      newestReconciliationRunAtMs: undefined,
      backups: null,
    };
    expect(detectOutageSignals(f, cfg)).toEqual([]);
  });

  it("switches: expectedWorkers 0 and OPS_WATCHDOG_BACKUP_EXPECTED=false turn those detectors off; bad values fall back", () => {
    const c = readOutageWatchdogConfig({
      OPS_WATCHDOG_EXPECTED_WORKERS: "0",
      OPS_WATCHDOG_BACKUP_EXPECTED: "false",
      OPS_WATCHDOG_RESTART_THRESHOLD: "-3",
      OPS_WATCHDOG_RECONCILIATION_STALE_MINUTES: "abc",
    });
    expect(c.expectedWorkers).toBe(0);
    expect(c.backupExpected).toBe(false);
    expect(c.restartThreshold).toBe(OUTAGE_WATCHDOG_DEFAULTS.restartThreshold);
    expect(c.reconciliationStaleMinutes).toBe(60);
    const cats = detectOutageSignals(outageFacts(), c).map((s) => s.category);
    expect(cats).not.toContain("WORKER_NOT_LIVE");
    expect(cats).not.toContain("DATABASE_BACKUP_MISSING");
    expect(cats).toContain("WORKER_SCHEMA_HEAD_REFUSAL");
  });
});

class FakeProvider implements AlertProvider {
  readonly name = "webhook" as const;
  sent: AlertInput[] = [];
  isReady() {
    return true;
  }
  async dispatch(input: AlertInput) {
    this.sent.push(input);
    return { ok: true as const, provider: "webhook" };
  }
}

function memoryState() {
  let state = {};
  return {
    loadState: async () => JSON.parse(JSON.stringify(state)),
    saveState: async (s: object) => {
      state = JSON.parse(JSON.stringify(s));
    },
  };
}

describe("dispatch through the real alert path (fake provider)", () => {
  afterEach(() => setAlertProviderForTests(null));

  it("alerts once when the outage starts, stays quiet on the next tick, reminds hourly, and resolves once", async () => {
    const provider = new FakeProvider();
    setAlertProviderForTests(provider);
    const store = memoryState();
    let facts = outageFacts(NOW);
    const deps = { readFacts: async () => facts, dispatch: dispatchOpsAlert, config: cfg, ...store };

    const first = await runOutageWatchdog(deps);
    expect(first.alerted).toHaveLength(6);
    expect(first.undelivered).toBe(0);
    expect(provider.sent.map((a) => a.category).sort()).toEqual(
      [
        "DATABASE_BACKUP_MISSING",
        "QUEUE_BACKLOG_STALLED",
        "RECONCILIATION_RUNS_MISSING",
        "WORKER_NOT_LIVE",
        "WORKER_RESTART_LOOP",
        "WORKER_SCHEMA_HEAD_REFUSAL",
      ].sort(),
    );
    const refusal = provider.sent.find((a) => a.category === "WORKER_SCHEMA_HEAD_REFUSAL")!;
    expect(refusal.severity).toBe("CRITICAL");
    expect(refusal.safeSummary).toContain("HEAD_NOT_APPLIED");

    facts = outageFacts(NOW + 5 * MIN);
    const second = await runOutageWatchdog(deps);
    expect(second.active).toHaveLength(6);
    expect(second.alerted).toEqual([]);
    expect(provider.sent).toHaveLength(6);

    facts = outageFacts(NOW + 61 * MIN);
    const third = await runOutageWatchdog(deps);
    expect(third.reminded).toHaveLength(6);
    expect(provider.sent.slice(6).every((a) => a.title.startsWith("Still ongoing: "))).toBe(true);
    expect(provider.sent.slice(6).every((a) => /^Ongoing for 61 min\./.test(a.safeSummary))).toBe(true);

    facts = healthyFacts(NOW + 70 * MIN);
    const fourth = await runOutageWatchdog(deps);
    expect(fourth.resolved).toHaveLength(6);
    expect(provider.sent.slice(12).every((a) => a.severity === "INFO" && a.title.startsWith("Resolved: "))).toBe(true);

    facts = healthyFacts(NOW + 75 * MIN);
    const fifth = await runOutageWatchdog(deps);
    expect(fifth).toEqual({ active: [], alerted: [], reminded: [], resolved: [], undelivered: 0 });
    expect(provider.sent).toHaveLength(18);
  });

  it("a partial fleet is held for the grace before it alerts; one that recovers inside it never alerts", async () => {
    const provider = new FakeProvider();
    setAlertProviderForTests(provider);
    const store = memoryState();
    const config = { ...cfg, expectedWorkers: 2 };
    const partial = (nowMs: number): OutageFacts => ({
      ...healthyFacts(nowMs),
      fleet: { state: "HEALTHY", liveInstances: 1, lastHeartbeatAgeSeconds: 10, reason: "1 live" },
    });
    let facts = partial(NOW);
    const deps = { readFacts: async () => facts, dispatch: dispatchOpsAlert, config, ...store };
    expect((await runOutageWatchdog(deps)).alerted).toEqual([]);
    facts = healthyFacts(NOW + 5 * MIN);
    facts.fleet = { state: "HEALTHY", liveInstances: 2, lastHeartbeatAgeSeconds: 10, reason: "2 live" };
    expect(await runOutageWatchdog(deps)).toEqual({ active: [], alerted: [], reminded: [], resolved: [], undelivered: 0 });
    expect(provider.sent).toEqual([]);

    facts = partial(NOW + 10 * MIN);
    await runOutageWatchdog(deps);
    facts = partial(NOW + 20 * MIN);
    expect((await runOutageWatchdog(deps)).alerted).toEqual(["worker-not-live"]);
    expect(provider.sent.map((a) => [a.category, a.severity])).toEqual([["WORKER_NOT_LIVE", "HIGH"]]);
  });

  it("with no alert provider configured, every would-be alert is logged as undelivered", async () => {
    // The noop provider: isReady() false, as when OPS_ALERT_WEBHOOK_URL is unset.
    setAlertProviderForTests({ name: "noop", isReady: () => false, dispatch: async () => ({ ok: false, provider: "noop", reason: "noop" }) });
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const summary = await runOutageWatchdog({
      readFacts: async () => outageFacts(),
      dispatch: dispatchOpsAlert,
      config: cfg,
      ...memoryState(),
      logger: { warn: (obj, msg) => warnings.push({ obj, msg }), info: () => undefined },
    });
    expect(summary.alerted).toHaveLength(6);
    expect(summary.undelivered).toBe(6);
    expect(warnings.filter((w) => w.msg === "ops_watchdog.alert_undelivered")).toHaveLength(6);
    expect(warnings[0]!.obj.reason).toBe("no_provider");
  });
});

class FakeRedis implements WatchdogRedis {
  zsets = new Map<string, Array<{ score: number; member: string }>>();
  kv = new Map<string, string>();
  async zrangebyscore(key: string, min: number | string, max: number | string) {
    const lo = min === "-inf" ? -Infinity : Number(min);
    const hi = max === "+inf" ? Infinity : Number(max);
    return (this.zsets.get(key) ?? []).filter((e) => e.score >= lo && e.score <= hi).map((e) => e.member);
  }
  async get(key: string) {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.kv.set(key, value);
    return "OK";
  }
}

describe("readOutageFacts — the authorities the detectors read", () => {
  it("reads the worker's boot records and refusal from Redis, the newest worker-scheduled run, and the backup records", async () => {
    const redis = new FakeRedis();
    redis.zsets.set(OPS_WORKER_BOOT_EVENTS_KEY, [
      { score: NOW - 2 * H, member: `w|1|${NOW - 2 * H}` },
      { score: NOW - 10 * MIN, member: `w|1|${NOW - 10 * MIN}` },
      { score: NOW - 5 * MIN, member: `w|1|${NOW - 5 * MIN}` },
    ]);
    redis.kv.set(OPS_WORKER_SCHEMA_REFUSAL_KEY, JSON.stringify({ kind: "HEAD_NOT_APPLIED", expected: HEAD, workerId: "w", atMs: NOW - MIN }));
    const runWhere: unknown[] = [];
    const prisma = {
      governanceReconciliationRun: {
        findFirst: async (args: unknown) => {
          runWhere.push(args);
          return { startedAtUtc: new Date(NOW - 26 * H) };
        },
      },
      platformBackupRecord: {
        findFirst: async (args: { where: { outcome?: string } }) =>
          args.where.outcome === "SUCCEEDED" ? null : { outcome: "FAILED", recordedAtUtc: new Date(NOW - 30 * MIN) },
      },
    };
    const facts = await readOutageFacts({
      prisma,
      redis,
      config: cfg,
      nowMs: NOW,
      readFleet: async () => ({ state: "STOPPED", liveInstances: 0, lastHeartbeatAgeSeconds: 3600, reason: "r" }),
      readQueues: async () => [],
    });
    expect(facts.bootStartsMs).toEqual([NOW - 10 * MIN, NOW - 5 * MIN]);
    expect(facts.schemaRefusal).toEqual({ kind: "HEAD_NOT_APPLIED", expected: HEAD, workerId: "w", atMs: NOW - MIN });
    expect(facts.newestReconciliationRunAtMs).toBe(NOW - 26 * H);
    expect(JSON.stringify(runWhere[0])).toContain('"RETENTION"');
    expect(JSON.stringify(runWhere[0])).not.toContain("WORKSPACE");
    expect(facts.backups).toEqual({ newestSucceededAtMs: null, newestRecord: { outcome: "FAILED", atMs: NOW - 30 * MIN } });
  });

  it("a source that throws is reported unreadable, not healthy", async () => {
    const broken = {
      zrangebyscore: async () => {
        throw new Error("redis down");
      },
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => "OK",
    };
    const facts = await readOutageFacts({
      prisma: {
        governanceReconciliationRun: { findFirst: async () => { throw new Error("db"); } },
        platformBackupRecord: { findFirst: async () => { throw new Error("db"); } },
      },
      redis: broken,
      config: cfg,
      nowMs: NOW,
      readFleet: async () => {
        throw new Error("db");
      },
      readQueues: async () => {
        throw new Error("redis");
      },
    });
    expect(facts).toEqual({
      nowMs: NOW,
      bootStartsMs: null,
      schemaRefusal: null,
      fleet: null,
      queues: null,
      newestReconciliationRunAtMs: undefined,
      backups: null,
    });
  });

  it("the watchdog state lives in Redis, so a replica taking over does not re-announce", async () => {
    const redis = new FakeRedis();
    const provider = new FakeProvider();
    setAlertProviderForTests(provider);
    try {
      const replicaA = { readFacts: async () => outageFacts(), dispatch: dispatchOpsAlert, config: cfg, ...redisWatchdogState(redis) };
      const replicaB = { readFacts: async () => outageFacts(NOW + 5 * MIN), dispatch: dispatchOpsAlert, config: cfg, ...redisWatchdogState(redis) };
      expect((await runOutageWatchdog(replicaA)).alerted).toHaveLength(6);
      expect(redis.kv.has(OUTAGE_WATCHDOG_STATE_KEY)).toBe(true);
      expect((await runOutageWatchdog(replicaB)).alerted).toEqual([]);
      expect(provider.sent).toHaveLength(6);
    } finally {
      setAlertProviderForTests(null);
    }
  });
});

describe("the platform maintenance sweep runs the watchdog under its own lease", () => {
  const noop = async () => ({}) as never;
  it("runs it, reports its summary, and skips it when another holder has the lease", async () => {
    const held = new Set<string>();
    const withLease = async <T,>(key: string, _ttl: number, fn: () => Promise<T>, onBusy: () => T | Promise<T>) => {
      if (held.has(key)) return onBusy();
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    };
    let calls = 0;
    const runOutageWatchdog = async () => {
      calls += 1;
      return { active: ["worker-not-live"], alerted: ["worker-not-live"], reminded: [], resolved: [], undelivered: 0 };
    };
    const res = await runPlatformMaintenanceSweep({ trigger: "scheduler" }, {
      runMasterReconcile: noop,
      reconcileUploads: noop,
      withLease,
      runOutageWatchdog,
    });
    expect(calls).toBe(1);
    expect(res.outageWatchdog).toMatchObject({ status: "completed", summary: { alerted: ["worker-not-live"] } });

    held.add(OUTAGE_WATCHDOG_LEASE_KEY);
    const skipped = await runPlatformMaintenanceSweep({ trigger: "scheduler" }, {
      runMasterReconcile: noop,
      reconcileUploads: noop,
      withLease,
      runOutageWatchdog,
    });
    expect(calls).toBe(1);
    expect(skipped.outageWatchdog?.status).toBe("skipped_locked");
  });
});
