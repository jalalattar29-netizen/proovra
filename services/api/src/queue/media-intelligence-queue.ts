/**
 * Phase 31.6 — API-side enqueue helper for the media intelligence
 * worker queue.
 *
 * Mirrors the bounded contract from
 * `services/worker/src/queue.ts::enqueueMediaIntelligenceJob`. The
 * API process owns its own BullMQ producer connection — the worker
 * has its own consumer connection — but both target the same Redis
 * stream + the same job id namespace, so duplicate POSTs collapse
 * cleanly.
 *
 * Hard rules:
 *   * Idempotent — repeat triggers for the same (kind, evidenceId)
 *     collapse to the existing queued/active/delayed job.
 *   * Bounded payload — `{ teamId, evidenceId, kind, runId? }`. No
 *     raw evidence content, no storage keys, no GPS, no notes.
 *   * Never throws to the calling route — Redis outages return
 *     `{ enqueued: false, reason: "queue_unavailable" }` so the
 *     route returns 503 + the evidence lifecycle proceeds unchanged.
 *   * Bounded retry config matches the worker side exactly so the
 *     queue declaration is consistent regardless of which process
 *     declares it first.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

import { bump } from "../services/ops/metrics.service.js";

const mediaIntelligenceQueueName = "media-intelligence";
const mediaIntelligenceJobName = "RunMediaIntelligence";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is not set`);
  }
  return v.trim();
}

// Lazy-init the connection so importing this module doesn't fail
// in environments where REDIS_URL is unset (e.g. tests). The
// queue is constructed on first use.
let _queue: Queue | null = null;
function getQueue(): Queue {
  if (_queue) return _queue;
  const redisConnection = new IORedis(must("REDIS_URL"), {
    maxRetriesPerRequest: null,
  });
  _queue = new Queue(mediaIntelligenceQueueName, {
    connection: redisConnection as never,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    },
  });
  return _queue;
}

// =============================================================================
// Bounded vocabulary — mirrors services/worker/src/queue.ts
// =============================================================================

export const MEDIA_INTELLIGENCE_JOB_KINDS = [
  "analyze_metadata",
  // Phase 31.8 — real EXIF extraction (bytes → bounded summary).
  "extract_exif",
  "extract_assets",
  "compute_duplicates",
  "compute_lineage",
  "wire_ocr_transcript",
  "reindex",
  "reconcile",
] as const;

export type MediaIntelligenceJobKind =
  (typeof MEDIA_INTELLIGENCE_JOB_KINDS)[number];

export type MediaIntelligenceJobPayload = {
  teamId: string;
  evidenceId: string;
  kind: MediaIntelligenceJobKind;
  runId?: string | null;
  /** Phase 31.8 — pinned evidence-part target for per-part jobs
   *  (extract_exif, derived asset gen). Optional for evidence-level
   *  jobs (analyze_metadata, reconcile). */
  evidencePartId?: string | null;
};

export function buildMediaIntelligenceJobId(
  kind: MediaIntelligenceJobKind,
  evidenceId: string,
): string {
  return `mi-${kind}-${evidenceId}`;
}

// =============================================================================
// Enqueue
// =============================================================================

export type EnqueueResult =
  | { enqueued: true; jobId: string; reused: false }
  | { enqueued: false; reason: string };

/**
 * Idempotent enqueue. Repeat triggers for the same (kind, evidenceId)
 * return `{ enqueued: false, reason: "job_waiting" | "job_active" | ... }`
 * without creating duplicates.
 *
 * Redis outage → `{ enqueued: false, reason: "queue_unavailable" }`
 * — caller surfaces 503 + falls back to the synchronous analyzer
 * if appropriate.
 */
/**
 * Phase 31.8 — Operator-triggered replay of failed jobs. Walks the
 * `failed` job state of the media-intelligence queue, requeues each
 * one as a NEW attempt-counted job (BullMQ `retry()` API), and bumps
 * the replay counter so SRE dashboards can see operator activity.
 *
 * Bounded: the walk is capped at `maxJobs` (default 50) so a single
 * call can't ballast Redis. Never throws — returns a bounded result.
 *
 * NEVER mutates job payloads, NEVER changes job ids. Each requeue is
 * idempotent with respect to the original (kind, evidenceId) job id.
 */
export async function replayMediaIntelligenceDlq(
  options: { maxJobs?: number } = {},
): Promise<{
  ok: true;
  attempted: number;
  retried: number;
  skipped: number;
} | {
  ok: false;
  reason: string;
}> {
  const maxJobs = Math.max(1, Math.min(options.maxJobs ?? 50, 200));
  let queue: Queue;
  try {
    queue = getQueue();
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
  try {
    const failed = await queue.getFailed(0, maxJobs - 1);
    let retried = 0;
    let skipped = 0;
    for (const job of failed) {
      try {
        await job.retry();
        retried += 1;
      } catch {
        skipped += 1;
      }
    }
    bump("media_intelligence_enqueue_total", retried);
    return {
      ok: true,
      attempted: failed.length,
      retried,
      skipped,
    };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `replay_failed:${err.message.slice(0, 80)}`
          : "replay_failed",
    };
  }
}

/**
 * Phase 31.8 — Operator-triggered single-job retry by job id.
 * Used by the "retry this run" action in the operations UI. Looks
 * up the job by its deterministic id, retries it if it's in the
 * `failed` state. Returns a bounded result.
 */
export async function retryMediaIntelligenceJob(
  jobId: string,
): Promise<
  | { ok: true; retried: true }
  | { ok: false; reason: string }
> {
  let queue: Queue;
  try {
    queue = getQueue();
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, reason: "job_not_found" };
    }
    const state = await job.getState();
    if (state !== "failed") {
      return { ok: false, reason: `job_not_failed:${state}` };
    }
    await job.retry();
    bump("media_intelligence_enqueue_total");
    return { ok: true, retried: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `retry_failed:${err.message.slice(0, 80)}`
          : "retry_failed",
    };
  }
}

export async function enqueueMediaIntelligenceAnalysis(
  payload: MediaIntelligenceJobPayload,
  options: { delayMs?: number } = {},
): Promise<EnqueueResult> {
  const jobId = buildMediaIntelligenceJobId(payload.kind, payload.evidenceId);
  let queue: Queue;
  try {
    queue = getQueue();
  } catch (err) {
    bump("media_intelligence_enqueue_failed_total");
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
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
        // Idempotent collapse — not a failure, but not a new enqueue
        // either. Counted under the success counter so SRE can see
        // total intent-to-enqueue traffic without inflating "failed"
        // by retries the platform deliberately deduplicated.
        bump("media_intelligence_enqueue_total");
        return { enqueued: false, reason: `job_${state}` };
      }
      try {
        await existing.remove();
      } catch {
        // ignore race
      }
    }
    await queue.add(mediaIntelligenceJobName, payload, {
      jobId,
      delay: Math.max(0, options.delayMs ?? 0),
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    });
    bump("media_intelligence_enqueue_total");
    return { enqueued: true, jobId, reused: false };
  } catch (err) {
    bump("media_intelligence_enqueue_failed_total");
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
}
