/**
 * JOB WORKER READINESS — liveness is not the same as being able to process.
 *
 * `job_worker` (the input to the tenant `artifactGeneration` capability) is
 * read from the canonical worker-lease authority. These drive it with REAL
 * lease rows, exactly as `services/worker/src/worker-lease.ts` writes them,
 * through the REAL readiness check:
 *
 *   fresh LIVE lease, queue probes succeeding   → HEALTHY
 *   fresh LIVE lease, EVERY queue probe failing → not HEALTHY  (the worker is
 *     up and heartbeating, but cannot reach its queues — Redis unreachable
 *     from the worker, a broken queue connection — so no job can run)
 *   lease aged past the window (crash)          → DEGRADED
 *   only STARTING (deploy in progress)          → UNKNOWN, never HEALTHY
 *   no lease at all                             → UNKNOWN, never HEALTHY
 *   a fresh successful heartbeat after any of these → HEALTHY again
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("job_worker readiness from real worker leases (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let readiness: typeof import("../src/runtime/runtime-readiness.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    readiness = await import("../src/runtime/runtime-readiness.js");
  }, 180_000);

  beforeEach(async () => {
    await prisma.workerLease.deleteMany({ where: { workerId: { startsWith: "jobworker-test-" } } });
    // Isolate from any lease another suite left behind.
    await prisma.workerLease.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.workerLease.deleteMany({ where: { workerId: { startsWith: "jobworker-test-" } } }).catch(() => undefined);
    await harness?.cleanup();
  });

  async function lease(input: {
    id: string;
    state: "STARTING" | "LIVE" | "DRAINING" | "STOPPED";
    ageSeconds: number;
    processed: number | null;
    failed: number | null;
  }) {
    const seen = new Date(Date.now() - input.ageSeconds * 1000);
    await prisma.workerLease.upsert({
      where: { workerId: `jobworker-test-${input.id}` },
      create: {
        workerId: `jobworker-test-${input.id}`,
        workerKind: "WORKER",
        state: input.state,
        startedAtUtc: seen,
        lastSeenAtUtc: seen,
        queueSubscriptions: ["report", "ots-upgrade", "evidence"],
        heartbeatIntervalSeconds: 60,
        processedCount: input.processed,
        failedCount: input.failed,
      },
      update: {
        state: input.state,
        lastSeenAtUtc: seen,
        processedCount: input.processed,
        failedCount: input.failed,
      },
    });
  }

  async function jobWorker() {
    const report = await readiness.runReadinessCheck(prisma as never, null);
    const s = report.subsystems.find((x) => x.id === "job_worker")!;
    return { subsystem: s, projection: readiness.projectTenantCapabilities(report) };
  }

  it("a fresh LIVE worker whose queue probes succeed is HEALTHY", async () => {
    await lease({ id: "ok", state: "LIVE", ageSeconds: 5, processed: 3, failed: 0 });
    expect((await jobWorker()).subsystem.status).toBe("HEALTHY");
  });

  it("a fresh LIVE worker that cannot reach ANY of its queues is not HEALTHY — generation cannot run", async () => {
    await lease({ id: "blind", state: "LIVE", ageSeconds: 5, processed: 0, failed: 3 });
    const { subsystem, projection } = await jobWorker();
    expect(subsystem.status).not.toBe("HEALTHY");
    expect(subsystem.reasonCode).toBe("fleet_queues_unreachable");
    expect(projection.capabilities.artifactGeneration).not.toBe("HEALTHY");
    // Nothing else a tenant does depends on the job worker.
    expect(projection.capabilities.downloads).not.toBe("DEGRADED");
  });

  it("one worker that can reach its queues keeps generation available beside one that cannot", async () => {
    await lease({ id: "blind", state: "LIVE", ageSeconds: 5, processed: 0, failed: 3 });
    await lease({ id: "ok", state: "LIVE", ageSeconds: 5, processed: 3, failed: 0 });
    expect((await jobWorker()).subsystem.status).toBe("HEALTHY");
  });

  it("a LIVE lease aged past the window (crash, no shutdown marker) is DEGRADED", async () => {
    await lease({ id: "crashed", state: "LIVE", ageSeconds: 3600, processed: 3, failed: 0 });
    expect((await jobWorker()).subsystem.status).toBe("DEGRADED");
  });

  it("startup (only STARTING) and no lease at all are UNKNOWN — never HEALTHY", async () => {
    expect((await jobWorker()).subsystem.status).toBe("UNKNOWN");
    await lease({ id: "booting", state: "STARTING", ageSeconds: 2, processed: null, failed: null });
    expect((await jobWorker()).subsystem.status).toBe("UNKNOWN");
  });

  it("a fresh successful heartbeat recovers to HEALTHY", async () => {
    await lease({ id: "w", state: "LIVE", ageSeconds: 3600, processed: 3, failed: 0 });
    expect((await jobWorker()).subsystem.status).toBe("DEGRADED");
    await lease({ id: "w", state: "LIVE", ageSeconds: 1, processed: 0, failed: 3 });
    expect((await jobWorker()).subsystem.status).not.toBe("HEALTHY");
    await lease({ id: "w", state: "LIVE", ageSeconds: 1, processed: 3, failed: 0 });
    expect((await jobWorker()).subsystem.status).toBe("HEALTHY");
  });
});
