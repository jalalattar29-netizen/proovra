/**
 * OPS closure 2 (2026-11-21) — what the outage watchdog missed in production.
 *
 * From 15:12Z production held OFFHOST_COPY FAILED (BACKUP_S3_URI unset) and
 * RESTORE_DRILL FAILED (insufficient disk at the time) in
 * platform_backup_records, and the watchdog's summary stayed
 * {active: [], alerted: []}: it read DATABASE_BACKUP rows only. The disk had
 * no detector, and an unreadable source was silent. These tests drive the
 * real detectors and the real dispatch logic (dispatchOpsAlert with a fake
 * provider), and the real fact reader with a fake Prisma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchOpsAlert, setAlertProviderForTests } from "../src/services/alerts/alert.service.js";
import type { AlertInput, AlertProvider } from "../src/services/alerts/provider.js";
import {
  OUTAGE_WATCHDOG_DEFAULTS,
  RESOLVE_RETRY_LIMIT,
  detectOutageSignals,
  readDiskUsage,
  readOutageFacts,
  readOutageWatchdogConfig,
  runOutageWatchdog,
  type BackupKindFact,
  type OutageFacts,
} from "../src/services/operations/outage-watchdog.service.js";

const MIN = 60_000;
const H = 60 * MIN;
const GB = 1024 * 1024 * 1024;
const NOW = Date.parse("2026-11-21T16:00:00Z");
const cfg = { ...OUTAGE_WATCHDOG_DEFAULTS };

const ok = (atMs: number): BackupKindFact => ({ newestSucceededAtMs: atMs, newestRecord: { outcome: "SUCCEEDED", atMs } });

function healthy(nowMs = NOW): OutageFacts {
  return {
    nowMs,
    boots: [{ workerId: "w-1", atMs: nowMs - 3 * H }],
    schemaRefusal: null,
    fleet: { state: "HEALTHY", liveInstances: 1, lastHeartbeatAgeSeconds: 20, reason: "1 live" },
    queues: [{ queueName: "report-generation", waiting: 0, oldestWaitingAgeMs: null, isWorkQueue: true }],
    newestReconciliationRunAtMs: nowMs - 4 * MIN,
    backups: { ...ok(nowMs - 1 * H), offhost: ok(nowMs - 2 * H), drill: ok(nowMs - 30 * H) },
    disk: [{ path: "/", totalBytes: 75 * GB, freeBytes: 35 * GB, usedPercent: 53 }],
  };
}

/** Production at ~16:00Z: the backup itself fine, its off-host copy and its drill FAILED. */
function production1600(nowMs = NOW): OutageFacts {
  const f = healthy(nowMs);
  f.backups = {
    ...ok(nowMs - 50 * MIN),
    offhost: { newestSucceededAtMs: null, newestRecord: { outcome: "FAILED", atMs: Date.parse("2026-11-21T15:12:00Z") } },
    drill: { newestSucceededAtMs: null, newestRecord: { outcome: "FAILED", atMs: Date.parse("2026-11-21T15:12:00Z") } },
  };
  return f;
}

