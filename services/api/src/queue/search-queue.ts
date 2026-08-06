/**
 * Phase 24-J — API-side transport client for the `search-indexing` queue.
 *
 * The Phase 24 base service indexes search documents INLINE on every
 * source-row mutation. That's correct for small workloads; an enterprise
 * corpus needs async indexing so heavy rebuilds (e.g.
 * legal-hold-placed-across-a-thousand-records) don't block the API.
 *
 * PHASE 12 POINT 5 — the queue name, job name, document-kind catalog, job id
 * and enqueue policy are no longer declared here. They live in
 * `@proovra/shared/queue-integrity` and the worker imports the SAME
 * definitions. This module keeps only the lazy Redis handle and the metrics.
 *
 * Hard contracts:
 *   - Never throws. A failed enqueue returns `{ enqueued: false, reason }` so
 *     the caller can fall back to the inline-indexing path without breaking
 *     the mutation flow.
 *   - Idempotent — repeat enqueues for the same `(kind, sourceId)` collapse to
 *     the existing job via a deterministic jobId.
 *   - Connection is lazy + bounded — a missing `REDIS_URL` returns a soft
 *     failure rather than crashing the API on import.
 *   - The payload carries `{ commandId, traceId, schemaVersion }` and nothing
 *     else. `commandId` is `<kind>:<sourceId>`; the worker derives the tenant
 *     by loading that source row.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  JOB_NAMES,
  QUEUE_NAMES,
  buildSearchIndexCommandId,
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  type QueueHandleLike,
  type SearchIndexDocumentKind,
} from "@proovra/shared";

import { bump } from "../services/ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";

const REGISTRY_ENTRY = getWorkEntryOrThrow(
  JOB_NAMES.REBUILD_SEARCH_DOCUMENT,
);

export type { SearchIndexDocumentKind };
/** @deprecated Use `SearchIndexDocumentKind` from `@proovra/shared`. */
export type SearchIndexingDocumentKind = SearchIndexDocumentKind;

export type EnqueueSearchIndexingInput = {
  /**
   * Retained on the INPUT (not on the payload) so the caller's security-event
   * emission stays workspace-attributed. It is never serialised into the job.
   */
  teamId: string;
  kind: SearchIndexDocumentKind;
  sourceId: string;
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
    lazyQueue = new Queue(QUEUE_NAMES.SEARCH_INDEXING, {
      connection,
      defaultJobOptions: {
        attempts: REGISTRY_ENTRY.retry.attempts,
        backoff: {
          type: REGISTRY_ENTRY.retry.backoff,
          delay: REGISTRY_ENTRY.retry.backoffDelayMs,
        },
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

/**
 * Best-effort async enqueue of a Discovery index rebuild. The caller MUST still
 * call the inline indexing path if it cannot tolerate stale search documents —
 * this helper is intentionally fire-and-forget.
 */
export async function enqueueSearchIndexingJob(
  input: EnqueueSearchIndexingInput,
): Promise<
  { enqueued: true; jobId: string } | { enqueued: false; reason: string }
> {
  const queue = getQueue();
  if (!queue) {
    bump("search_indexing_enqueue_failed_total");
    return { enqueued: false, reason: "queue_unavailable" };
  }

  let commandId: string;
  try {
    commandId = buildSearchIndexCommandId(input.kind, input.sourceId);
  } catch {
    // An unknown kind now fails HERE, at the producer, instead of being
    // accepted and silently discarded by the processor.
    bump("search_indexing_enqueue_failed_total");
    return { enqueued: false, reason: "unknown_document_kind" };
  }

  const outcome = await enqueueCanonicalJob({
    queue: queue as unknown as QueueHandleLike,
    entry: REGISTRY_ENTRY,
    commandId,
    traceId: input.reason.slice(0, 64),
    delayMs: input.delayMs,
    removeOnComplete: 200,
    removeOnFail: 200,
  });

  if (outcome.enqueued) {
    bump("search_indexing_enqueued_total");
    return { enqueued: true, jobId: outcome.jobId };
  }

  bump("search_indexing_enqueue_failed_total");
  if (outcome.reason.startsWith("queue_unavailable")) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "search_indexing_enqueue_failed",
      severity: "WARNING",
      details: { kind: input.kind, reason: outcome.reason },
    });
  }
  return { enqueued: false, reason: outcome.reason };
}
