/**
 * PHASE 12B WAVE 2A — API-side transport client for the dedicated
 * `redaction-derivative` BullMQ queue.
 *
 * PHASE 12 POINT 5 — this module no longer owns an enqueue POLICY. Queue name,
 * job name, job id, payload shape, payload version, retry policy and the
 * collapse-or-replace rules all live in `@proovra/shared/queue-integrity`, and
 * both the api and the worker call the SAME `enqueueCanonicalJob`. Before this,
 * the api and the worker each carried their own copy of that policy — two
 * copies of a queue contract that had already drifted once (the worker's
 * reconciler learned about retained-job id collisions months after the api
 * path did). All that remains here is the Redis handle and the metrics.
 *
 * Durability contract (unchanged):
 *   - The derivative row is committed in state QUEUED BEFORE enqueue.
 *   - The payload carries ONLY { commandId, traceId, schemaVersion } — no
 *     tenant, policy, storage or authorization truth. The WORKER reloads
 *     everything from persistence and atomically claims QUEUED→RENDERING.
 *   - Redis outage → { enqueued:false, reason } — the row stays QUEUED
 *     (recoverable + observable); the worker-side stranded-QUEUED reconciler
 *     re-enqueues it. Queue-success/DB-failure cannot happen (DB commits
 *     first); DB-success/queue-failure is recovered by the reconciler.
 *   - Never throws to the calling route.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  JOB_NAMES,
  REDACTION_DERIVATIVE_JOB_NAME,
  REDACTION_DERIVATIVE_QUEUE_NAME,
  buildRedactionDerivativeJobId,
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  isLiveRedactionJobState,
  type QueueHandleLike,
  type RedactionDerivativeJobPayload,
} from "@proovra/shared";

import { bump } from "../services/ops/metrics.service.js";

export const redactionDerivativeQueueName = REDACTION_DERIVATIVE_QUEUE_NAME;
export const redactionDerivativeJobName = REDACTION_DERIVATIVE_JOB_NAME;
export { buildRedactionDerivativeJobId, isLiveRedactionJobState };
export type { RedactionDerivativeJobPayload };

const REGISTRY_ENTRY = getWorkEntryOrThrow(
  JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
);

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

let _queue: Queue | null = null;
function getQueue(): Queue {
  if (_queue) return _queue;
  const redisConnection = new IORedis(must("REDIS_URL"), {
    maxRetriesPerRequest: null,
  });
  _queue = new Queue(redactionDerivativeQueueName, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: REGISTRY_ENTRY.retry.attempts,
      backoff: {
        type: REGISTRY_ENTRY.retry.backoff,
        delay: REGISTRY_ENTRY.retry.backoffDelayMs,
      },
      removeOnComplete: 100,
      removeOnFail: false,
    },
  });
  return _queue;
}

export type RedactionEnqueueResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string };

/**
 * Idempotent enqueue. A live job for the same derivative collapses; a spent
 * (completed/failed) job has its id released so a re-request after failure
 * re-renders. Redis outage returns { enqueued:false } — never throws.
 */
export async function enqueueRedactionDerivativeRender(input: {
  derivativeId: string;
  traceId?: string | null;
}): Promise<RedactionEnqueueResult> {
  let queue: Queue;
  try {
    queue = getQueue();
  } catch (err) {
    bump("redaction_derivative_enqueue_failed_total");
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }

  const outcome = await enqueueCanonicalJob({
    queue: queue as unknown as QueueHandleLike,
    entry: REGISTRY_ENTRY,
    commandId: input.derivativeId,
    traceId: input.traceId ?? "",
  });

  if (outcome.enqueued) {
    bump("redaction_derivative_enqueue_total");
    return { enqueued: true, jobId: outcome.jobId };
  }
  bump("redaction_derivative_enqueue_failed_total");
  return { enqueued: false, reason: outcome.reason };
}
