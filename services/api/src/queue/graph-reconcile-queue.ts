/**
 * API-side enqueue helper for the worker's `graph-reconcile` BullMQ
 * queue.
 *
 * Why this file exists:
 *   The previous wiring inlined a BullMQ producer directly inside
 *   `services/api/src/services/evidence-complete.service.ts` (a comment
 *   block, lazy singleton, and per-call options) — a left-over from
 *   an earlier slice that replaced an in-process IIFE which used to
 *   call `reconcileTeamGraph()` synchronously in the API. That
 *   in-process call bypassed the worker, and so the worker-side
 *   `indexExistingOcrAndTranscript` step (see
 *   `services/worker/src/queue/subsystem-queue-processors.ts:225-257`)
 *   never executed — leaving OCR / transcript text out of the search
 *   index and graph projection.
 *
 *   Moving the producer onto its own queue helper has two effects:
 *     1) Keeps `evidence-complete.service.ts` under its byte-pin cap
 *        (the test harness pins that file's size to prevent slow
 *        accumulation of cross-concern code in the completion path).
 *     2) Matches the per-queue helper pattern already used by
 *        `search-queue.ts`, `media-intelligence-queue.ts`,
 *        `mi-embed-queue.ts`, `derived-assets-queue.ts`, and
 *        `report-queue.ts`. The API process is in a different package
 *        than the worker and must not import worker code; each side
 *        owns its own BullMQ Queue handle, both targeting the same
 *        Redis stream + job-id namespace so duplicate enqueues
 *        collapse cleanly.
 *
 * Hard contracts (mirror search-queue.ts + worker/src/queue.ts):
 *   - queue name:      "graph-reconcile"
 *   - job name:        "ReconcileTeamGraph"
 *   - deterministic jobId:
 *       `graph-reconcile:${teamId}:${reason}:${evidenceId ?? "workspace"}`
 *     BullMQ collapses concurrent enqueues with the same id into a
 *     single queued job per (team, reason, evidence) tuple.
 *   - never throws — Redis outage or missing `REDIS_URL` returns a
 *     `{ queued: false, ... }` result so the caller (always invoked
 *     with `.catch(() => null)` in the completion path) never breaks
 *     evidence finalisation.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

const graphReconcileQueueName = "graph-reconcile";
const graphReconcileJobName = "ReconcileTeamGraph";

export interface GraphReconcileJobPayload {
  teamId: string;
  reason:
    | "evidence_completed"
    | "manual_refresh"
    | "scheduled_reconcile"
    | "admin_repair";
  evidenceId?: string;
  requestedByUserId?: string;
  requestId?: string;
}

export interface GraphReconcileEnqueueResult {
  queued: boolean;
  jobId: string;
  reason: string;
}

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
    lazyQueue = new Queue(graphReconcileQueueName, {
      // BullMQ + ioredis typings drift between versions; the same
      // cast is used in search-queue.ts and media-intelligence-queue.ts.
      connection: connection as never,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: false,
      },
    });
    return lazyQueue;
  } catch {
    queueConstructFailed = true;
    return null;
  }
}

function buildJobId(payload: GraphReconcileJobPayload): string {
  const evidenceKey = payload.evidenceId ?? "workspace";
  return `graph-reconcile:${payload.teamId}:${payload.reason}:${evidenceKey}`;
}

function boundedFailure(jobId: string, reason: string): GraphReconcileEnqueueResult {
  return { queued: false, jobId, reason };
}

/**
 * Best-effort async enqueue of a team-graph reconcile. The caller MUST
 * treat this as fire-and-forget — the worker is the source of truth
 * for actually running `reconcileTeamGraph()` and its OCR/transcript
 * indexer step.
 */
export async function enqueueGraphReconcileJob(
  payload: GraphReconcileJobPayload,
): Promise<GraphReconcileEnqueueResult> {
  const jobId = buildJobId(payload);
  const queue = getQueue();
  if (!queue) {
    return boundedFailure(jobId, "redis_unavailable");
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
        // Idempotent collapse — the existing queued job will satisfy
        // this intent. Not a failure.
        return { queued: false, jobId, reason: `job_${state}` };
      }
      try {
        await existing.remove();
      } catch {
        // ignore race — another producer may have removed it
      }
    }
    await queue.add(
      graphReconcileJobName,
      {
        teamId: payload.teamId,
        reason: payload.reason,
        evidenceId: payload.evidenceId ?? null,
        requestedByUserId: payload.requestedByUserId ?? null,
        requestId: payload.requestId ?? null,
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: false,
      },
    );
    return { queued: true, jobId, reason: "enqueued" };
  } catch (err) {
    const bounded =
      err instanceof Error ? err.message.slice(0, 120) : "unknown";
    // Bounded code "graph_reconcile_enqueue_failed" — see brief.
    // Not emitted via safeEmitSecurityEvent because that union does
    // not yet include this code; the periodic reconcile cron remains
    // the canonical catch-up path.
    return boundedFailure(jobId, `enqueue_failed: ${bounded}`);
  }
}
