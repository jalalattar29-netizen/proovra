import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config";

export const reportQueueName = "report";
export const reportDlqQueueName = "report-dlq";
export const generateReportJobName = "GenerateReportJob";

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const reportQueue = new Queue(reportQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export const reportDlqQueue = new Queue(reportDlqQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  },
});
