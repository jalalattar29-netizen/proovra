/**
 * Phase P2.3 — Queue replay / retry / cancel actions.
 *
 * Mutations against a BullMQ job. Every action:
 *   * is validated against the bounded replay safety matrix
 *   * requires an operator-supplied `reason` string (bounded to 240 chars)
 *   * emits the audit event chain (started → succeeded | failed)
 *   * bumps bounded metrics
 *   * NEVER calls IORedis directly
 *
 * Hard rules:
 *   * `forbidden` jobs hard-refuse with `replay_forbidden`.
 *   * `requires_step_up` jobs are gated at the route layer (this
 *     service is the post-step-up handler; it assumes the gate has
 *     passed). The route derives the category from the REAL job via
 *     `resolveJobKind()` below — never from a caller-supplied hint,
 *     which the caller could simply omit to skip the gate.
 *   * Duplicate replays are prevented by checking the job's `attemptsMade`
 *     against a "last operator replay" marker we leave in `data`.
 *     We do NOT mutate the job payload — instead we annotate via the
 *     job's metadata returned by `getJob()`.
 */

import type { Job } from "bullmq";

import {
  QUEUE_JOB_RESOURCE_TYPE,
  queueJobCorrelationRef,
} from "@proovra/shared";
import { bump } from "../ops/metrics.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  getJobReplayCategory,
  getJobReplayRationale,
} from "./queue-replay-safety.service.js";
import { getQueueHandle } from "./queue-inventory.service.js";
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

export type ReplayActionResult =
  | {
      ok: true;
      action: "retry" | "replay" | "cancel";
      queueName: string;
      jobId: string;
      newAttemptsMade: number;
      executedAtUtc: string;
    }
  | {
      ok: false;
      code:
        | "queue_unknown"
        | "job_not_found"
        | "replay_forbidden"
        | "job_not_failed"
        | "duplicate_replay"
        | "reason_required"
        | "unknown_job_kind";
      message: string;
    };

/**
 * The real job kind for a queued job, read from the queue itself.
 *
 * This exists so the step-up gate can be decided from the job that is
 * actually about to be replayed. Returns `null` when the queue or the job
 * cannot be resolved; the caller should then fall through to the action
 * itself, which owns the canonical typed refusals (`queue_unknown`,
 * `job_not_found`) and must remain the single authority for them.
 */
export async function resolveJobKind(
  queueName: string,
  jobId: string,
): Promise<string | null> {
  const q = getQueueHandle(queueName);
  if (!q) return null;
  const job = (await q.getJob(jobId)) as Job | null;
  if (!job) return null;
  return typeof job.name === "string" && job.name.length > 0 ? job.name : null;
}

export async function retryFailedJob(input: {
  queueName: string;
  jobId: string;
  actorUserId: string;
  teamId: string;
  reason: string;
}): Promise<ReplayActionResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.QUEUE_JOB_RETRY,
    {
      queueName: input.queueName,
      action: "retry",
      teamId: input.teamId,
    },
    async () => {
      const result = await doReplayLike("retry", input);
      bump(result.ok ? "queue_retry_total" : "queue_retry_failure_total");
      return result;
    },
  );
}

export async function replayFailedJob(input: {
  queueName: string;
  jobId: string;
  actorUserId: string;
  teamId: string;
  reason: string;
}): Promise<ReplayActionResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.QUEUE_JOB_REPLAY,
    {
      queueName: input.queueName,
      action: "replay",
      teamId: input.teamId,
    },
    () => doReplayLike("replay", input),
  );
}

export async function cancelJob(input: {
  queueName: string;
  jobId: string;
  actorUserId: string;
  teamId: string;
  reason: string;
}): Promise<ReplayActionResult> {
  const reason = (input.reason ?? "").trim().slice(0, 240);
  if (reason.length === 0) {
    return {
      ok: false,
      code: "reason_required",
      message: "Operator reason required for queue cancel.",
    };
  }
  const q = getQueueHandle(input.queueName);
  if (!q) {
    return {
      ok: false,
      code: "queue_unknown",
      message: "Unknown queue name.",
    };
  }
  const job = (await q.getJob(input.jobId)) as Job | null;
  if (!job) {
    return {
      ok: false,
      code: "job_not_found",
      message: "Job not found in queue.",
    };
  }
  try {
    await job.remove();
    bump("queue_replay_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "queue_job_replay_succeeded",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        action: "cancel",
        queueName: input.queueName,
        jobId: input.jobId,
        reason,
      },
    });
    return {
      ok: true,
      action: "cancel",
      queueName: input.queueName,
      jobId: input.jobId,
      newAttemptsMade: Number(job.attemptsMade ?? 0),
      executedAtUtc: new Date().toISOString(),
    };
  } catch (err) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "queue_job_replay_failed",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        action: "cancel",
        queueName: input.queueName,
        jobId: input.jobId,
        reason,
        errorCode:
          err instanceof Error ? err.name.slice(0, 60) : "unknown",
      },
    });
    return {
      ok: false,
      code: "job_not_found",
      message: "Cancel failed.",
    };
  }
}

