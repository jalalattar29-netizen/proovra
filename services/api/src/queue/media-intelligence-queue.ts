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

import type { Queue } from "bullmq";
import {
  JOB_NAMES,
  MEDIA_INTELLIGENCE_JOB_KINDS as SHARED_MI_KINDS,
  QUEUE_NAMES,
  isMediaIntelligenceJobKind,
  type MediaIntelligenceJobKind,
} from "@proovra/shared";

import { bump } from "../services/ops/metrics.service.js";
import {
  enqueueCanonicalWork,
  getReadOnlyQueueHandle,
} from "./canonical-queue-client.js";

/**
 * PHASE 12 — POINT 5. Queue name, job name, job id and retry policy come from
 * the registry, and the Redis handle comes from the shared transport client.
 * This module's private copies of all five are deleted.
 *
 * What is left is the OPERATOR surface: DLQ replay and single-job retry, which
 * genuinely need a queue handle because they act on jobs rather than creating
 * them.
 */
function getQueue(): Queue | null {
  return getReadOnlyQueueHandle(
    QUEUE_NAMES.MEDIA_INTELLIGENCE,
    JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
  );
}

// =============================================================================
// Bounded vocabulary — mirrors services/worker/src/queue.ts
// =============================================================================

/**
 * PHASE 12 — POINT 5. The bounded kind catalog is re-exported from the shared
 * registry rather than declared here. It had drifted before: this file listed
 * kinds the worker did not implement, and the worker implemented kinds this
 * file did not list, so a producer could enqueue work that was silently
 * discarded.
 */
export const MEDIA_INTELLIGENCE_JOB_KINDS = SHARED_MI_KINDS;

export type { MediaIntelligenceJobKind };

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

// `buildMediaIntelligenceJobId` is DELETED. The job id is now `mi-run-<runId>`,
// built by `buildCanonicalJobId` from the registry prefix, so the id names the
// durable row rather than re-encoding two payload fields.

// =============================================================================
// Enqueue
// =============================================================================

export type EnqueueResult =
  | {
      enqueued: true;
      jobId: string;
      /** True when the enqueue collapsed onto a job that was already live. */
      reused: boolean;
    }
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
  const queue = getQueue();
  if (!queue) return { ok: false, reason: "queue_unavailable" };
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
  const queue = getQueue();
  if (!queue) return { ok: false, reason: "queue_unavailable" };
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

/**
 * PHASE 12 — POINT 5.
 *
 * The old signature took `{ teamId, evidenceId, kind, runId? }` and put all
 * four on the wire. Two things were wrong with that beyond the tenancy:
 *
 *   * `runId` was OPTIONAL. `evidence-finalization-fanout.service.ts` called
 *     this with no run id at all, so the processor had no row to record
 *     PROCESSING / COMPLETED / FAILED on. Those jobs ran and left no trace an
 *     operator could see, and no reconciler could recover them because there
 *     was nothing to find.
 *
 *   * `kind` selected which extraction ran — and therefore which AI provider
 *     was called and which budget was spent — off an unverified message field.
 *
 * The run row is now MANDATORY and is created here before the enqueue. It
 * carries the workspace, the evidence and the kind, so the queue carries only
 * its id.
 */
export async function enqueueMediaIntelligenceAnalysis(
  payload: MediaIntelligenceJobPayload,
  options: { delayMs?: number } = {},
): Promise<EnqueueResult> {
  if (!isMediaIntelligenceJobKind(payload.kind)) {
    return { enqueued: false, reason: "unknown_media_intelligence_kind" };
  }

  // The durable authority. `idempotencyKey` collapses repeat intent for the
  // same (kind, evidence) into one run row; the deterministic job id then
  // collapses the two enqueues onto one job.
  let runId = payload.runId ?? null;
  if (!runId) {
    const { enqueueMediaIntelligenceRun } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const runResult = await enqueueMediaIntelligenceRun({
      teamId: payload.teamId,
      evidenceId: payload.evidenceId,
      kind: payload.kind,
      idempotencyKey: `${payload.kind}:${payload.evidenceId}`,
    });
    if (!runResult.ok) {
      bump("media_intelligence_enqueue_failed_total");
      return { enqueued: false, reason: "run_tracker_unavailable" };
    }
    runId = runResult.run.id;
  }

  const outcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    commandId: runId,
    traceId: payload.kind,
    delayMs: options.delayMs,
  });

  if (outcome.enqueued) {
    bump("media_intelligence_enqueue_total");
    return { enqueued: true, jobId: outcome.jobId, reused: outcome.collapsed };
  }
  // The run row exists in PENDING regardless, so a Redis outage is recoverable:
  // the stranded-run reconciler re-enqueues it.
  bump("media_intelligence_enqueue_failed_total");
  return { enqueued: false, reason: outcome.reason };
}
