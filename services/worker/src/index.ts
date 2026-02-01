import { Worker } from "bullmq";
import { logger, withJobContext } from "./logger";
import {
  generateReportJobName,
  redisConnection,
  reportQueueName,
  reportQueueScheduler,
} from "./queue";
import { processGenerateReport } from "./processor";
import { startHealthServer } from "./health";

const worker = new Worker(reportQueueName, processGenerateReport, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  logger.info(
    withJobContext({
      jobId: job.id,
      evidenceId: (job.data as any).evidenceId,
      attempt: job.attemptsMade,
      status: "completed",
    }),
    "Job completed"
  );
});

worker.on("failed", (job, err) => {
  if (!job) return;
  logger.error(
    withJobContext({
      jobId: job.id,
      evidenceId: (job.data as any).evidenceId,
      attempt: job.attemptsMade,
      status: "failed",
    }),
    err,
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
  await reportQueueScheduler.close();
  await redisConnection.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Shutting down worker");
  await worker.close();
  await reportQueueScheduler.close();
  await redisConnection.quit();
  process.exit(0);
});

logger.info({ job: generateReportJobName }, "Worker started");
