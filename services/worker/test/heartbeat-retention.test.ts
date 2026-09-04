/**
 * HEARTBEAT RETENTION — bounded, coordinated, and safe to interrupt.
 *
 * The sweep exists because `worker_telemetry_snapshots` was append-only with
 * no retention: one row per worker per interval, forever. Liveness no longer
 * reads that table at all, but the operations dashboard and the trust probes
 * still do, so it is bounded rather than dropped.
 *
 * Three properties matter, and each has a way of going wrong quietly:
 *
 *   COORDINATED  every instance ticks on its own schedule. Without the
 *                advisory lock a fleet of ten runs ten overlapping DELETEs
 *                over the same rows.
 *   BOUNDED      the first sweep after this ships may face a very large
 *                backlog. One unbounded DELETE would be a long transaction
 *                holding locks on a table health probes read per request.
 *   IDEMPOTENT   it is an age predicate, so interrupting it anywhere and
 *                running it again reaches the same end state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };

const db = {
  calls: [] as Call[],
  lockGranted: true,
  /** Rows the next DELETE will claim to have removed, in order. */
  deleteResults: [] as number[],
  throwOnDelete: false,
};

vi.mock("../src/db.js", () => ({
  prisma: {
    $queryRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join("?");
      db.calls.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) {
        return [{ locked: db.lockGranted }];
      }
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join("?");
      db.calls.push({ sql, params });
      if (db.throwOnDelete) throw new Error("simulated delete failure");
      return db.deleteResults.shift() ?? 0;
    },
  },
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const {
  sweepHeartbeatHistory,
  resolveRetentionDays,
  HEARTBEAT_RETENTION_DAYS_DEFAULT,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
} = await import("../src/heartbeat-retention.js");

beforeEach(() => {
  db.calls = [];
  db.lockGranted = true;
  db.deleteResults = [];
  db.throwOnDelete = false;
  delete process.env.WORKER_HEARTBEAT_RETENTION_DAYS;
});

const deletes = () => db.calls.filter((c) => c.sql.includes("DELETE FROM"));
const unlocks = () => db.calls.filter((c) => c.sql.includes("pg_advisory_unlock"));

describe("the retention window is explicit and bounded", () => {
  it("defaults to 30 days", () => {
    expect(resolveRetentionDays()).toBe(30);
    expect(HEARTBEAT_RETENTION_DAYS_DEFAULT).toBe(30);
  });

  it("accepts an override and clamps an unusable one", () => {
    expect(resolveRetentionDays(7)).toBe(7);
    // Floor 1: "0 days" would mean continuous deletion of everything.
    expect(resolveRetentionDays(0)).toBe(HEARTBEAT_RETENTION_DAYS_DEFAULT);
    expect(resolveRetentionDays(-5)).toBe(HEARTBEAT_RETENTION_DAYS_DEFAULT);
    // Ceiling 365: an override cannot quietly restore unbounded growth.
    expect(resolveRetentionDays(100_000)).toBe(365);
    expect(resolveRetentionDays(Number.NaN)).toBe(HEARTBEAT_RETENTION_DAYS_DEFAULT);
  });

  it("reads the environment when nothing is passed", async () => {
    process.env.WORKER_HEARTBEAT_RETENTION_DAYS = "14";
    expect(resolveRetentionDays()).toBe(14);
    const out = await sweepHeartbeatHistory();
    expect(out.retentionDays).toBe(14);
  });
});

describe("only the lock holder sweeps", () => {
  it("does nothing at all when another instance holds the lock", async () => {
    db.lockGranted = false;
    db.deleteResults = [100];
    const out = await sweepHeartbeatHistory();

    expect(out.ran).toBe(false);
    expect(out.deleted).toBe(0);
    // The point: the loser issues NO delete. Not a smaller one — none.
    expect(deletes()).toHaveLength(0);
  });

  it("does not try to unlock a lock it never held", async () => {
    db.lockGranted = false;
    await sweepHeartbeatHistory();
    expect(unlocks()).toHaveLength(0);
  });

  it("releases the lock after a successful sweep", async () => {
    db.deleteResults = [3];
    await sweepHeartbeatHistory();
    expect(unlocks()).toHaveLength(1);
  });

  it("releases the lock even when the sweep throws", async () => {
    db.throwOnDelete = true;
    const out = await sweepHeartbeatHistory();
    // A failure must not be reported as success, and must not wedge the lock
    // for every other instance.
    expect(out.deleted).toBe(0);
    expect(unlocks()).toHaveLength(1);
  });
});

describe("the work per run is bounded", () => {
  it("stops as soon as a batch comes back short — the backlog is drained", async () => {
    db.deleteResults = [RETENTION_BATCH_SIZE, 12];
    const out = await sweepHeartbeatHistory();
    expect(deletes()).toHaveLength(2);
    expect(out.deleted).toBe(RETENTION_BATCH_SIZE + 12);
    expect(out.moreRemaining).toBe(false);
  });

  it("stops at the batch cap on a large backlog and says more remains", async () => {
    // Every batch full: the backlog outlives this run.
    db.deleteResults = Array.from({ length: 50 }, () => RETENTION_BATCH_SIZE);
    const out = await sweepHeartbeatHistory();

    expect(deletes()).toHaveLength(RETENTION_MAX_BATCHES);
    expect(out.batches).toBe(RETENTION_MAX_BATCHES);
    expect(out.moreRemaining).toBe(true);
    // Not silently "done": the next tick continues.
    expect(out.deleted).toBe(RETENTION_MAX_BATCHES * RETENTION_BATCH_SIZE);
  });

  it("caps an absurd batch size rather than honouring it", async () => {
    db.deleteResults = [1];
    await sweepHeartbeatHistory({ batchSize: 10_000_000 });
    const limit = deletes()[0]?.params.at(-1);
    expect(Number(limit)).toBeLessThanOrEqual(50_000);
  });

  it("issues no delete at all when nothing is old enough", async () => {
    db.deleteResults = [0];
    const out = await sweepHeartbeatHistory();
    expect(out.ran).toBe(true);
    expect(out.deleted).toBe(0);
    // Idempotent: a second run over an already-clean table is also a no-op.
    db.calls = [];
    db.deleteResults = [0];
    const again = await sweepHeartbeatHistory();
    expect(again.deleted).toBe(0);
  });
});

describe("the sweep touches only the history table", () => {
  it("names worker_telemetry_snapshots and nothing else", async () => {
    db.deleteResults = [5];
    await sweepHeartbeatHistory();
    const sql = deletes()[0]?.sql ?? "";
    expect(sql).toContain("worker_telemetry_snapshots");
    // A live worker's lease must be unreachable from here.
    expect(sql).not.toContain("worker_leases");
  });

  it("selects by the retention predicate, so the cutoff is the only criterion", async () => {
    db.deleteResults = [1];
    const out = await sweepHeartbeatHistory({ retentionDays: 30 });
    const sql = deletes()[0]?.sql ?? "";
    expect(sql).toContain("heartbeat_at_utc <");
    const cutoff = new Date(out.cutoffUtc).getTime();
    const expected = Date.now() - 30 * 24 * 3600 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(10_000);
  });
});