class FakeProvider implements AlertProvider {
  readonly name = "webhook" as const;
  sent: AlertInput[] = [];
  /** Inputs whose title matches are refused this many times. */
  refuse: { match: RegExp; times: number } | null = null;
  isReady() {
    return true;
  }
  async dispatch(input: AlertInput) {
    if (this.refuse && this.refuse.times > 0 && this.refuse.match.test(input.title)) {
      this.refuse.times -= 1;
      return { ok: false as const, provider: "webhook", reason: "webhook_http_503" };
    }
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

/**
 * The real dispatcher. Its per-fingerprint 5-minute throttle reads the clock,
 * so the clock is set to each tick's time (ticks are 5 min apart, as in production).
 */
function harness(provider: FakeProvider, config = cfg) {
  setAlertProviderForTests(provider);
  let facts = healthy();
  const deps = { readFacts: async () => facts, dispatch: dispatchOpsAlert, config, ...memoryState() };
  return {
    tick: (f: OutageFacts) => {
      vi.setSystemTime(f.nowMs);
      facts = f;
      return runOutageWatchdog(deps);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  setAlertProviderForTests(null);
  vi.useRealTimers();
});

describe("backup failure and staleness: every kind", () => {
  it("production at 16:00Z (OFFHOST_COPY FAILED, RESTORE_DRILL FAILED, backup fine) raises both, each saying why", () => {
    const signals = detectOutageSignals(production1600(), cfg);
    expect(signals.map((s) => [s.category, s.title]).sort()).toEqual(
      [
        ["BACKUP_OFFHOST_COPY_MISSING", "Off-host backup copy failed"],
        ["RESTORE_DRILL_MISSING", "Backup restore drill failed"],
      ].sort(),
    );
    const offhost = signals.find((s) => s.category === "BACKUP_OFFHOST_COPY_MISSING")!;
    expect(offhost.summary).toMatch(/^No successful off-host backup copy is recorded; the latest off-host backup copy FAILED 48 min ago\./);
    expect(offhost.summary).toContain("BACKUP_S3_URI");
    const drill = signals.find((s) => s.category === "RESTORE_DRILL_MISSING")!;
    expect(drill.summary).toMatch(/the latest restore drill FAILED 48 min ago/);
  });

  it("the latest run FAILED alerts for each kind on its own, even after an older success", () => {
    for (const kind of ["database", "offhost", "drill"] as const) {
      const f = healthy();
      const failed: BackupKindFact = { newestSucceededAtMs: NOW - 2 * H, newestRecord: { outcome: "FAILED", atMs: NOW - 10 * MIN } };
      if (kind === "database") f.backups = { ...f.backups!, ...failed };
      else f.backups = { ...f.backups!, [kind]: failed };
      const cats = detectOutageSignals(f, cfg).map((s) => s.category);
      expect(cats).toEqual([
        { database: "DATABASE_BACKUP_MISSING", offhost: "BACKUP_OFFHOST_COPY_MISSING", drill: "RESTORE_DRILL_MISSING" }[kind],
      ]);
    }
  });

  it("a stale last success alerts at the limit + 1 h and is quiet at the limit; none ever recorded alerts", () => {
    const at = (offhostH: number, drillH: number) => {
      const f = healthy();
      f.backups = { ...f.backups!, offhost: ok(NOW - offhostH * H), drill: ok(NOW - drillH * H) };
      return detectOutageSignals(f, cfg).map((s) => s.fingerprint).sort();
    };
    expect(at(26, 192)).toEqual([]);
    expect(at(27, 192)).toEqual(["backup-offhost-copy-missing"]);
    expect(at(26, 193)).toEqual(["restore-drill-missing"]);

    const never = healthy();
    never.backups = { ...never.backups!, offhost: { newestSucceededAtMs: null, newestRecord: null }, drill: { newestSucceededAtMs: null, newestRecord: null } };
    const s = detectOutageSignals(never, cfg);
    expect(s.map((x) => x.title).sort()).toEqual(["No recent backup restore drill", "No recent off-host backup copy"]);
  });

  it("switches: OPS_WATCHDOG_OFFHOST_EXPECTED / _DRILL_EXPECTED=false turn one off; BACKUP_EXPECTED=false turns all three off", () => {
    expect(detectOutageSignals(production1600(), readOutageWatchdogConfig({ OPS_WATCHDOG_OFFHOST_EXPECTED: "false" })).map((s) => s.category)).toEqual([
      "RESTORE_DRILL_MISSING",
    ]);
    expect(detectOutageSignals(production1600(), readOutageWatchdogConfig({ OPS_WATCHDOG_DRILL_EXPECTED: "false" })).map((s) => s.category)).toEqual([
      "BACKUP_OFFHOST_COPY_MISSING",
    ]);
    expect(detectOutageSignals(production1600(), readOutageWatchdogConfig({ OPS_WATCHDOG_BACKUP_EXPECTED: "false" }))).toEqual([]);
  });

  it("readOutageFacts reads each kind's newest success and newest record", async () => {
    const rows: Record<string, Array<{ outcome: string; at: number }>> = {
      DATABASE_BACKUP: [{ outcome: "SUCCEEDED", at: NOW - 1 * H }],
      OFFHOST_COPY: [{ outcome: "FAILED", at: NOW - 30 * MIN }, { outcome: "SUCCEEDED", at: NOW - 40 * H }],
      RESTORE_DRILL: [{ outcome: "FAILED", at: NOW - 50 * MIN }],
    };
    const prisma = {
      governanceReconciliationRun: { findFirst: async () => ({ startedAtUtc: new Date(NOW - MIN) }) },
      platformBackupRecord: {
        findFirst: async (args: unknown) => {
          const where = (args as { where: { kind: string; outcome?: string } }).where;
          const hit = (rows[where.kind] ?? []).filter((r) => !where.outcome || r.outcome === where.outcome).sort((a, b) => b.at - a.at)[0];
          return hit ? { outcome: hit.outcome, recordedAtUtc: new Date(hit.at) } : null;
        },
      },
    };
    const facts = await readOutageFacts({
      prisma,
      redis: null,
      config: cfg,
      nowMs: NOW,
      readFleet: async () => ({ state: "HEALTHY", liveInstances: 1, lastHeartbeatAgeSeconds: 5, reason: "" }),
      readQueues: async () => [],
    });
    expect(facts.backups).toEqual({
      newestSucceededAtMs: NOW - 1 * H,
      newestRecord: { outcome: "SUCCEEDED", atMs: NOW - 1 * H },
      offhost: { newestSucceededAtMs: NOW - 40 * H, newestRecord: { outcome: "FAILED", atMs: NOW - 30 * MIN } },
      drill: { newestSucceededAtMs: null, newestRecord: { outcome: "FAILED", atMs: NOW - 50 * MIN } },
    });
    expect(detectOutageSignals({ ...healthy(), backups: facts.backups }, cfg).map((s) => s.category).sort()).toEqual([
      "BACKUP_OFFHOST_COPY_MISSING",
      "RESTORE_DRILL_MISSING",
    ]);
  });

  it("through the dispatcher: one alert each, quiet repeats, one recovery each when the copy and the drill succeed", async () => {
    const provider = new FakeProvider();
    const h = harness(provider);
    expect((await h.tick(production1600(NOW))).alerted.sort()).toEqual(["backup-offhost-copy-missing", "restore-drill-missing"]);
    for (let i = 1; i <= 5; i += 1) expect((await h.tick(production1600(NOW + i * 5 * MIN))).alerted).toEqual([]);
    expect(provider.sent).toHaveLength(2);
    const fixed = healthy(NOW + 30 * MIN);
    expect((await h.tick(fixed)).resolved.sort()).toEqual(["backup-offhost-copy-missing", "restore-drill-missing"]);
    expect((await h.tick(healthy(NOW + 35 * MIN))).resolved).toEqual([]);
    expect(provider.sent.map((a) => a.title)).toEqual([
      expect.stringMatching(/^(Off-host backup copy failed|Backup restore drill failed)$/),
      expect.stringMatching(/^(Off-host backup copy failed|Backup restore drill failed)$/),
      expect.stringMatching(/^Resolved: /),
      expect.stringMatching(/^Resolved: /),
    ]);
  });
});

describe("disk threshold", () => {
  it("over the used percentage or under the free floor alerts; inside both is quiet; 95% is CRITICAL", () => {
    const at = (usedPercent: number, freeGb: number) =>
      detectOutageSignals({ ...healthy(), disk: [{ path: "/", totalBytes: 75 * GB, freeBytes: freeGb * GB, usedPercent }] }, cfg);
    expect(at(85, 11)).toEqual([]);
    expect(at(53, 4)).toEqual([]);
    const pct = at(86, 10);
    expect(pct.map((s) => [s.category, s.severity, s.fingerprint])).toEqual([["HOST_DISK_LOW", "HIGH", "disk-low:/"]]);
    expect(pct[0]!.summary).toMatch(/^\/ is 86% used with 10\.0 GB free \(limits: 85% used, 4096 MB free\)/);
    expect(at(60, 3.9).map((s) => s.category)).toEqual(["HOST_DISK_LOW"]);
    expect(at(95, 3.7)[0]!.severity).toBe("CRITICAL");
  });

  it("readDiskUsage computes the percentage as df does, and a statfs failure is unreadable, never healthy", async () => {
    // 1000 blocks of 4 KiB; 300 free of which 250 available to users: used 700 / (700 + 250) = 74%.
    const [d] = await readDiskUsage(["/"], async () => ({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 }));
    expect(d).toEqual({ path: "/", totalBytes: 4096 * 1000, freeBytes: 4096 * 250, usedPercent: 74 });

    const facts = await readOutageFacts({
      prisma: {
        governanceReconciliationRun: { findFirst: async () => ({ startedAtUtc: new Date(NOW - MIN) }) },
        platformBackupRecord: { findFirst: async () => ({ outcome: "SUCCEEDED", recordedAtUtc: new Date(NOW - H) }) },
      },
      redis: null,
      config: cfg,
      nowMs: NOW,
      readFleet: async () => ({ state: "HEALTHY", liveInstances: 1, lastHeartbeatAgeSeconds: 5, reason: "" }),
      readQueues: async () => [],
      readDisk: () => readDiskUsage(["/"], async () => {
        throw new Error("EACCES");
      }),
    });
    expect(facts.disk).toBeNull();
    expect(detectOutageSignals({ ...healthy(), disk: null }, cfg).map((s) => s.fingerprint)).toEqual(["source-unreadable:disk"]);
  });

  it("OPS_WATCHDOG_DISK_PATHS selects the filesystems and 'off' switches the detector off; bad thresholds fall back", () => {
    expect(readOutageWatchdogConfig({}).diskPaths).toEqual(["/"]);
    expect(readOutageWatchdogConfig({ OPS_WATCHDOG_DISK_PATHS: "/, /data" }).diskPaths).toEqual(["/", "/data"]);
    expect(readOutageWatchdogConfig({ OPS_WATCHDOG_DISK_PATHS: "off" }).diskPaths).toEqual([]);
    expect(readOutageWatchdogConfig({ OPS_WATCHDOG_DISK_PATHS: "relative" }).diskPaths).toEqual(["/"]);
    expect(readOutageWatchdogConfig({ OPS_WATCHDOG_DISK_MAX_USED_PERCENT: "20" }).diskMaxUsedPercent).toBe(85);
    // Off: an unmeasured disk is not an unreadable one.
    expect(detectOutageSignals({ ...healthy(), disk: null }, readOutageWatchdogConfig({ OPS_WATCHDOG_DISK_PATHS: "off" }))).toEqual([]);
  });
});

describe("unreadable is not healthy", () => {
  it("a source unreadable past the hold alerts once; an open alert from it is never falsely resolved; recovery is exactly one", async () => {
    const provider = new FakeProvider();
    const h = harness(provider);
    // The off-host copy fails: one alert.
    expect((await h.tick(production1600(NOW))).alerted.sort()).toEqual(["backup-offhost-copy-missing", "restore-drill-missing"]);
    // The database becomes unreadable (backups null): nothing resolves; after the hold, one unreadable alert.
    const blind = (nowMs: number): OutageFacts => ({ ...production1600(nowMs), backups: null, newestReconciliationRunAtMs: undefined });
    const t1 = await h.tick(blind(NOW + 5 * MIN));
    expect(t1.resolved).toEqual([]);
    expect(t1.alerted).toEqual([]);
    expect(t1.carried.sort()).toEqual(["backup-offhost-copy-missing", "restore-drill-missing"]);
    const t2 = await h.tick(blind(NOW + 15 * MIN));
    expect(t2.alerted.sort()).toEqual(["source-unreadable:backup-records", "source-unreadable:reconciliation-runs"]);
    expect(t2.resolved).toEqual([]);
    const t3 = await h.tick(blind(NOW + 20 * MIN));
    expect(t3.alerted).toEqual([]);
    expect(t3.resolved).toEqual([]);
    // Readable again and the copy still failing: the unreadable alerts resolve, the backup alerts stay open.
    const t4 = await h.tick(production1600(NOW + 25 * MIN));
    expect(t4.resolved.sort()).toEqual(["source-unreadable:backup-records", "source-unreadable:reconciliation-runs"]);
    expect(t4.alerted).toEqual([]);
    // Fixed: exactly one recovery each.
    expect((await h.tick(healthy(NOW + 30 * MIN))).resolved.sort()).toEqual(["backup-offhost-copy-missing", "restore-drill-missing"]);
    expect((await h.tick(healthy(NOW + 35 * MIN))).resolved).toEqual([]);
    const titles = provider.sent.map((a) => a.title);
    expect(titles.filter((t) => t === "Resolved: Off-host backup copy failed")).toHaveLength(1);
    expect(titles.filter((t) => t === "Off-host backup copy failed")).toHaveLength(1);
    expect(titles.filter((t) => t === "Outage watchdog cannot read the backup records")).toHaveLength(1);
    expect(titles.filter((t) => t === "Resolved: Outage watchdog cannot read the backup records")).toHaveLength(1);
  });

  it("one unreadable tick inside the hold is a blip: no alert and no resolved notice", async () => {
    const provider = new FakeProvider();
    const h = harness(provider);
    await h.tick({ ...healthy(NOW), boots: null, schemaRefusalReadable: false });
    await h.tick(healthy(NOW + 5 * MIN));
    expect(provider.sent).toEqual([]);
  });
});

describe("delivery: retried until accepted, never duplicated", () => {
  it("a start notice the receiver refuses is retried on the next tick, then not repeated", async () => {
    const provider = new FakeProvider();
    provider.refuse = { match: /^Off-host backup copy failed$/, times: 1 };
    const h = harness(provider, { ...cfg, drillExpected: false });
    const t1 = await h.tick(production1600(NOW));
    expect(t1.undelivered).toBe(1);
    expect(provider.sent).toEqual([]);
    const t2 = await h.tick(production1600(NOW + 5 * MIN));
    expect(t2.undelivered).toBe(0);
    expect(provider.sent.map((a) => a.title)).toEqual(["Off-host backup copy failed"]);
    await h.tick(production1600(NOW + 10 * MIN));
    expect(provider.sent).toHaveLength(1);
  });

  it("a recovery the receiver refuses is retried, and delivered exactly once", async () => {
    const provider = new FakeProvider();
    provider.refuse = { match: /^Resolved: /, times: 2 };
    const h = harness(provider, { ...cfg, drillExpected: false });
    await h.tick(production1600(NOW));
    const r1 = await h.tick(healthy(NOW + 5 * MIN));
    expect(r1.resolved).toEqual([]);
    expect(r1.undelivered).toBe(1);
    const r2 = await h.tick(healthy(NOW + 10 * MIN));
    expect(r2.resolved).toEqual([]);
    const r3 = await h.tick(healthy(NOW + 15 * MIN));
    expect(r3.resolved).toEqual(["backup-offhost-copy-missing"]);
    await h.tick(healthy(NOW + 20 * MIN));
    await h.tick(healthy(NOW + 25 * MIN));
    expect(provider.sent.map((a) => a.title)).toEqual(["Off-host backup copy failed", "Resolved: Off-host backup copy failed"]);
  });

  it("a signal that returns before its refused recovery was delivered is still ongoing: no second start notice", async () => {
    const provider = new FakeProvider();
    provider.refuse = { match: /^Resolved: /, times: 1 };
    const h = harness(provider, { ...cfg, drillExpected: false });
    await h.tick(production1600(NOW));
    await h.tick(healthy(NOW + 5 * MIN));
    const back = await h.tick(production1600(NOW + 10 * MIN));
    expect(back.alerted).toEqual([]);
    expect(provider.sent.map((a) => a.title)).toEqual(["Off-host backup copy failed"]);
  });

  it("a recovery refused every time is given up after the limit, logged, and never sent twice", async () => {
    const provider = new FakeProvider();
    provider.refuse = { match: /^Resolved: /, times: 1000 };
    setAlertProviderForTests(provider);
    const warnings: string[] = [];
    let facts = production1600(NOW);
    vi.setSystemTime(NOW);
    const deps = {
      readFacts: async () => facts,
      dispatch: dispatchOpsAlert,
      config: { ...cfg, drillExpected: false },
      ...memoryState(),
      logger: { warn: (_o: Record<string, unknown>, msg: string) => warnings.push(msg), info: () => undefined },
    };
    await runOutageWatchdog(deps);
    for (let i = 1; i <= RESOLVE_RETRY_LIMIT + 3; i += 1) {
      facts = healthy(NOW + i * 5 * MIN);
      vi.setSystemTime(facts.nowMs);
      await runOutageWatchdog(deps);
    }
    expect(warnings.filter((w) => w === "ops_watchdog.resolve_abandoned")).toHaveLength(1);
    expect(warnings.filter((w) => w === "ops_watchdog.alert_undelivered")).toHaveLength(RESOLVE_RETRY_LIMIT);
  });
});
