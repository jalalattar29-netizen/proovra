/**
 * PLATFORM MAINTENANCE — the scheduled caller of `POST /v1/ops/reconcile` and
 * `POST /v1/reliability/reconcile` work.
 *
 * Neither route had an invoker in the deployment. The API's existing
 * in-process scheduler now runs the SAME functions the routes call, each under
 * the existing `withLease` lease, and a failed tick never stops the interval.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPS_MASTER_RECONCILE_LEASE_KEY,
  PLATFORM_MAINTENANCE_INTERVAL_MS,
  PLATFORM_MAINTENANCE_LEASE_TTL_MS,
  RELIABILITY_UPLOAD_RECONCILE_LEASE_KEY,
  runPlatformMaintenanceSweep,
  runPlatformMaintenanceSweepSafe,
  type PlatformMaintenanceDeps,
} from "../src/jobs/platform-maintenance-reconciliation.job.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(__dirname, "..", "src");
const SERVER_SRC = readFileSync(resolve(API_SRC, "server.ts"), "utf8");
const JOB_SRC = readFileSync(
  resolve(API_SRC, "jobs", "platform-maintenance-reconciliation.job.ts"),
  "utf8",
);
const OPS_SRC = readFileSync(resolve(API_SRC, "routes", "ops.routes.ts"), "utf8");
const RELIABILITY_SRC = readFileSync(
  resolve(API_SRC, "routes", "reliability.routes.ts"),
  "utf8",
);

const MASTER_SUMMARY = {
  stepUpChallengesExpired: 0,
  trustedDevicesExpired: 0,
  communicationsRetryDue: 0,
  notificationsRetryDue: 0,
  pendingCommunicationsCancelled: 0,
  staleAccessReviewsCreated: 0,
  intelligenceJobsStuck: 0,
  uploadsStalled: 0,
  uploadSessionsExpired: 0,
};
const UPLOAD_SUMMARY = {
  stalledThresholdMinutes: 60,
  abandonedThresholdHours: 72,
  scanned: 0,
  markedStalled: 0,
  markedAbandoned: 0,
  flaggedReviewRequired: 0,
};

/** A lease with the real one's contract: one holder per key, released after. */
function memoryLease() {
  const held = new Set<string>();
  const calls: Array<{ key: string; ttlMs: number }> = [];
  const withLease: PlatformMaintenanceDeps["withLease"] = async (key, ttlMs, fn, onBusy) => {
    calls.push({ key, ttlMs });
    if (held.has(key)) return onBusy();
    held.add(key);
    try {
      return await fn();
    } finally {
      held.delete(key);
    }
  };
  return { withLease, calls, held };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("platform maintenance sweep — schedule constants", () => {
  it("runs every 5 minutes and leases each step for 10 minutes", () => {
    expect(PLATFORM_MAINTENANCE_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(PLATFORM_MAINTENANCE_LEASE_TTL_MS).toBe(10 * 60 * 1000);
    expect(OPS_MASTER_RECONCILE_LEASE_KEY).not.toBe(RELIABILITY_UPLOAD_RECONCILE_LEASE_KEY);
  });
});

describe("platform maintenance sweep — behaviour", () => {
  it("runs both reconciles, each under its own lease", async () => {
    const lease = memoryLease();
    const runMasterReconcile = vi.fn(async () => MASTER_SUMMARY);
    const reconcileUploads = vi.fn(async () => UPLOAD_SUMMARY);
    const log = logger();

    const result = await runPlatformMaintenanceSweep(
      { trigger: "scheduler" },
      { runMasterReconcile, reconcileUploads, withLease: lease.withLease, logger: log },
    );

    expect(runMasterReconcile).toHaveBeenCalledTimes(1);
    expect(reconcileUploads).toHaveBeenCalledTimes(1);
    expect(lease.calls).toEqual([
      { key: OPS_MASTER_RECONCILE_LEASE_KEY, ttlMs: PLATFORM_MAINTENANCE_LEASE_TTL_MS },
      { key: RELIABILITY_UPLOAD_RECONCILE_LEASE_KEY, ttlMs: PLATFORM_MAINTENANCE_LEASE_TTL_MS },
    ]);
    expect(result.masterReconcile).toMatchObject({ status: "completed", summary: MASTER_SUMMARY });
    expect(result.uploadReconcile).toMatchObject({ status: "completed", summary: UPLOAD_SUMMARY });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "ops_master_reconcile" }),
      "platform_maintenance.step_completed",
    );
    expect(lease.held.size).toBe(0);
  });

  it("a held lease skips that step without running it", async () => {
    const lease = memoryLease();
    lease.held.add(OPS_MASTER_RECONCILE_LEASE_KEY);
    const runMasterReconcile = vi.fn(async () => MASTER_SUMMARY);
    const reconcileUploads = vi.fn(async () => UPLOAD_SUMMARY);

    const result = await runPlatformMaintenanceSweep(
      {},
      { runMasterReconcile, reconcileUploads, withLease: lease.withLease },
    );

    expect(runMasterReconcile).not.toHaveBeenCalled();
    expect(result.masterReconcile.status).toBe("skipped_locked");
    expect(reconcileUploads).toHaveBeenCalledTimes(1);
    expect(result.uploadReconcile.status).toBe("completed");
  });

  it("overlapping ticks never run the same step concurrently", async () => {
    const lease = memoryLease();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runMasterReconcile = vi.fn(async () => {
      await gate;
      return MASTER_SUMMARY;
    });
    const reconcileUploads = vi.fn(async () => UPLOAD_SUMMARY);
    const deps = { runMasterReconcile, reconcileUploads, withLease: lease.withLease };

    const first = runPlatformMaintenanceSweep({}, deps);
    const second = await runPlatformMaintenanceSweep({}, deps);
    expect(second.masterReconcile.status).toBe("skipped_locked");
    release();
    expect((await first).masterReconcile.status).toBe("completed");
    expect(runMasterReconcile).toHaveBeenCalledTimes(1);
  });

  it("a failing master reconcile does not stop the upload reconcile, and is reported", async () => {
    const lease = memoryLease();
    const log = logger();
    const captureException = vi.fn();
    const runMasterReconcile = vi.fn(async () => {
      throw new TypeError("db down");
    });
    const reconcileUploads = vi.fn(async () => UPLOAD_SUMMARY);

    const result = await runPlatformMaintenanceSweep(
      { trigger: "scheduler" },
      { runMasterReconcile, reconcileUploads, withLease: lease.withLease, logger: log, captureException },
    );

    expect(result.masterReconcile).toMatchObject({ status: "failed", error: "TypeError" });
    expect(result.uploadReconcile.status).toBe("completed");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: "ops_master_reconcile", trigger: "scheduler" }),
      "platform_maintenance.step_failed",
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    // The lease was released, so the next tick can run the step again.
    expect(lease.held.size).toBe(0);
  });

  it("the Safe wrapper never rejects, even when the lease itself throws", async () => {
    const withLease: PlatformMaintenanceDeps["withLease"] = async () => {
      throw new Error("redis exploded");
    };
    const result = await runPlatformMaintenanceSweepSafe(
      {},
      {
        runMasterReconcile: async () => MASTER_SUMMARY,
        reconcileUploads: async () => UPLOAD_SUMMARY,
        withLease,
        captureException: () => {
          throw new Error("sentry exploded");
        },
      },
    );
    expect(result?.masterReconcile.status).toBe("failed");
    expect(result?.uploadReconcile.status).toBe("failed");
  });

  it("a failed tick does not stop the interval: later ticks keep firing and succeed", async () => {
    vi.useFakeTimers();
    const lease = memoryLease();
    let attempt = 0;
    const runMasterReconcile = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("first tick fails");
      return MASTER_SUMMARY;
    });
    const reconcileUploads = vi.fn(async () => UPLOAD_SUMMARY);
    const results: Array<Awaited<ReturnType<typeof runPlatformMaintenanceSweepSafe>>> = [];

    // The same shape server.ts registers.
    const handle = setInterval(() => {
      void runPlatformMaintenanceSweepSafe(
        { trigger: "scheduler" },
        { runMasterReconcile, reconcileUploads, withLease: lease.withLease },
      ).then((r) => results.push(r));
    }, PLATFORM_MAINTENANCE_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(PLATFORM_MAINTENANCE_INTERVAL_MS * 3);
    clearInterval(handle);

    expect(runMasterReconcile).toHaveBeenCalledTimes(3);
    expect(reconcileUploads).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r?.masterReconcile.status)).toEqual([
      "failed",
      "completed",
      "completed",
    ]);
  });
});

