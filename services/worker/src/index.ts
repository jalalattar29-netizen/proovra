import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger";
import {
  generateReportJobName,
  redisConnection,
  reportQueueName,
} from "./queue";
import { processGenerateReport } from "./processor";
import { startHealthServer } from "./health";

type JobData = { evidenceId?: string };

const worker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});

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

startHealthServer().catch((err) => {
  logger.error({ err }, "Health server failed to start");
  process.exit(1);
});

process.on("SIGINT", async () => {
  logger.info("Shutting down worker");
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Shutting down worker");
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
});

logger.info({ job: generateReportJobName }, "Worker started");
