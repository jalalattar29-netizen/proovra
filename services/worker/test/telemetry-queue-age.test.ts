/**
 * AUDIT F-05 (round 3) — the durable queue telemetry row carries queue AGE.
 *
 * `queue_telemetry_snapshots.oldest_job_age_ms` existed and the BullMQ sampler
 * never wrote it, so the report queue's age was visible only in a log line
 * (whose read was itself the newest job's age, see readiness-smoke F-05). The
 * sampler now writes the oldest unfinished job's age for every sampled queue.
 * Driven through `startTelemetrySampler` (its first sample), with the database
 * and the BullMQ queues doubled; the queue double models BullMQ 5's ordering
 * (newest-first by default, oldest-first with asc=true).
 */
import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ queue: [] as Array<Record<string, unknown>>, worker: 0 }));
const NOW = vi.hoisted(() => Date.now());

vi.mock("../src/db.js", () => ({
  prisma: {
    queueTelemetrySnapshot: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.queue.push(data);
        return data;
      },
    },
    workerTelemetrySnapshot: {
      create: async () => {
        rows.worker += 1;
        return {};
      },
    },
  },
}));
vi.mock("../src/worker-lease.js", () => ({
  registerWorkerLease: async () => undefined,
  touchWorkerLease: async () => undefined,
  markWorkerDraining: async () => undefined,
  markWorkerStopped: async () => true,
}));
vi.mock("../src/ots-bitcoin-telemetry.js", () => ({ publishBitcoinVerifierReadiness: async () => undefined }));
vi.mock("../src/tesseract-capability.js", () => ({ probeLocalOcrCapabilityReport: async () => null }));
vi.mock("../src/heartbeat-retention.js", () => ({ sweepHeartbeatHistory: async () => undefined }));
vi.mock("../src/queue.js", () => {
  const fake = (states: Record<string, number[]>) => ({
    getJobCounts: async () => ({
      waiting: states.waiting?.length ?? 0,
      active: states.active?.length ?? 0,
      delayed: states.delayed?.length ?? 0,
      failed: 0,
      completed: 0,
    }),
    getDelayed: async () => [],
    getJobs: async (types: string | string[], start = 0, end = -1, asc = false) =>
      (Array.isArray(types) ? types : [types])
        .flatMap((t) => (asc ? [...(states[t] ?? [])] : [...(states[t] ?? [])].reverse()).slice(start, end < 0 ? undefined : end + 1))
        .map((timestamp) => ({ timestamp })),
  });
  const empty = fake({});
  return {
    // A backlog under continuous arrivals: oldest waiting job 90 s old, newest 0.5 s.
    reportQueue: fake({ waiting: [NOW - 90_000, NOW - 30_000, NOW - 500], active: [NOW - 95_000] }),
    reportDlqQueue: empty,
    otsUpgradeQueue: empty,
    evidencePurgeQueue: empty,
    searchIndexingQueue: empty,
    mediaIntelligenceQueue: empty,
    derivedAssetsQueue: empty,
    graphReconcileQueue: empty,
    graphSearchProjectionQueue: empty,
  };
});

const { startTelemetrySampler } = await import("../src/telemetry.js");

describe("F-05 — durable queue telemetry records the oldest pending job's age", () => {
  it("writes oldestJobAgeMs for the report queue (the oldest job, not the newest) and null for an empty queue", async () => {
    const sampler = startTelemetrySampler({ intervalMs: 600_000, workerId: "f05-test" });
    await vi.waitFor(() => expect(rows.worker).toBeGreaterThan(0));
    sampler.stop();
    const report = rows.queue.find((r) => r.queueName === "report")!;
    expect(report).toBeTruthy();
    expect(report.oldestJobAgeMs as number).toBeGreaterThanOrEqual(95_000);
    expect(report.oldestJobAgeMs as number).toBeLessThan(105_000);
    expect(report.waitingCount).toBe(3);
    expect(report.activeCount).toBe(1);
    const purge = rows.queue.find((r) => r.queueName === "evidence.purge")!;
    expect(purge.oldestJobAgeMs).toBeNull();
  });
});
