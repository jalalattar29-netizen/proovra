/**
 * PHASE 12 — POINT 5: the ONE enqueue authority.
 *
 * Both the api and the worker call this function. Not "the same policy
 * implemented twice" — the same function. Before Point 5, seven queues had two
 * enqueue helpers each, and at least one pair had already drifted on whether a
 * collapsed enqueue reports success.
 */

import {
  buildCanonicalJobPayload,
  QueuePayloadRejected,
  type CanonicalJobPayload,
} from "./payload.js";
import { buildCanonicalJobId } from "./job-id.js";
import type { RetryPolicy } from "./retry-policy.js";

/**
 * The slice of BullMQ's `Queue` this module needs.
 *
 * Declared structurally so `@proovra/shared` stays free of a bullmq dependency
 * — the api and the worker each pass their own handle. It also makes the
 * enqueue policy directly testable without Redis.
 */
export interface QueueJobHandle {
  id?: string | number | null;
  getState(): Promise<string>;
  remove(): Promise<unknown>;
}

export interface QueueHandleLike {
  getJob(jobId: string): Promise<QueueJobHandle | null | undefined>;
  add(
    jobName: string,
    data: unknown,
    opts: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * BullMQ states meaning "a job for this id is already scheduled or running".
 * A fresh enqueue COLLAPSES onto these rather than duplicating work.
 */
export const LIVE_QUEUE_JOB_STATES: ReadonlyArray<string> = [
  "waiting",
  "waiting-children",
  "delayed",
  "active",
  "prioritized",
];

export function isLiveQueueJobState(state: string | null | undefined): boolean {
  return !!state && LIVE_QUEUE_JOB_STATES.includes(state);
}

export type EnqueueOutcome =
  | { enqueued: true; jobId: string; collapsed: boolean }
  | { enqueued: false; reason: string };

export type EnqueueEntry = {
  /** Registry entries call this `workName`; on a BullMQ queue it IS the job name. */
  workName: string;
  jobIdPrefix: string | null;
  schemaVersion: number;
  retry: RetryPolicy;
};

/**
 * Enqueue a canonical job.
 *
 * The policy is collapse-or-replace, and having it in one place is the whole
 * point: BullMQ IGNORES an `add` whose jobId already exists — INCLUDING a
 * retained completed or failed job — and still returns a Job object. A naive
 * `add` therefore reports success while scheduling nothing, which is exactly
 * the case a stranded-row reconciler exists to fix. So:
 *
 *   * a LIVE job  → collapse, report `collapsed: true`;
 *   * a SPENT job → release the id, then schedule fresh;
 *   * anything else → report honestly so the caller can leave the durable row
 *     QUEUED for the reconciler rather than marking it in-flight.
 *
 * Never throws into the calling flow: a Redis outage must not fail an
 * authorized API mutation whose durable row is already committed.
 */
export async function enqueueCanonicalJob(input: {
  queue: QueueHandleLike;
  entry: EnqueueEntry;
  commandId: string;
  traceId: string;
  delayMs?: number;
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
  /**
   * W3C traceparent of the enqueueing request, when one is active. Supplied by
   * the caller rather than read here so `@proovra/shared` stays free of an
   * OpenTelemetry dependency — the api and worker each inject their own.
   */
  traceparent?: string | null;
  /**
   * The id of the job MAKING this call, when a processor re-schedules its own
   * follow-up.
   *
   * This exists because of a production incident and deleting it would recreate
   * that incident. The OTS upgrade ladder works by a running job scheduling its
   * own next attempt. Under plain collapse-or-replace the live job it finds
   * under the target id is ITSELF, in state `active`, so the enqueue collapses
   * onto a job that is about to finish — the follow-up is never scheduled, the
   * evidence stays OTS-PENDING forever, and nothing in the queue shows why.
   *
   * When the live job IS the caller, the enqueue therefore does not collapse:
   * it schedules under a discriminated id. That id is NOT deterministic, which
   * is a genuine and deliberate exception to this module's own rule. It is
   * bounded by two things: dedupe against PARALLEL callers still holds (a
   * second producer sees the same live job and collapses normally, because its
   * own job id is different), and the ladder's real ceiling is the caller's
   * durable global attempt budget rather than the queue's retry count.
   */
  selfJobId?: string | number | null;
}): Promise<EnqueueOutcome> {
  const { queue, entry, commandId } = input;
  if (!entry.jobIdPrefix) {
    // A registry entry with no job-id prefix is a DB sweep, not a queue job.
    // Enqueuing one would silently create an unroutable job.
    return { enqueued: false, reason: "not_a_queue_job" };
  }
  const prefixed = { jobIdPrefix: entry.jobIdPrefix };
  let jobId: string;
  let payload: CanonicalJobPayload;
  try {
    jobId = buildCanonicalJobId(prefixed, commandId);
    payload = buildCanonicalJobPayload({
      commandId,
      traceId: input.traceId,
      schemaVersion: entry.schemaVersion,
      traceparent: input.traceparent ?? null,
    });
  } catch (err) {
    return {
      enqueued: false,
      reason:
        err instanceof QueuePayloadRejected ? err.code : "invalid_command_id",
    };
  }

  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const isSelfReference =
        input.selfJobId != null &&
        String(existing.id ?? "") === String(input.selfJobId);

      if (isSelfReference) {
        // The live job under this id is the caller. Collapsing onto it would
        // schedule nothing; removing it would delete a running job. Schedule
        // under a discriminated id instead — see `selfJobId` above.
        jobId = `${jobId}-next-${(existing.id ?? "self").toString().slice(-8)}-${
          (payload.commandId.length + jobId.length) % 997
        }`;
      } else {
        const state = await existing.getState();
        if (isLiveQueueJobState(state)) {
          return { enqueued: true, jobId, collapsed: true };
        }
        try {
          await existing.remove();
        } catch {
          // Lost the race with a parallel producer or a sweeper. Report
          // honestly instead of claiming a schedule we did not make — the
          // durable row stays QUEUED and the reconciler picks it up.
          return { enqueued: false, reason: "job_id_release_race" };
        }
      }
    }
    await queue.add(entry.workName, payload, {
      jobId,
      delay: Math.max(0, input.delayMs ?? 0),
      attempts: entry.retry.attempts,
      backoff: { type: entry.retry.backoff, delay: entry.retry.backoffDelayMs },
      removeOnComplete: input.removeOnComplete ?? 100,
      removeOnFail: input.removeOnFail ?? false,
    });
    return { enqueued: true, jobId, collapsed: false };
  } catch (err) {
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
}
