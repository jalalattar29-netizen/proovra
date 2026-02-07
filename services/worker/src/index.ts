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
    "Job completed"
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

  logger.error(
    {
      ...withJobContext({
        requestId,
        jobId: job.id,
        evidenceId: (job.data as JobData | undefined)?.evidenceId,
        attempt: job.attemptsMade + 1,
        durationMs: durationMs ?? undefined,
        status: "failed",
      }),
      err,
    },
    "Job failed"
  );
  captureException(err, {
    requestId,
    evidenceId: (job.data as JobData | undefined)?.evidenceId,
    jobId: job.id ?? null
  });
});

worker.on("error", (err) => {
  const requestId = randomUUID();
  logger.error({ requestId, err }, "Worker error");
  captureException(err, { requestId });
});

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ requestId: randomUUID(), exitCode }, "Shutting down worker");
  try {
    await worker.pause(true);
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "Failed to pause worker");
    captureException(err, { requestId });
  }
  try {
    await worker.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "Failed to close worker");
    captureException(err, { requestId });
  }
  try {
    await reportQueue.close();
    await reportDlqQueue.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "Failed to close queues");
    captureException(err, { requestId });
  }
  try {
    await redisConnection.quit();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "Failed to close redis connection");
    captureException(err, { requestId });
  }
  try {
    await healthServer?.close();
  } catch (err) {
    const requestId = randomUUID();
    logger.error({ requestId, err }, "Failed to close health server");
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
    logger.error({ requestId, err }, "Health server failed to start");
    captureException(err, { requestId });
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
  logger.error({ requestId, err: reason }, "Unhandled promise rejection");
  captureException(reason, { requestId });
  void shutdown(1);
});

process.on("uncaughtException", (err) => {
  const requestId = randomUUID();
  logger.error({ requestId, err }, "Uncaught exception");
  captureException(err, { requestId });
  void shutdown(1);
});

logger.info(
  { requestId: randomUUID(), job: generateReportJobName },
  "Worker started"
);
