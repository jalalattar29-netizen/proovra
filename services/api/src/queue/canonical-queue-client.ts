/**
 * PHASE 12 — POINT 5: the api's ONE transport client.
 *
 * Before this module the api carried seven private BullMQ producers
 * (`derived-assets-queue.ts`, `media-intelligence-queue.ts`, `mi-embed-queue.ts`,
 * `graph-reconcile-queue.ts`, `report-queue.ts`, `search-queue.ts`,
 * `redaction-derivative-queue.ts`). Each declared its own queue name, its own
 * job name, its own job-id builder, its own retry policy and its own
 * collapse-or-replace ladder — seven copies of one contract, and they had
 * already drifted: some reported a collapsed enqueue as `enqueued: true` and
 * some as `enqueued: false`, so a caller could not reason about the result
 * across queues.
 *
 * What is left here is TRANSPORT and nothing else:
 *
 *   * a lazily constructed Redis connection, shared by every queue;
 *   * one memoised `Queue` handle per queue name, configured FROM the registry;
 *   * a delegation to the shared `enqueueCanonicalJob`.
 *
 * Queue name, job name, payload shape, payload version, job id and retry
 * policy all come from `@proovra/shared/queue-integrity`. This module cannot
 * express a different answer to any of them, which is the point: the closure
 * gate's "no private queue literal" check is enforceable precisely because
 * there is nowhere left to write one.
 *
 * It never throws into a calling route. A committed durable row plus a Redis
 * outage is a recoverable state — the row stays QUEUED and its reconciler
 * re-enqueues it — whereas a thrown error would fail an authorized mutation
 * whose effect is already persisted.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { context, propagation } from "@opentelemetry/api";
import {
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  type EnqueueOutcome,
  type QueueHandleLike,
  type QueueName,
  type WorkName,
} from "@proovra/shared";

import { bump } from "../services/ops/metrics.service.js";

// ===========================================================================
// Transport
// ===========================================================================

let _connection: IORedis | null = null;

function getConnection(): IORedis {
  if (_connection) return _connection;
  const url = process.env.REDIS_URL;
  if (!url || !url.trim()) {
    // Thrown, not returned: the caller below catches it and reports
    // `queue_unavailable`. Importing this module without REDIS_URL stays safe,
    // which the api's unit tests rely on.
    throw new Error("REDIS_URL is not set");
  }
  _connection = new IORedis(url.trim(), { maxRetriesPerRequest: null });
  return _connection;
}

const _queues = new Map<string, Queue>();

/**
 * The BullMQ handle for a queue, configured from the registry entry that owns
 * it. Two work names that share a queue share the handle.
 */
function getQueue(queueName: QueueName, workName: WorkName): Queue {
  const existing = _queues.get(queueName);
  if (existing) return existing;
  const entry = getWorkEntryOrThrow(workName);
  const queue = new Queue(queueName, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: entry.retry.attempts,
      backoff: {
        type: entry.retry.backoff,
        delay: entry.retry.backoffDelayMs,
      },
      removeOnComplete: 100,
      removeOnFail: false,
    },
  });
  _queues.set(queueName, queue);
  return queue;
}

/**
 * The W3C traceparent of the active span, or null.
 *
 * Read here rather than inside `@proovra/shared` so the shared package carries
 * no OpenTelemetry dependency. Propagating it keeps an api request and its
 * worker handler in ONE distributed trace — the capability the pre-Point-5
 * `_otel` job-data blob provided, preserved through a bounded, validated
 * envelope field instead of an unbounded metadata bag.
 */
function currentTraceparent(): string | null {
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier.traceparent ?? null;
  } catch {
    return null;
  }
}

// ===========================================================================
// The one enqueue entry point
// ===========================================================================

export type CanonicalEnqueueInput = {
  /** Registered BullMQ job name. Anything else is refused by the registry. */
  workName: WorkName;
  /**
   * The durable authority row's id. This is the ONLY thing that goes on the
   * wire besides trace metadata, and the processor re-derives every other fact
   * from the row it names.
   */
  commandId: string;
  /** Bounded free-text reason, for logs. Never authority. */
  traceId?: string | null;
  delayMs?: number;
};

/**
 * Enqueue a registered unit of work.
 *
 * Returns the shared `EnqueueOutcome` verbatim so every api producer reports
 * collapse, failure and success identically — the drift this module exists to
 * end.
 */
export async function enqueueCanonicalWork(
  input: CanonicalEnqueueInput,
): Promise<EnqueueOutcome> {
  let entry: ReturnType<typeof getWorkEntryOrThrow>;
  try {
    entry = getWorkEntryOrThrow(input.workName);
  } catch {
    return { enqueued: false, reason: "unregistered_work_name" };
  }
  if (!entry.queueName || entry.transport !== "bullmq") {
    return { enqueued: false, reason: "not_a_queue_job" };
  }

  let queue: Queue;
  try {
    queue = getQueue(entry.queueName, input.workName);
  } catch (err) {
    bump("canonical_enqueue_failed_total");
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
    entry,
    commandId: input.commandId,
    traceId: input.traceId ?? "",
    delayMs: input.delayMs,
    traceparent: currentTraceparent(),
  });

  bump(
    outcome.enqueued ? "canonical_enqueue_total" : "canonical_enqueue_failed_total",
  );
  return outcome;
}

/**
 * Read-only queue handle for the operator projection.
 *
 * Exposed so the operations surface can count jobs by state without opening a
 * second Redis connection or re-declaring a queue with different options — a
 * second declaration is how two processes end up disagreeing about a queue's
 * retry policy.
 */
export function getReadOnlyQueueHandle(
  queueName: QueueName,
  workName: WorkName,
): Queue | null {
  try {
    return getQueue(queueName, workName);
  } catch {
    return null;
  }
}

/** Test seam: drop memoised handles so a suite can swap REDIS_URL. */
export function __resetCanonicalQueueClientForTests(): void {
  _queues.clear();
  _connection = null;
}
