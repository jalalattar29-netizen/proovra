/**
 * Phase 24-J — API-side search indexing queue helper.
 *
 * The Phase 24 base service indexes search documents INLINE on every
 * source-row mutation. That's correct for small workloads; an
 * enterprise corpus needs async indexing so heavy rebuilds (e.g.
 * legal-hold-placed-across-thousand-records) don't block the API.
 *
 * This module is the API side of the BullMQ queue declared in
 * `services/worker/src/queue.ts` (`searchIndexingQueue`). The API does
 * NOT import worker code — both ends own their own Queue handle.
 *
 * Hard contracts:
 *   - Never throws. A failed enqueue returns
 *     `{ enqueued: false, reason: ... }` so the caller can fall back
 *     to the existing inline-indexing path without breaking the
 *     mutation flow.
 *   - Idempotent — repeat enqueues for the same `(kind, sourceId)`
 *     collapse to the existing job via a deterministic jobId.
 *   - Connection is lazy + bounded — a missing `REDIS_URL` returns a
 *     soft failure rather than crashing the API on import.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { bump } from "../services/ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
const searchIndexingQueueName = "search-indexing";
const searchIndexingJobName = "RebuildSearchDocument";
let lazyQueue = null;
let queueConstructFailed = false;
function getQueue() {
    if (queueConstructFailed)
        return null;
    if (lazyQueue)
        return lazyQueue;
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        queueConstructFailed = true;
        return null;
    }
    try {
        const connection = new IORedis(url, { maxRetriesPerRequest: null });
        lazyQueue = new Queue(searchIndexingQueueName, {
            connection: connection,
            defaultJobOptions: {
                attempts: 5,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: 200,
                removeOnFail: 200,
            },
        });
        return lazyQueue;
    }
    catch {
        queueConstructFailed = true;
        return null;
    }
}
function buildJobId(kind, sourceId) {
    return `search-index-${kind}-${sourceId}`;
}
/**
 * Best-effort async enqueue of a Discovery index rebuild. The caller
 * MUST still call the inline indexing path if it cannot tolerate stale
 * search documents — this helper is intentionally fire-and-forget.
 */
export async function enqueueSearchIndexingJob(input) {
    const queue = getQueue();
    if (!queue) {
        bump("search_indexing_enqueue_failed_total");
        return { enqueued: false, reason: "queue_unavailable" };
    }
    const jobId = buildJobId(input.kind, input.sourceId);
    try {
        const existing = await queue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();
            if (state === "waiting" ||
                state === "delayed" ||
                state === "active" ||
                state === "prioritized") {
                return { enqueued: false, reason: `job_${state}` };
            }
            try {
                await existing.remove();
            }
            catch {
                // ignore race
            }
        }
        await queue.add(searchIndexingJobName, {
            teamId: input.teamId,
            kind: input.kind,
            sourceId: input.sourceId,
            reason: input.reason.slice(0, 64),
        }, {
            jobId,
            delay: Math.max(0, input.delayMs ?? 0),
            attempts: 5,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: 200,
            removeOnFail: 200,
        });
        bump("search_indexing_enqueued_total");
        return { enqueued: true, jobId };
    }
    catch (err) {
        bump("search_indexing_enqueue_failed_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_indexing_enqueue_failed",
            severity: "WARNING",
            details: {
                kind: input.kind,
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
        return {
            enqueued: false,
            reason: err instanceof Error
                ? `queue_unavailable:${err.message.slice(0, 80)}`
                : "queue_unavailable",
        };
    }
}
