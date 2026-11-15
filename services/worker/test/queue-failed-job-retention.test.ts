/**
 * F-10 (Free-user audit of 4d9b78963) — the worker's own queues keep failed
 * jobs to a bound, as the api's canonical queue client does.
 *
 * Redis runs `noeviction` with no `maxmemory`; a failed set kept for ever grows
 * until every Redis write — the shared rate limiters included — fails. The api
 * already passes QUEUE_FAILED_JOB_RETENTION_COUNT (default 10000) on every job
 * it enqueues; the worker's queues defaulted to `removeOnFail: false` and its
 * own enqueue path passed nothing, so a job the worker scheduled (a reconciler
 * re-enqueue, a self follow-up) was kept for ever. One rule now lives in
 * @proovra/shared (`parseFailedJobRetentionCount`); the operator DLQ sinks are
 * not governed by it (their entries wait for triage by design).
 *
 * Only the BullMQ Queue is faked — the worker's queue module and the shared
 * enqueue policy run for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FAILED_JOB_RETENTION_COUNT, REDACTION_DERIVATIVE_QUEUE_NAME } from "@proovra/shared";

type JobOpts = { jobId?: string; removeOnFail?: number | boolean };

const H = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; opts: { defaultJobOptions?: { removeOnFail?: number | boolean } } }>,
  added: [] as Array<{ queue: string; name: string; opts?: JobOpts }>,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    name: string;
    constructor(name: string, opts: { defaultJobOptions?: { removeOnFail?: number | boolean } }) {
      this.name = name;
      H.queues.push({ name, opts });
    }
    async getJob() {
      return null;
    }
    async add(name: string, _payload: unknown, opts?: JobOpts) {
      H.added.push({ queue: this.name, name, opts });
      return { id: opts?.jobId };
    }
    async close() {}
  },
  Worker: class {},
  QueueEvents: class {},
}));

vi.mock("ioredis", () => ({
  default: class {
    on() {}
    async quit() {}
  },
}));

// Process configuration is an environment boundary, not behavior under test.
vi.mock("../src/config.js", () => ({
  env: { REDIS_URL: "redis://localhost:6379" },
}));

const queueModule = await import("../src/queue.js");

beforeEach(() => {
  H.added = [];
  delete process.env.QUEUE_FAILED_JOB_RETENTION_COUNT;
});

describe("F-10 — worker failed-job retention", () => {
  it("every registered work queue keeps a bounded number of failed jobs; the DLQ sinks are unchanged", () => {
    const work = H.queues.filter((q) => !/dlq/i.test(q.name));
    const dlq = H.queues.filter((q) => /dlq/i.test(q.name));
    expect(work.length).toBeGreaterThan(0);
    for (const q of work) {
      const keep = q.opts.defaultJobOptions?.removeOnFail;
      // A queue that states its own bound (e.g. 200) keeps it; none keeps every failure.
      expect(keep, q.name).not.toBe(false);
      expect(typeof keep, q.name).toBe("number");
    }
    expect(H.queues.find((q) => q.name === "report" || /report$/.test(q.name))?.opts.defaultJobOptions?.removeOnFail).toBe(
      DEFAULT_FAILED_JOB_RETENTION_COUNT,
    );
    // DLQ sinks keep what they declare (report DLQ: every entry; media DLQ: 200) — never the new work-queue default.
    for (const q of dlq) expect([false, 200], q.name).toContain(q.opts.defaultJobOptions?.removeOnFail);
  });

  it("a job the worker enqueues itself carries the bound (the shared enqueue would otherwise pass false)", async () => {
    process.env.QUEUE_FAILED_JOB_RETENTION_COUNT = "500";
    await queueModule.enqueueRedactionDerivativeRenderWorker({ derivativeId: "11111111-1111-4111-8111-111111111111" });
    const add = H.added.find((a) => a.queue === REDACTION_DERIVATIVE_QUEUE_NAME);
    expect(add?.opts?.removeOnFail).toBe(500);
  });

  it("the bound reads the same env and rule as the api", () => {
    expect(queueModule.workerFailedJobRetentionCount()).toBe(DEFAULT_FAILED_JOB_RETENTION_COUNT);
    process.env.QUEUE_FAILED_JOB_RETENTION_COUNT = "abc";
    expect(queueModule.workerFailedJobRetentionCount()).toBe(DEFAULT_FAILED_JOB_RETENTION_COUNT);
    process.env.QUEUE_FAILED_JOB_RETENTION_COUNT = "42";
    expect(queueModule.workerFailedJobRetentionCount()).toBe(42);
  });
});