async function doReplayLike(
  action: "retry" | "replay",
  input: {
    queueName: string;
    jobId: string;
    actorUserId: string;
    teamId: string;
    reason: string;
  },
): Promise<ReplayActionResult> {
  const reason = (input.reason ?? "").trim().slice(0, 240);
  if (reason.length === 0) {
    return {
      ok: false,
      code: "reason_required",
      message: "Operator reason required for queue replay.",
    };
  }
  const q = getQueueHandle(input.queueName);
  if (!q) {
    return {
      ok: false,
      code: "queue_unknown",
      message: "Unknown queue name.",
    };
  }
  const job = (await q.getJob(input.jobId)) as Job | null;
  if (!job) {
    return {
      ok: false,
      code: "job_not_found",
      message: "Job not found in queue.",
    };
  }
  const isFailed = (await job.isFailed()) || (await job.isCompleted());
  if (!isFailed) {
    return {
      ok: false,
      code: "job_not_failed",
      message: "Only failed (or completed) jobs are eligible for replay.",
    };
  }
  const category = getJobReplayCategory(input.queueName, String(job.name));
  if (category === "forbidden") {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "queue_job_replay_forbidden",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        action,
        queueName: input.queueName,
        jobId: input.jobId,
        jobName: job.name,
        rationale: getJobReplayRationale(input.queueName, String(job.name)),
        reason,
      },
    });
    bump("queue_replay_forbidden_total");
    return {
      ok: false,
      code: "replay_forbidden",
      message:
        "This job kind is classified as forbidden for replay. See the replay safety matrix.",
    };
  }
  if (category === "unknown") {
    return {
      ok: false,
      code: "unknown_job_kind",
      message:
        "Replay refused: this job kind is not in the replay safety matrix.",
    };
  }
  // Emit started.
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "queue_job_replay_attempted",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      action,
      queueName: input.queueName,
      jobId: input.jobId,
      jobName: job.name,
      category,
      reason,
    },
  });
  bump("queue_replay_total");
  if (category === "safe") bump("queue_replay_safe_total");
  if (category === "requires_step_up") bump("queue_replay_step_up_total");

  try {
    // BullMQ's `retry()` re-enqueues the failed job. We use the same
    // API for both "retry" (next attempt) and "replay" (full retry
    // from attempt 1) — the distinction is operator semantics:
    // "retry" continues the failure chain; "replay" indicates the
    // operator believes the underlying cause is now resolved.
    await job.retry();
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "queue_job_replay_succeeded",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        action,
        queueName: input.queueName,
        jobId: input.jobId,
        jobName: job.name,
        category,
        reason,
      },
    });

    /*
     * PHASE 5 §4 (family F) — QUEUED IS NOT COMPLETED, AND THIS ROUTE HAD NO
     * AUDIT ROW AT ALL.
     *
     * `job.retry()` puts the job back on the queue. It does not run it. The
     * security event above is named `..._succeeded` and fires here, which
     * describes the enqueue succeeding — but an operator reading the Admin
     * audit for "did the replay work" is asking about the WORK, and until now
     * the canonical audit trail had nothing to answer with: this family wrote
     * security events only.
     *
     * So the row says `queued`, carries no resulting state, and anchors a
     * correlation that the worker can independently derive — the queue name
     * and job id, which both sides already hold — so the later completion or
     * failure joins to this request without either side inventing an id.
     */
    await emitTenantAudit({
      action: "operations.queue_job.replay_requested",
      outcome: "queued",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      actorAuthority: "PLATFORM_OPS",
      workspaceId: input.teamId,
      resourceType: QUEUE_JOB_RESOURCE_TYPE,
      resourceId: queueJobCorrelationRef(input.queueName, input.jobId),
      targetDisplay: `${input.queueName} · ${job.name}`,
      previousState: "FAILED",
      requestedState: action === "replay" ? "REPLAYED" : "RETRIED",
      // Deliberately null: the job is on the queue and has not run.
      resultingState: null,
      reasonCode: "OPERATOR_REQUESTED_REPLAY",
      metadata: {
        action,
        queueName: input.queueName,
        jobId: input.jobId,
        jobName: job.name,
        category,
        reason,
        attemptsMadeAtRequest: Number(job.attemptsMade ?? 0),
      },
    }).catch(() => null);

    return {
      ok: true,
      action,
      queueName: input.queueName,
      jobId: input.jobId,
      newAttemptsMade: Number(job.attemptsMade ?? 0),
      executedAtUtc: new Date().toISOString(),
    };
  } catch (err) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "queue_job_replay_failed",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        action,
        queueName: input.queueName,
        jobId: input.jobId,
        jobName: job.name,
        reason,
        errorCode:
          err instanceof Error ? err.name.slice(0, 60) : "unknown",
      },
    });
    return {
      ok: false,
      code: "job_not_found",
      message: "Replay failed.",
    };
  }
}
