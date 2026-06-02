/**
 * Phase 16 — API-side enqueue helper for the mi-embed worker queue.
 *
 * The worker side declares `miEmbedQueue` in
 * `services/worker/src/queue.ts`. The API process owns its own
 * BullMQ producer connection — both ends target the same Redis
 * stream + the same job-id namespace so duplicate triggers collapse.
 *
 * Hard rules (mirror the search-indexing queue helper exactly):
 *   - Never throws to the calling flow. A missing REDIS_URL or
 *     transient outage returns `{ enqueued: false, reason: ... }`
 *     so the producer (semantic.service.ts) can swallow the failure
 *     and let the worker-side safety-net backfill catch the drift.
 *   - Idempotent — repeat enqueues for the same first-chunk-id
 *     collapse to the existing job (deterministic jobId).
 *   - Workspace-scoped — every payload carries `teamId`. The
 *     processor enforces team membership on every chunk it loads.
 *   - Bounded payload — at most 200 chunkIds per job so the worker's
 *     wall-clock budget per attempt stays predictable.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

import { bump } from "../services/ops/metrics.service.js";

const miEmbedQueueName = "mi-embed";
const miEmbedJobName = "EmbedSemanticChunks";

export type EnqueueMiEmbedInput = {
  teamId: string;
  chunkIds: string[];
  /** Bounded catalog. e.g. "live_indexing", "backfill_script". */
  reason: string;
  delayMs?: number;
};

let lazyQueue: Queue | null = null;
let queueConstructFailed = false;

function getQueue(): Queue | null {
  if (queueConstructFailed) return null;
  if (lazyQueue) return lazyQueue;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    queueConstructFailed = true;
    return null;
  }
  try {
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    lazyQueue = new Queue(miEmbedQueueName, {
      connection: connection as never,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
    return lazyQueue;
  } catch {
    queueConstructFailed = true;
    return null;
  }
}

function buildJobId(firstChunkId: string): string {
  return `mi-embed-${firstChunkId}`;
}

/**
 * Best-effort async enqueue. The caller MUST NOT block on this — the
 * safety-net backfill inside `search-indexing.processor.ts` exists
 * precisely so a failed enqueue cannot leave chunks permanently
 * un-embedded.
 */
export async function enqueueEmbedChunks(
  input: EnqueueMiEmbedInput,
): Promise<
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string }
> {
  if (!input.teamId || !input.chunkIds || input.chunkIds.length === 0) {
    return { enqueued: false, reason: "empty_payload" };
  }
  const bounded = input.chunkIds.slice(0, 200);
  const queue = getQueue();
  if (!queue) {
    bump("semantic_embed_enqueue_failed_total");
    return { enqueued: false, reason: "queue_unavailable" };
  }
  const jobId = buildJobId(bounded[0]);
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (
        state === "waiting" ||
        state === "delayed" ||
        state === "active" ||
        state === "prioritized"
      ) {
        return { enqueued: false, reason: `job_${state}` };
      }
      try {
        await existing.remove();
      } catch {
        // ignore race
      }
    }
    await queue.add(
      miEmbedJobName,
      {
        teamId: input.teamId,
        chunkIds: bounded,
        reason: input.reason.slice(0, 64),
      },
      {
        jobId,
        delay: Math.max(0, input.delayMs ?? 0),
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
    bump("semantic_embed_enqueued_total");
    return { enqueued: true, jobId };
  } catch (err) {
    bump("semantic_embed_enqueue_failed_total");
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
}
