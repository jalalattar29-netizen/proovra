import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config.js";

export const reportQueueName = "report";
export const reportDlqQueueName = "report-dlq";
export const otsUpgradeQueueName = "ots-upgrade";
export const generateReportJobName = "GenerateReportJob";

export type EnqueueReportJobOptions = {
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
};

export type ReportJobPayload = {
  evidenceId: string;
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
};

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

export const otsUpgradeQueue = new Queue(otsUpgradeQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 20,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

function cleanReason(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw.replace(/[^a-z0-9._-]+/g, "_") || "manual";
}

export function buildReportJobId(
  evidenceId: string,
  options?: EnqueueReportJobOptions
): string {
  if (options?.forceRegenerate) {
    return `report-refresh-${cleanReason(options.regenerateReason)}-${evidenceId}`;
  }

  return `report-${evidenceId}`;
}

export async function enqueueReportJob(
  evidenceId: string,
  options?: EnqueueReportJobOptions
) {
  const payload: ReportJobPayload = {
    evidenceId,
    ...(options?.forceRegenerate
      ? {
          forceRegenerate: true,
          regenerateReason: cleanReason(options.regenerateReason),
        }
      : {}),
  };

  const jobId = buildReportJobId(evidenceId, options);
  const existing = await reportQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();

    if (
      state === "waiting" ||
      state === "delayed" ||
      state === "active" ||
      state === "prioritized"
    ) {
      return { enqueued: false, reason: `job_${state}` };
    }

    try {
      await existing.remove();
    } catch {
      // ignore remove race conditions
    }
  }

  await reportQueue.add(generateReportJobName, payload, {
    jobId,
    attempts: options?.forceRegenerate ? 3 : 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: false,
  });

  return { enqueued: true };
}