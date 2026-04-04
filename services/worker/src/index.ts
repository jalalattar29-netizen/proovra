import "./env-loader.js";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger.js";
import {
  generateReportJobName,
  otsUpgradeQueue,
  otsUpgradeQueueName,
  redisConnection,
  reportDlqQueue,
  reportQueue,
  reportQueueName,
} from "./queue.js";
import { processGenerateReport } from "./processor.js";
import { processOtsUpgrade } from "./ots-upgrade.processor.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { captureException, initSentry } from "./sentry.js";

type JobData = { evidenceId?: string };

function emitOperationalAlert(params: {
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

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function isExpectedOtsPendingError(jobKind: "report" | "ots-upgrade", err: unknown): boolean {
  if (jobKind !== "ots-upgrade") return false;
  return getErrorMessage(err).trim() === "NOT_ANCHORED_YET";
}

function bindWorkerEvents(
  workerInstance: Worker,
  jobKind: "report" | "ots-upgrade"
) {
  workerInstance.on("completed", (job) => {
    const requestId = randomUUID();
    const durationMs =
      job.finishedOn && job.processedOn
        ? job.finishedOn - job.processedOn
        : null;

    logger.info(
      withJobContext({
        requestId,
        jobId: job.id,
        evidenceId: (job.data as JobData | undefined)?.evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "completed",
      }),
      `${jobKind}.job.completed`
    );
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
        evidenceId: (job.data as JobData | undefined)?.evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "failed",
      }),
    };

    if (isExpectedOtsPendingError(jobKind, err)) {
      logger.warn(
        {
          ...context,
          err,
        },
        `${jobKind}.job.pending_retry`
      );
      return;
    }

    logger.error({ ...context, err }, `${jobKind}.job.failed`);
    captureException(err, {
      requestId,
      evidenceId: (job.data as JobData | undefined)?.evidenceId,
      jobId: job.id ?? null,
      jobKind,
    });

    emitOperationalAlert({
      requestId,
      reason: `${jobKind}_job_failed`,
      err,
      context,
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

initSentry();

const reportWorker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});

const otsUpgradeWorker = new Worker(otsUpgradeQueueName, processOtsUpgrade, {
  connection: redisConnection,
  concurrency: 1,
});

bindWorkerEvents(reportWorker, "report");
bindWorkerEvents(otsUpgradeWorker, "ots-upgrade");

let healthServer: HealthServer | null = null;
let shuttingDown = false;

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ requestId: randomUUID(), exitCode }, "worker.shutdown_started");

  try {
    await reportWorker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_report_failed");
    captureException(err, { requestId });
  }

  try {
    await otsUpgradeWorker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_ots_upgrade_failed");
    captureException(err, { requestId });
  }

  try {
    await reportWorker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_report_failed");
    captureException(err, { requestId });
  }

  try {
    await otsUpgradeWorker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_ots_upgrade_failed");
    captureException(err, { requestId });
  }

  try {
    await reportQueue.close();
    await reportDlqQueue.close();
    await otsUpgradeQueue.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.queue_close_failed");
    captureException(err, { requestId });
  }

  try {
    await redisConnection.quit();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.redis_close_failed");
    captureException(err, { requestId });
  }

  try {
    await healthServer?.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.health_close_failed");
    captureException(err, { requestId });
  }

  process.exit(exitCode);
}

startHealthServer()
  .then((server) => {
    healthServer = server;
  })
  .catch((err) => {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.health_start_failed");
    captureException(err, { requestId });

    emitOperationalAlert({
      requestId,
      reason: "worker_health_server_failed",
      err,
    });

    void shutdown(1);
  });

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("unhandledRejection", (reason) => {
  const requestId = randomUUID();
  logger.error({ requestId, err: reason }, "worker.unhandled_rejection");
  captureException(reason, { requestId });

  emitOperationalAlert({
    requestId,
    reason: "worker_unhandled_rejection",
    err: reason,
  });

  void shutdown(1);
});

process.on("uncaughtException", (err) => {
  const requestId = randomUUID();
  logger.error({ requestId, err }, "worker.uncaught_exception");
  captureException(err, { requestId });

  emitOperationalAlert({
    requestId,
    reason: "worker_uncaught_exception",
    err,
  });

  void shutdown(1);
});

logger.info(
  { requestId: randomUUID(), job: generateReportJobName },
  "worker.started"
);