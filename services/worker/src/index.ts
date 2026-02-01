import "./env-loader.js";
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

type JobData = { evidenceId?: string };

const worker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});
let healthServer: HealthServer | null = null;
let shuttingDown = false;

worker.on("completed", (job) => {
  const durationMs =
    job.finishedOn && job.processedOn
      ? job.finishedOn - job.processedOn
      : null;

  logger.info(
    withJobContext({
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

  const durationMs =
    job.finishedOn && job.processedOn
      ? job.finishedOn - job.processedOn
      : job.processedOn
        ? Date.now() - job.processedOn
        : null;

  logger.error(
    {
      ...withJobContext({
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
});

worker.on("error", (err) => {
  logger.error({ err }, "Worker error");
});

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ exitCode }, "Shutting down worker");
  try {
    await worker.pause(true);
  } catch (err) {
    logger.error({ err }, "Failed to pause worker");
  }
  try {
    await worker.close();
  } catch (err) {
    logger.error({ err }, "Failed to close worker");
  }
  try {
    await reportQueue.close();
    await reportDlqQueue.close();
  } catch (err) {
    logger.error({ err }, "Failed to close queues");
  }
  try {
    await redisConnection.quit();
  } catch (err) {
    logger.error({ err }, "Failed to close redis connection");
  }
  try {
    await healthServer?.close();
  } catch (err) {
    logger.error({ err }, "Failed to close health server");
  }
  process.exit(exitCode);
}

startHealthServer()
  .then((server) => {
    healthServer = server;
  })
  .catch((err) => {
    logger.error({ err }, "Health server failed to start");
    void shutdown(1);
  });

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  void shutdown(1);
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  void shutdown(1);
});

logger.info({ job: generateReportJobName }, "Worker started");
