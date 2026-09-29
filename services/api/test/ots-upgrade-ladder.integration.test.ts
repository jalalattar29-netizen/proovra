/**
 * ET-OTS-01 / ET-OTS-02 — the OTS upgrade ladder on REAL BullMQ (the harness's
 * loopback Redis), driving the production `enqueueCanonicalJob` and the
 * production UPGRADE_OTS registry entry from inside a running job, exactly as
 * ots-upgrade.processor.ts does at its two call sites.
 *
 * Both cases failed on a40ca76f (audit runtime proof RT-OTS-QUEUE):
 *   - without selfJobId the follow-up collapsed onto the running job (1 hop);
 *   - with selfJobId the ladder died on the third hop while every enqueue
 *     reported `enqueued: true`.
 */
import { randomUUID } from "node:crypto";

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { describe, expect, it } from "vitest";

import { JOB_NAMES, enqueueCanonicalJob, getWorkEntryOrThrow } from "@proovra/shared";

const url = process.env.REDIS_URL ?? "";
const entry = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runLadder(hopsWanted: number, passSelfJobId: boolean) {
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const workerConnection = new IORedis(url, { maxRetriesPerRequest: null });
  const queue = new Queue(`ots-ladder-${randomUUID().slice(0, 8)}`, { connection });
  const evidenceId = randomUUID();
  const outcomes: Array<{ enqueued: boolean; collapsed?: boolean }> = [];
  let hops = 0;
  const worker = new Worker(
    queue.name,
    async (job: Job) => {
      hops += 1;
      if (hops >= hopsWanted) return;
      outcomes.push(
        (await enqueueCanonicalJob({
          queue: queue as never,
          entry,
          commandId: evidenceId,
          traceId: "",
          delayMs: 30,
          selfJobId: passSelfJobId ? job.id : undefined,
        })) as { enqueued: boolean; collapsed?: boolean },
      );
    },
    { connection: workerConnection, concurrency: 1 },
  );
  try {
    await enqueueCanonicalJob({ queue: queue as never, entry, commandId: evidenceId, traceId: "", delayMs: 0 });
    for (let i = 0; i < 100 && hops < hopsWanted; i++) await sleep(100);
    return { hops, outcomes };
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await workerConnection.quit();
  }
}

describe("OTS upgrade ladder on real BullMQ (loopback Redis)", () => {
  it("ET-OTS-02: a self-rescheduling ladder runs every hop; no enqueue is silently dropped", async () => {
    expect(url).toMatch(/^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?/);
    const { hops, outcomes } = await runLadder(8, true);
    expect(hops).toBe(8);
    expect(outcomes.every((o) => o.enqueued === true && o.collapsed === false)).toBe(true);
  }, 30_000);

  it("ET-OTS-01 contract: inside the running job, omitting selfJobId collapses and schedules nothing", async () => {
    // This is the defect's mechanism, kept as a contract so the processor's
    // obligation to pass selfJobId stays visible (see the source guard below).
    const { hops, outcomes } = await runLadder(3, false);
    expect(hops).toBe(1);
    expect(outcomes).toEqual([expect.objectContaining({ enqueued: true, collapsed: true })]);
  }, 30_000);
});
