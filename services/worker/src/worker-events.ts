/**
 * THE WORKER'S JOB-EVENT BINDING (extracted from index.ts on 2026-10-20).
 *
 * Moved verbatim so the real BullMQ `completed` / `failed` / `error`
 * binding can be exercised by a behaviour test (index.ts starts workers on
 * import). Every registered worker is bound through `bindWorkerEvents`.
 */
import { randomUUID } from "node:crypto";
import type { Worker } from "bullmq";

import { logger, withJobContext } from "./logger.js";
import { captureException } from "./sentry.js";
import { instrumentJobOutcome } from "./observability.js";
import { recordQueueReplayResultIfRequested } from "./queue-replay-correlation.js";
import { boundedErrorCode, isExpectedOtsPendingError, isFinalAttempt, jobCommandId } from "./job-event-context.js";
import { mediaIntelligenceDlqQueue } from "./queue.js";
import { isOutputProductionRefusedError } from "./output-production-refusal.js";
import { attemptBudgetOverrun, getBullMqEntries } from "@proovra/shared";

/** AUD-50 — an attempt that overran its declared budget is reported, never aborted. */
function reportOverBudget(workerInstance: Worker, jobKind: string, jobId: string | undefined, attempt: number, durationMs: number | null) {
  const over = attemptBudgetOverrun(getBullMqEntries(), (workerInstance as { name?: string }).name ?? null, durationMs);
  if (!over) return;
  logger.warn({ jobId: jobId ?? null, attempt, durationMs, budgetMs: over.budgetMs, overByMs: over.overByMs }, `${jobKind}.job.attempt_over_budget`);
}

export function emitOperationalAlert(params: {
  requestId: string;
  reason: string;
  err?: unknown;
  context?: Record<string, unknown>;
}) {
  logger.error(
    {
      alert: true,
      severity: "critical",
      requestId: params.requestId,
      reason: params.reason,
      ...(params.context ?? {}),
      ...(params.err ? { err: params.err } : {}),
    },
    "operational.alert"
  );
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}


