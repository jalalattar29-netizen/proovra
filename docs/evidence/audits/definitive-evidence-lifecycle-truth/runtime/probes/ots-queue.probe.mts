/**
 * RUNTIME PROBE RT-OTS-QUEUE — audit-only; real BullMQ on a DISPOSABLE loopback
 * Redis (ET_REDIS_URL, must be 127.0.0.1). No database, no calendar.
 *
 * Claims under test:
 *   OTS-01  the init branch (ots-upgrade.processor.ts:351) enqueues the follow-up
 *           WITHOUT selfJobId, so enqueueCanonicalJob collapses onto the running
 *           job and schedules nothing.
 *   OTS-02  with selfJobId, the follow-up id `<base>-next-<...>` is deterministic;
 *           on the third hop it equals a retained completed job and BullMQ
 *           ignores the add while the caller is told `enqueued: true`.
 *
 * The production function (enqueueCanonicalJob) and the production registry
 * entry for UPGRADE_OTS are used unmodified; only the processor body is the
 * probe's own, and it does exactly what ots-upgrade.processor.ts does at the two
 * cited call sites: call the enqueue from inside the running job.
 *
 * Run: node_modules/.bin/tsx <this file> <results.json>   (cwd services/worker)
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createRequire } from "node:module";

// bullmq/ioredis are the WORKER's own dependencies; resolve them from there so
// the probe exercises the exact versions production runs.
const workerRequire = createRequire(new URL("../../../../../../services/worker/package.json", import.meta.url));
const { Queue, Worker } = workerRequire("bullmq") as typeof import("bullmq");
const IORedis = workerRequire("ioredis") as typeof import("ioredis").default;
type Job = import("bullmq").Job;
// The worker imports the queue-integrity authority from the BUILT @proovra/shared
// package (services/worker/src/queue.ts:30-45); load it the same way.
const { enqueueCanonicalJob, getWorkEntryOrThrow, JOB_NAMES } = workerRequire("@proovra/shared") as any;


const url = process.env.ET_REDIS_URL ?? "";
if (!/^redis:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("ET_REDIS_URL must be a loopback redis URL");
const out = process.argv[2];
const entry = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scenario(label: string, passSelfJobId: boolean, maxHops: number) {
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const queueName = `et-probe-${label}-${randomUUID().slice(0, 8)}`;
  const queue = new Queue(queueName, { connection });
  const evidenceId = randomUUID();
  const hops: Array<{ hop: number; runningJobId: string; enqueue: unknown }> = [];
  let hop = 0;
  const worker = new Worker(
    queueName,
    async (job: Job) => {
      hop += 1;
      const outcome = await enqueueCanonicalJob({
        queue: queue as never,
        entry,
        commandId: evidenceId,
        traceId: "",
        delayMs: 50,
        selfJobId: passSelfJobId ? job.id : undefined,
      });
      hops.push({ hop, runningJobId: String(job.id), enqueue: outcome });
    },
    { connection: new IORedis(url, { maxRetriesPerRequest: null }), concurrency: 1 },
  );
  const first = await enqueueCanonicalJob({ queue: queue as never, entry, commandId: evidenceId, traceId: "", delayMs: 0 });
  // Let the ladder run; each hop is ~50ms delay + processing.
  for (let i = 0; i < 60 && hop < maxHops; i++) await sleep(100);
  await sleep(500);
  const counts = await queue.getJobCounts("waiting", "delayed", "active", "completed", "failed");
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
  return { label, passSelfJobId, firstEnqueue: first, hopsProcessed: hop, hops, finalCounts: counts, stillScheduled: counts.waiting + counts.delayed + counts.active };
}

const init = await scenario("init-no-selfjobid", false, 3);
const ladder = await scenario("ladder-with-selfjobid", true, 6);
const lastClaim = ladder.hops.at(-1)?.enqueue as { enqueued?: boolean } | undefined;
const result = {
  probe: "RT-OTS-QUEUE",
  registryEntry: { workName: entry.workName, jobIdPrefix: entry.jobIdPrefix },
  scenarios: [init, ladder],
  verdict: {
    "OTS-01": init.hopsProcessed === 1 && init.stillScheduled === 0 ? "DEFECT_REPRODUCED" : "NOT_REPRODUCED",
    "OTS-02": ladder.hopsProcessed < 6 && ladder.stillScheduled === 0 && lastClaim?.enqueued === true ? `DEFECT_REPRODUCED (ladder stopped after ${ladder.hopsProcessed} hops while the last enqueue reported enqueued:true)` : `NOT_REPRODUCED (hops ${ladder.hopsProcessed})`,
  },
};
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result.verdict));
process.exit(0);
