/**
 * PHASE 5 §4 — CLOSING THE LOOP ON AN OPERATOR-REQUESTED REPLAY.
 *
 * When an operator replays a failed job, the API writes an audit row saying
 * `queued` and deliberately leaves the resulting state null: the job is back on
 * the queue and has not run. Something has to write the other half, or the
 * Admin audit can only ever say a replay was ASKED FOR.
 *
 * ===========================================================================
 * WHY THIS IS NOT "AUDIT EVERY JOB"
 * ===========================================================================
 * The obvious implementation — write an audit row whenever any job finishes —
 * would put thousands of rows a day into a hash-chained, append-only table
 * that exists to record OPERATOR actions. The signal would drown.
 *
 * Only a job somebody replayed has a human request waiting for an answer, so
 * only those get a completion row. Which ones those are is not knowable from
 * the job itself — `job.retry()` re-runs the job that already existed and
 * changes no payload — so it is discovered from the audit trail: an open
 * `queued` row anchored at this job's derived correlation reference.
 *
 * Two guards keep the cost bounded:
 *
 *   1. the lookup runs only for a job that has failed at least once, which is
 *      the only population a replay can come from;
 *   2. it is a point lookup on (resource_type, resource_id), which is already
 *      indexed.
 *
 * The correlation itself is DERIVED from the queue name and job id — see
 * `queueJobCorrelationRef` — because a generated id could not be handed to a
 * job that already existed when the replay was requested.
 */

import {
  QUEUE_JOB_RESOURCE_TYPE,
  queueJobCorrelationRef,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { appendWorkerAuditLog } from "./platform-audit-append.js";

const REPLAY_REQUEST_ACTION = "operations.queue_job.replay_requested";
const REPLAY_RESULT_ACTION = "operations.queue_job.replay_result";

export type ReplayOutcome = "completed" | "error";

/**
 * Record the RESULT of a replay, if this job was one.
 *
 * Never throws: a worker must not fail a job because the audit trail was
 * unavailable, and a missing correlation row is recoverable in a way that a
 * lost job result is not.
 */
export async function recordQueueReplayResultIfRequested(input: {
  queueName: string;
  jobId: string | null | undefined;
  attemptsMade: number;
  outcome: ReplayOutcome;
  failureReason?: string | null;
  workspaceId?: string | null;
}): Promise<boolean> {
  if (!input.jobId) return false;
  // A job that has never failed cannot have been replayed.
  if (input.attemptsMade < 1) return false;

  const ref = queueJobCorrelationRef(input.queueName, input.jobId);

  try {
    const request = await prisma.adminAuditLog.findFirst({
      where: {
        action: REPLAY_REQUEST_ACTION,
        resourceType: QUEUE_JOB_RESOURCE_TYPE,
        resourceId: ref,
        outcome: "queued",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true, workspaceId: true, userId: true },
    });
    if (!request) return false;

    // Only results that happened AFTER the request belong to it. Without this
    // an older completion could be attached to a newer request and the trail
    // would claim the replay finished before it was asked for.
    const alreadyRecorded = await prisma.adminAuditLog.findFirst({
      where: {
        action: REPLAY_RESULT_ACTION,
        resourceType: QUEUE_JOB_RESOURCE_TYPE,
        resourceId: ref,
        createdAt: { gte: request.createdAt },
      },
      select: { id: true },
    });
    if (alreadyRecorded) return false;

    await appendWorkerAuditLog({
      action: REPLAY_RESULT_ACTION,
      category: "tenant_audit",
      source: "worker",
      // COMPLETED, not `success` — the canonical word for asynchronous work
      // that finished, distinct from the `queued` the API wrote.
      outcome: input.outcome === "completed" ? "completed" : "error",
      severity: input.outcome === "completed" ? "info" : "warning",
      resourceType: QUEUE_JOB_RESOURCE_TYPE,
      // The SAME derived reference the API anchored, which is what joins the
      // two rows without either side inventing an id.
      resourceId: ref,
      workspaceId: input.workspaceId ?? request.workspaceId ?? null,
      // No human ran this. The row is typed WORKER by the writer.
      userId: null,
      // PHASE 5 §4 — a worker retry is not a new human request. The row is
      // typed WORKER and names the executor, so the operator who asked and
      // the process that ran are never conflated.
      serviceActor: `worker:${input.queueName}`,
      actorDisplay: `${input.queueName} worker`,
      targetDisplay: `${input.queueName} job`,
      previousState: "QUEUED",
      resultingState: input.outcome === "completed" ? "COMPLETED" : "FAILED",
      reasonCode:
        input.outcome === "completed"
          ? "REPLAY_EXECUTED"
          : (input.failureReason?.slice(0, 64) ?? "REPLAY_FAILED"),
      metadata: {
        queueName: input.queueName,
        jobId: input.jobId,
        attempt: input.attemptsMade,
        requestedByUserId: request.userId,
        requestAuditId: request.id,
      },
    });
    return true;
  } catch {
    // Never fail a job because the audit trail was unavailable.
    return false;
  }
}
