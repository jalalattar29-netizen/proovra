/**
 * F-10 (Free-user audit 4d9b, capacity; 2026-11-15) — a job the api enqueues
 * keeps a BOUNDED number of failed jobs per queue (BullMQ `removeOnFail: N`),
 * not `false` (kept for ever in a `noeviction` Redis with no `maxmemory`).
 * BullMQ is replaced by a recorder: nothing reaches Redis.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; opts: { defaultJobOptions?: Record<string, unknown> } }>,
  adds: [] as Array<{ name: string; opts: Record<string, unknown> }>,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(
      public name: string,
      public opts: { defaultJobOptions?: Record<string, unknown> },
    ) {
      rec.queues.push({ name, opts });
    }
    async getJob() {
      return null;
    }
    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      rec.adds.push({ name, opts });
      return { id: opts.jobId };
    }
  },
}));

const client = await import("../src/queue/canonical-queue-client.js");
const { JOB_NAMES } = await import("@proovra/shared");

beforeEach(() => {
  rec.adds.length = 0;
  delete process.env.QUEUE_FAILED_JOB_RETENTION_COUNT;
});

describe("F-10 failed-job retention on api-enqueued work", () => {
  it("a report job is added with a bounded removeOnFail (default 10000), and the queue default agrees", async () => {
    process.env.REDIS_URL ??= "redis://127.0.0.1:56379";
    const outcome = await client.enqueueCanonicalWork({
      workName: JOB_NAMES.GENERATE_REPORT,
      commandId: "11111111-1111-4111-8111-111111111111",
      traceId: "f-10",
    });
    expect(outcome).toMatchObject({ enqueued: true });
    expect(rec.adds).toHaveLength(1);
    expect(rec.adds[0]!.opts.removeOnFail).toBe(10_000);
    expect(rec.queues.at(-1)!.opts.defaultJobOptions?.removeOnFail).toBe(10_000);
  });

  it("QUEUE_FAILED_JOB_RETENTION_COUNT sets it; a bad value keeps the default", () => {
    expect(client.failedJobRetentionCount({})).toBe(client.DEFAULT_FAILED_JOB_RETENTION_COUNT);
    expect(client.failedJobRetentionCount({ QUEUE_FAILED_JOB_RETENTION_COUNT: "500" })).toBe(500);
    for (const bad of ["0", "-1", "1.5", "all", "2000000"]) {
      expect(client.failedJobRetentionCount({ QUEUE_FAILED_JOB_RETENTION_COUNT: bad })).toBe(10_000);
    }
  });
});
