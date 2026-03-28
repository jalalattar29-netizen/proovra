import "./env-loader.js";
import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger.js";
import {
  generateReportJobName,
  redisConnection,
  reportDlqQueue,
  reportQueue,
  reportQueueName,
} from "./queue.js";
import { processGenerateReport } from "./processor.js";
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

initSentry();

const worker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});

let healthServer: HealthServer | null = null;
let shuttingDown = false;

worker.on("completed", (job) => {
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
    "job.completed"
  );
});

worker.on("failed", (job, err) => {
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

  logger.error({ ...context, err }, "job.failed");
  captureException(err, {
    requestId,
    evidenceId: (job.data as JobData | undefined)?.evidenceId,
    jobId: job.id ?? null,
  });

  emitOperationalAlert({
    requestId,
    reason: "worker_job_failed",
    err,
    context,
  });
});

worker.on("error", (err) => {
  const requestId = randomUUID();
  logger.error({ requestId, err }, "worker.error");
  captureException(err, { requestId });

  emitOperationalAlert({
    requestId,
    reason: "worker_runtime_error",
    err,
  });
});

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ requestId: randomUUID(), exitCode }, "worker.shutdown_started");

  try {
    await worker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.pause_failed");
    captureException(err, { requestId });
  }

  try {
    await worker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "worker.close_failed");
    captureException(err, { requestId });
  }

  try {
    await reportQueue.close();
    await reportDlqQueue.close();
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