export function bindWorkerEvents(
  workerInstance: Worker,
  jobKind: string,
) {
  workerInstance.on("completed", (job) => {
    const requestId = randomUUID();
    const durationMs =
      job.finishedOn && job.processedOn
        ? job.finishedOn - job.processedOn
        : null;

    logger.info(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          durationMs: durationMs ?? undefined,
          status: "completed",
        }),
        commandId: jobCommandId(job) ?? null,
      },
      `${jobKind}.job.completed`
    );
    reportOverBudget(workerInstance, jobKind, job.id, job.attemptsMade + 1, durationMs);
    // Phase Y — structured outcome line for log-based metrics.
    instrumentJobOutcome({
      queueName: jobKind,
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
      durationMs,
      outcome: "completed",
      correlationId: requestId,
    });

    // PHASE 5 §4 — if an operator replayed this job, the Admin audit is still
    // holding a `queued` row with no result. Close it. Only replayed jobs
    // qualify (see the module header for why this is not "audit every job"),
    // and the call never throws.
    void recordQueueReplayResultIfRequested({
      queueName: jobKind,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
      outcome: "completed",
      workspaceId: null,
    });
  });

  workerInstance.on("failed", (job, err) => {
    if (!job) return;

    const requestId = randomUUID();
    const durationMs =
      job.finishedOn && job.processedOn
        ? job.finishedOn - job.processedOn
        : job.processedOn
          ? Date.now() - job.processedOn
          : null;

    const context = {
      ...withJobContext({
        requestId,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "failed",
      }),
      commandId: jobCommandId(job) ?? null,
    };
    reportOverBudget(workerInstance, jobKind, job.id, job.attemptsMade + 1, durationMs);

    // 2026-10-20 (AUD-03) — an expected business refusal is never an
    // operational failure: no Sentry event, no critical alert. (The report
    // processor settles refusals without throwing; this is the backstop for
    // any processor that does throw one.)
    if (isOutputProductionRefusedError(err)) {
      logger.info({ ...context, refusal: (err as { refusal?: string }).refusal ?? null }, `${jobKind}.job.not_applicable`);
      return;
    }

    if (isExpectedOtsPendingError(jobKind, err, job)) {
      logger.warn(
        {
          ...context,
          err,
        },
        `${jobKind}.job.pending_retry`
      );
      // Phase Y — pending retry is NOT a failure, but track it as a
      // distinct outcome for the dashboard.
      instrumentJobOutcome({
        queueName: jobKind,
        jobId: job.id ?? null,
        attempt: job.attemptsMade + 1,
        durationMs,
        outcome: "stalled",
        correlationId: requestId,
        errorMessage: getErrorMessage(err),
      });
      return;
    }

    // AUD-41 (2026-10-20) — ESCALATE ON EXHAUSTION. BullMQ emits `failed` for
    // EVERY attempt, so a retryable failure that the next attempt fixes raised a
    // Sentry event and a CRITICAL alert per attempt. Before the last attempt
    // (and unless the processor discarded the job as non-retryable) it is
    // logged as a retry and counted; Sentry and the alert fire once, when the
    // queue has given up.
    const discarded = (job as unknown as { discarded?: boolean }).discarded === true;
    if (!isFinalAttempt(job) && !discarded) {
      logger.warn({ ...context, err }, `${jobKind}.job.attempt_failed_will_retry`);
      instrumentJobOutcome({
        queueName: jobKind,
        jobId: job.id ?? null,
        attempt: job.attemptsMade + 1,
        durationMs,
        outcome: "failed",
        correlationId: requestId,
        errorMessage: getErrorMessage(err),
      });
      return;
    }

    logger.error({ ...context, err }, `${jobKind}.job.failed`);
    // ET-Q-08 — the media-intelligence DLQ was declared, shown to operators and
    // never written: exhausted jobs sat in the failed set while it read 0. A
    // job that has spent its LAST attempt is recorded there (bounded code only;
    // its run row is already FAILED by the processor or the reconciler).
    if (jobKind === "media-intelligence" && isFinalAttempt(job)) {
      void mediaIntelligenceDlqQueue
        .add(
          "MediaIntelligenceDLQ",
          { commandId: jobCommandId(job) ?? null, jobId: job.id ?? null, errorCode: boundedErrorCode(err) },
          { removeOnComplete: true, removeOnFail: false },
        )
        .catch((dlqErr) => logger.warn({ err: dlqErr, jobId: job.id }, "media_intelligence.dlq_write_failed"));
    }
    captureException(err, {
      requestId,
      commandId: jobCommandId(job) ?? null,
      jobId: job.id ?? null,
      jobKind,
    });

    emitOperationalAlert({
      requestId,
      reason: `${jobKind}_job_failed`,
      err,
      context,
    });
    // Phase Y — structured outcome line for log-based metrics.
    instrumentJobOutcome({
      queueName: jobKind,
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
      durationMs,
      outcome: "failed",
      correlationId: requestId,
      errorMessage: getErrorMessage(err),
    });

    // PHASE 5 §4 — the other half of a replay, when it went the other way.
    // The reason is a bounded CODE, never the raw error message: an operator
    // needs to know the replay failed, and an audit row is not the place to
    // put whatever text an exception happened to carry.
    void recordQueueReplayResultIfRequested({
      queueName: jobKind,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
      outcome: "error",
      failureReason: "REPLAY_FAILED",
      workspaceId: null,
    });
  });

  workerInstance.on("error", (err) => {
    const requestId = randomUUID();
    logger.error({ requestId, err, jobKind }, `${jobKind}.worker.error`);
    captureException(err, { requestId, jobKind });

    emitOperationalAlert({
      requestId,
      reason: `${jobKind}_worker_runtime_error`,
      err,
    });
  });
}
