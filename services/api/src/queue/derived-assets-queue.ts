/**
 * Phase 31.13 — API-side enqueue helper for the dedicated
 * `mi-derived-assets` BullMQ queue.
 *
 * This is the FIRST dedicated queue split out from the original
 * `media-intelligence` queue (which still handles analyze_metadata
 * / extract_exif / reserved kinds). The split closes the first 1 of
 * 9 isolated-queues from the brief's Part 1 and establishes the
 * pattern for the remaining 8 (mi-ocr, mi-transcript, etc.).
 *
 * Hard rules:
 *   * Lazy-init Redis — importing this module without REDIS_URL is
 *     safe (tests rely on it).
 *   * Idempotent — repeat triggers for the same evidence_part_id +
 *     asset_kind collapse to the existing waiting/active/delayed
 *     job.
 *   * Bounded payload — { teamId, evidenceId, evidencePartId,
 *     assetKind }. NEVER carries storage keys, signed URLs, or raw
 *     evidence content.
 *   * Never throws to the calling route — Redis outages return
 *     { enqueued: false, reason: "queue_unavailable" }.
 *   * Per-queue retry policy (attempts: 3, exponential 10s backoff).
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

import { bump } from "../services/ops/metrics.service.js";

const derivedAssetsQueueName = "mi-derived-assets";
const derivedAssetsJobName = "GenerateDerivedAsset";

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is not set`);
  }
  return v.trim();
}

let _queue: Queue | null = null;
function getQueue(): Queue {
  if (_queue) return _queue;
  const redisConnection = new IORedis(must("REDIS_URL"), {
    maxRetriesPerRequest: null,
  });
  _queue = new Queue(derivedAssetsQueueName, {
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

export const DERIVED_ASSET_KINDS = [
  "image_thumbnail",
  // Reserved for future phases — payload accepted but worker emits
  // UNSUPPORTED until ffmpeg is wired up.
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
  "compact_review_preview",
] as const;

export type DerivedAssetKind = (typeof DERIVED_ASSET_KINDS)[number];

export type DerivedAssetJobPayload = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetKind;
};

export function buildDerivedAssetJobId(
  evidencePartId: string,
  assetKind: DerivedAssetKind,
): string {
  return `da-${assetKind}-${evidencePartId}`;
}

export type DerivedAssetEnqueueResult =
  | { enqueued: true; jobId: string; reused: false }
  | { enqueued: false; reason: string };

/**
 * Idempotent enqueue. Repeat triggers for the same (assetKind,
 * evidencePartId) collapse onto an existing waiting/active/delayed
 * job. Redis outage → `{ enqueued: false, reason: ... }`.
 */
export async function enqueueDerivedAssetGeneration(
  payload: DerivedAssetJobPayload,
): Promise<DerivedAssetEnqueueResult> {
  const jobId = buildDerivedAssetJobId(payload.evidencePartId, payload.assetKind);
  let queue: Queue;
  try {
    queue = getQueue();
  } catch (err) {
    bump("derived_assets_enqueue_failed_total");
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
        bump("derived_assets_enqueue_total");
        return { enqueued: false, reason: `job_${state}` };
      }
      try {
        await existing.remove();
      } catch {
        /* ignore race */
      }
    }
    await queue.add(derivedAssetsJobName, payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    });
    bump("derived_assets_enqueue_total");
    return { enqueued: true, jobId, reused: false };
  } catch (err) {
    bump("derived_assets_enqueue_failed_total");
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
}

/**
 * Phase 31.13 — Operator-triggered single-job retry. Used by the
 * /ops/media-graph retry surface for derived-asset failures.
 */
export async function retryDerivedAssetJob(
  jobId: string,
): Promise<
  { ok: true; retried: true } | { ok: false; reason: string }
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
    if (!job) return { ok: false, reason: "job_not_found" };
    const state = await job.getState();
    if (state !== "failed") {
      return { ok: false, reason: `job_not_failed:${state}` };
    }
    await job.retry();
    bump("derived_assets_enqueue_total");
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