describe("platform maintenance sweep — wiring contract", () => {
  it("server.ts schedules the Safe sweep on the existing in-process scheduler", () => {
    expect(SERVER_SRC).toMatch(
      /process\.env\.PLATFORM_MAINTENANCE_RECONCILER_ENABLED !== "false"/,
    );
    expect(SERVER_SRC).toMatch(
      /import\("\.\/jobs\/platform-maintenance-reconciliation\.job\.js"\)/,
    );
    expect(SERVER_SRC).toMatch(
      /setInterval\(\(\) => \{\s*void runPlatformMaintenanceSweepSafe\(\{ trigger: "scheduler" \}/,
    );
    expect(SERVER_SRC).toMatch(/clearInterval\(maintenanceHandle\)/);
    expect(SERVER_SRC).toMatch(/platform_maintenance_reconciler\.disabled/);
  });

  it("the sweep calls the routes' own functions through the existing lease, not HTTP", () => {
    expect(JOB_SRC).toMatch(/import\("\.\.\/routes\/ops\.routes\.js"\)/);
    expect(JOB_SRC).toMatch(
      /import\("\.\.\/services\/reliability\/upload-reconciliation\.service\.js"\)/,
    );
    expect(JOB_SRC).toMatch(/import\("\.\.\/services\/rate-limit\.js"\)/);
    expect(JOB_SRC).not.toMatch(/fetch\(/);
    expect(OPS_SRC).toMatch(/export async function runMasterReconcile\(\)/);
    expect(OPS_SRC).toMatch(/const summary = await runMasterReconcile\(\);/);
    expect(RELIABILITY_SRC).toMatch(/await reconcileUploads\(\{ batchSize: body\.batchSize \}\)/);
  });
});
