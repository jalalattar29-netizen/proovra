import { Queue } from "bullmq";
import IORedis from "ioredis";

const reportQueueName = "report";
const generateReportJobName = "GenerateReportJob";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const redisConnection = new IORedis(must("REDIS_URL"), {
  maxRetriesPerRequest: null,
});

export const reportQueue = new Queue(reportQueueName, {
  connection: redisConnection as any,  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export async function enqueueGenerateReportJob(evidenceId: string) {
  const jobId = `report-${evidenceId}`;
  const existing = await reportQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    return { enqueued: false, reason: `job_${state}` };
  }

  await reportQueue.add(
    generateReportJobName,
    { evidenceId },
    {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true };
}
