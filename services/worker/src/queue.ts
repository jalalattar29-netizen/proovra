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
  newQueuePayloadEnvelope,
  type QueuePayloadEnvelope,
} from "@proovra/shared";

export { generateReportJobName };

export const reportQueueName = "report";
export const reportDlqQueueName = "report-dlq";
export const otsUpgradeQueueName = "ots-upgrade";
export const otsUpgradeJobName = "UpgradeOts";
export const evidencePurgeQueueName = "evidence-purge";
export const purgeDeletedEvidenceJobName = "PurgeDeletedEvidenceJob";

// Phase 24-J — async Search Discovery indexing queue. Replaces inline
// indexing on the request path so heavy index builds (multipart OCR
// rollup, workflow event chains, etc.) don't block the API.
export const searchIndexingQueueName = "search-indexing";
export const searchIndexingJobName = "RebuildSearchDocument";

export type SearchIndexingDocumentKind =
  | "evidence"
  | "workflow_instance"
  | "workflow_step"
  | "review_event"
  | "operational_incident"
  | "case";

export type SearchIndexingJobPayload = {
  teamId: string;
  kind: SearchIndexingDocumentKind;
  sourceId: string;
  /**
   * Why this rebuild was enqueued. Bounded catalog so the audit trail
   * + worker logs stay scanable. Examples: "lifecycle_changed",
   * "legal_hold_placed", "operator_reindex", "ocr_segment_indexed".
   */
  reason: string;
};

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

// Phase 24-J — async Search Discovery indexing queue.
export const searchIndexingQueue = new Queue(searchIndexingQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});

export function buildSearchIndexingJobId(
  kind: SearchIndexingDocumentKind,
  sourceId: string,
): string {
  return `search-index-${kind}-${sourceId}`;
}

/**
 * Enqueue a Discovery index rebuild. Idempotent — repeat calls collapse
 * to the existing job. Never throws to the calling flow; a Redis outage
 * returns `enqueued: false, reason: "queue_unavailable"` and the caller
 * relies on the periodic reconciliation cron to catch the drift.
 */
export async function enqueueSearchIndexingJob(
  payload: SearchIndexingJobPayload,
  options: { delayMs?: number } = {},
): Promise<
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string }
> {
  const jobId = buildSearchIndexingJobId(payload.kind, payload.sourceId);
  try {
    const existing = await searchIndexingQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (
        state === "waiting" ||
        state === "delayed" ||
        state === "active" ||
        state === "prioritized"
      ) {
        // Already queued or running — collapse to existing.
        return { enqueued: false, reason: `job_${state}` };
      }
      try {
        await existing.remove();
      } catch {
        // ignore race
      }
    }
    await searchIndexingQueue.add(searchIndexingJobName, payload, {
      jobId,
      delay: Math.max(0, options.delayMs ?? 0),
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 200,
      removeOnFail: 200,
    });
    return { enqueued: true, jobId };
  } catch (err) {
    return {
      enqueued: false,
      reason:
        err instanceof Error
          ? `queue_unavailable:${err.message.slice(0, 80)}`
          : "queue_unavailable",
    };
  }
}

export function buildOtsUpgradeJobId(evidenceId: string): string {
  return `ots-upgrade-${evidenceId}`;
}

function isRunnableQueueState(state: string): boolean {
  return (
    state === "waiting" ||
    state === "delayed" ||
    state === "active" ||
    state === "prioritized"
  );
}

async function findRunnableOtsUpgradeJobForEvidence(
  evidenceId: string,
  excludeJobId?: string | number | null
) {
  const states = ["waiting", "delayed", "active", "prioritized"] as const;
  const batchSize = 1000;
  let start = 0;

  while (true) {
    const jobs = await otsUpgradeQueue.getJobs(
      [...states],
      start,
      start + batchSize - 1
    );

    const existing = jobs.find((job) => {
      if (String(job.id) === String(excludeJobId ?? "")) return false;
      return job.data?.evidenceId === evidenceId;
    });

    if (existing) return existing;
    if (jobs.length < batchSize) return null;

    start += batchSize;
  }
}

export async function enqueueOtsUpgradeJob(
  evidenceId: string,
  options?: {
    delayMs?: number;
    jobId?: string;
    excludeJobId?: string | number | null;
  }
) {
  const jobId = options?.jobId ?? buildOtsUpgradeJobId(evidenceId);
  const existing = await otsUpgradeQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();

    if (isRunnableQueueState(state)) {
      return { enqueued: false, reason: `job_${state}` };
    }

    try {
      await existing.remove();
    } catch {
      // ignore remove race conditions
    }
  }

  const existingRunnableForEvidence =
    await findRunnableOtsUpgradeJobForEvidence(
      evidenceId,
      options?.excludeJobId
    );

  if (existingRunnableForEvidence) {
    const state = await existingRunnableForEvidence.getState();
    return { enqueued: false, reason: `job_${state}` };
  }

  await otsUpgradeQueue.add(
    otsUpgradeJobName,
    { evidenceId },
    {
      jobId,
      delay: Math.max(0, options?.delayMs ?? 5 * 60 * 1000),
      attempts: 20,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true };
}

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
  runAtUtc: string | Date,
  options: { correlationId?: string; teamId?: string | null } = {},
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

  // Phase X.1 — wrap the payload in the canonical queue envelope.
  // Downstream processor uses `parseQueueEnvelope` so legacy in-flight
  // raw payloads still drain. `jobId` doubles as idempotency key — the
  // queue refuses a second add with the same id.
  const envelope: QueuePayloadEnvelope<PurgeDeletedEvidenceJobPayload> =
    newQueuePayloadEnvelope({
      kind: purgeDeletedEvidenceJobName,
      idempotencyKey: jobId,
      body: { evidenceId },
      correlationId: options.correlationId,
      teamId: options.teamId ?? null,
    });

  await evidencePurgeQueue.add(
    purgeDeletedEvidenceJobName,
    envelope,
    {
      jobId,
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true, delay, correlationId: envelope.correlationId };
}
