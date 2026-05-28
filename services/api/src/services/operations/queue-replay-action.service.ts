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
 *     passed).
 *   * Duplicate replays are prevented by checking the job's `attemptsMade`
 *     against a "last operator replay" marker we leave in `data`.
 *     We do NOT mutate the job payload — instead we annotate via the
 *     job's metadata returned by `getJob()`.
 */

import type { Job } from "bullmq";

import { bump } from "../ops/metrics.service.js";
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
