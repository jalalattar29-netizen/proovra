/**
 * Phase Y — Worker observability primitives.
 *
 * Three minimal helpers the worker entrypoint + processors use:
 *
 *   1. `heartbeat(workerId)` — log a structured heartbeat so a
 *      log-based scraper can derive `worker_last_heartbeat_age_seconds`
 *      without a central metrics push. Lightweight enough to fire on
 *      every scheduler tick.
 *
 *   2. `snapshotQueueHealth(queues)` — read BullMQ counts for the
 *      named queues and return a typed snapshot. Used by the api's
 *      `/v1/ops/queues` route (cron-pushed) AND by the worker's own
 *      diagnostic endpoint.
 *
 *   3. `instrumentJobOutcome(...)` — call after a BullMQ job
 *      completes/fails. Bumps the right counter via the shared
 *      contract. Does not throw.
 *
 * No Sentry calls here — those happen via the existing `sentry.ts`
 * module. This file is metrics-only.
 */

import type { Queue } from "bullmq";

import { logger } from "./logger.js";

// -----------------------------------------------------------------------------
// Heartbeat
// -----------------------------------------------------------------------------

/**
 * Emit a structured heartbeat log line for a long-running worker /
 * scheduler. The log carries `service=worker`, `workerId`, and a
 * `heartbeat: true` flag so a log-based dashboard query can compute
 * `now() - max(heartbeat.ts) per workerId` to detect stuck workers.
 *
 * The function is intentionally cheap (just a logger call) and safe
 * to invoke from inside hot scheduler loops.
 */
export function heartbeat(workerId: string): void {
  try {
    logger.info(
      {
        heartbeat: true,
        workerId: workerId.slice(0, 64),
        emittedAtUtc: new Date().toISOString(),
      },
      "worker.heartbeat",
    );
  } catch {
    // Observability emission MUST never break the caller.
  }
}

// -----------------------------------------------------------------------------
// Queue health snapshot
// -----------------------------------------------------------------------------

export type QueueHealthSample = {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  /** True when the queue has any non-terminal state — used by the
   *  dashboard to highlight queues that need an operator's attention. */
  hasBacklog: boolean;
  /** Oldest job's age in seconds, when the queue exposes it. NULL
   *  when we couldn't fetch — never an estimate. */
  oldestPendingAgeSeconds: number | null;
  sampledAtUtc: string;
};

async function safeCount(
  queue: Queue,
  state: "waiting" | "active" | "delayed" | "completed" | "failed" | "paused",
): Promise<number> {
  try {
    return await queue.getJobCountByTypes(state);
  } catch {
    return 0;
  }
}

async function safeOldestPendingAge(queue: Queue): Promise<number | null> {
  try {
    const [job] = await queue.getJobs(
      ["waiting", "delayed", "active", "prioritized"],
      0,
      0,
    );
    if (!job) return null;
    const ts =
      typeof job.timestamp === "number"
        ? job.timestamp
        : Number(job.timestamp);
    if (!Number.isFinite(ts)) return null;
    const ageSeconds = Math.floor((Date.now() - ts) / 1000);
    return ageSeconds >= 0 ? ageSeconds : null;
  } catch {
    return null;
  }
}

/**
 * Sample BullMQ queue state for one or more queues. Never throws —
 * a failure on one queue falls back to zeros for that queue and the
 * sweep continues.
 */
export async function snapshotQueueHealth(
  queues: ReadonlyArray<{ name: string; queue: Queue }>,
): Promise<ReadonlyArray<QueueHealthSample>> {
  const sampledAtUtc = new Date().toISOString();
  const samples = await Promise.all(
    queues.map(async ({ name, queue }) => {
      const [waiting, active, delayed, completed, failed, paused, oldestAge] =
        await Promise.all([
          safeCount(queue, "waiting"),
          safeCount(queue, "active"),
          safeCount(queue, "delayed"),
          safeCount(queue, "completed"),
          safeCount(queue, "failed"),
          safeCount(queue, "paused"),
          safeOldestPendingAge(queue),
        ]);
      const sample: QueueHealthSample = {
        name,
        waiting,
        active,
        delayed,
        completed,
        failed,
        paused,
        hasBacklog: waiting + active + delayed > 0,
        oldestPendingAgeSeconds: oldestAge,
        sampledAtUtc,
      };
      return sample;
    }),
  );
  return samples;
}

// -----------------------------------------------------------------------------
// Job outcome instrumentation
//
// Called from `bindWorkerEvents` once a job lands in `completed` or
// `failed`. Updates worker telemetry on the API side via the queue
// counters we registered in metrics.service.ts. The worker is a
// separate process, so we can't bump the api's in-memory counters
// directly — instead we log a structured outcome that a log-based
// metrics provider can scrape.
// -----------------------------------------------------------------------------

export type JobOutcomeContext = {
  queueName: string;
  jobId: string | number | null | undefined;
  attempt: number;
  durationMs: number | null;
  outcome: "completed" | "failed" | "stalled" | "dlq";
  errorMessage?: string | null;
  correlationId?: string | null;
};

export function instrumentJobOutcome(ctx: JobOutcomeContext): void {
  try {
    logger.info(
      {
        queueTelemetry: true,
        queueName: ctx.queueName.slice(0, 64),
        jobId: ctx.jobId ?? null,
        attempt: ctx.attempt,
        durationMs: ctx.durationMs ?? null,
        outcome: ctx.outcome,
        correlationId: ctx.correlationId ?? null,
        // Error messages are scrubbed for length only — operators
        // grep logs by jobId / queueName / correlationId, not by
        // error contents.
        errorMessage: ctx.errorMessage?.slice(0, 400) ?? null,
      },
      "worker.job.outcome",
    );
  } catch {
    // never propagates
  }
}
