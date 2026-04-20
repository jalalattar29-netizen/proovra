import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config.js";
import {
  buildReportJobId,
  buildReportJobPayload,
  decideReportJobEnqueueAction,
  EnqueueReportJobOptions,
  ReportJobPayload,
  generateReportJobName,
} from "@proovra/shared";

export { generateReportJobName };

export const reportQueueName = "report";
export const reportDlqQueueName = "report-dlq";
export const otsUpgradeQueueName = "ots-upgrade";
export const evidencePurgeQueueName = "evidence-purge";
export const purgeDeletedEvidenceJobName = "PurgeDeletedEvidenceJob";

export type PurgeDeletedEvidenceJobPayload = {
  evidenceId: string;
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

export const evidencePurgeQueue = new Queue(evidencePurgeQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export async function enqueueReportJob(
  evidenceId: string,
  options?: EnqueueReportJobOptions
) {
  const payload: ReportJobPayload = buildReportJobPayload(
    evidenceId,
    options
  );

  const jobId = buildReportJobId(evidenceId, options);
  const existing = await reportQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    const decision = decideReportJobEnqueueAction(state);

    if (decision.action === "skip") {
      return { enqueued: false, reason: decision.reason };
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

export function buildEvidencePurgeJobId(evidenceId: string): string {
  return `evidence-purge-${evidenceId}`;
}

export async function enqueueEvidencePurgeJob(
  evidenceId: string,
  runAtUtc: string | Date
) {
  const when =
    runAtUtc instanceof Date ? runAtUtc.getTime() : new Date(runAtUtc).getTime();

  if (!Number.isFinite(when)) {
    throw new Error("enqueueEvidencePurgeJob: invalid runAtUtc");
  }

  const delay = Math.max(0, when - Date.now());
  const jobId = buildEvidencePurgeJobId(evidenceId);

  const existing = await evidencePurgeQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();

    if (
      state === "waiting" ||
      state === "delayed" ||
      state === "active" ||
      state === "prioritized"
    ) {
      try {
        await existing.remove();
      } catch {
        // ignore remove race conditions
      }
    } else {
      try {
        await existing.remove();
      } catch {
        // ignore remove race conditions
      }
    }
  }

  await evidencePurgeQueue.add(
    purgeDeletedEvidenceJobName,
    { evidenceId },
    {
      jobId,
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true, delay };
}
