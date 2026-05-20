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

// Phase 31.6 — async media intelligence orchestration. One queue
// + one DLQ. Job kinds are bounded (matches the Phase 31.5 run
// tracker's catalog) and carry only `{ teamId, evidenceId, kind }`
// — never raw evidence content. Processor uses the shared
// canonical Prisma instance from ./db.ts.
export const mediaIntelligenceQueueName = "media-intelligence";
export const mediaIntelligenceDlqQueueName = "media-intelligence-dlq";
export const mediaIntelligenceJobName = "RunMediaIntelligence";

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

// Phase 31.6 — media intelligence queue + DLQ. Bounded attempts
// (3) + exponential backoff (10s → 80s). `removeOnFail: false`
// keeps failed jobs visible to operations until manually
// dismissed / retried. DLQ collects jobs that exhaust retries so
// operations can replay them.
export const mediaIntelligenceQueue = new Queue(mediaIntelligenceQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export const mediaIntelligenceDlqQueue = new Queue(
  mediaIntelligenceDlqQueueName,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  },
);

// Phase 31.13 — dedicated `mi-derived-assets` queue. First of 9
// isolated subsystem queues per the Phase 31 brief. Per-queue
// concurrency, per-queue retry policy, isolated DLQ. The processor
// runs sharp; capability detection inside the processor itself
// degrades gracefully on environments where sharp can't load.
export const derivedAssetsQueueName = "mi-derived-assets";
export const derivedAssetsJobName = "GenerateDerivedAsset";

export const derivedAssetsQueue = new Queue(derivedAssetsQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

// Phase 31.18 — dedicated `mi-exif` queue. Second of 9 isolated
// subsystem queues. EXIF extraction reads a bounded byte range
// (16KB) per evidence-part and parses with `exifr`. Isolation
// keeps EXIF jobs from being head-of-line blocked by analyzer
// runs (which can take seconds to scan the parts table for a
// large evidence record).
//
// The processor SHARES the same media-intelligence job handler —
// the producer just routes the `extract_exif` kind to this queue
// instead of the generic media-intelligence queue. This is purely
// a queue-isolation pattern; no behavior change.
export const exifQueueName = "mi-exif";
export const exifJobName = "ExtractExif";

export const exifQueue = new Queue(exifQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

// Phase 31.19 — four more isolated subsystem queues. These bring
// the count of isolated queues to 6 of 9. Each queue declaration
// follows the established pattern:
//   * dedicated name + job name
//   * bounded attempts + exponential backoff
//   * `removeOnFail: false` so operations keeps visibility on
//     stuck jobs (DLQ-shaped behavior without a separate queue)
//   * Worker registration in index.ts pairs with a deterministic
//     idempotent `buildXJobId` helper below.
//
// Until concrete producer code lands for each subsystem (OCR
// vendor, transcript vendor, graph-reconcile cron split), the
// queues exist as declared targets so SRE can wire dashboards
// and oncall pages today. The Worker in index.ts uses the same
// `processMediaIntelligenceJob` / `processGraphReconcileJob`
// shim for the mi-* family; the graph queues are wired to a
// shared no-op handler that completes immediately when its
// payload `kind` isn't yet implemented — this keeps the queue
// drain healthy when an operator manually enqueues to verify
// the topology.

export const ocrQueueName = "mi-ocr";
export const ocrJobName = "ExtractOcr";

export const ocrQueue = new Queue(ocrQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export const transcriptQueueName = "mi-transcript";
export const transcriptJobName = "ExtractTranscript";

export const transcriptQueue = new Queue(transcriptQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  },
});

export const miSearchIndexQueueName = "mi-search-index";
export const miSearchIndexJobName = "IndexMediaIntelligence";

export const miSearchIndexQueue = new Queue(miSearchIndexQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});

export const graphReconcileQueueName = "graph-reconcile";
export const graphReconcileJobName = "ReconcileTeamGraph";

export const graphReconcileQueue = new Queue(graphReconcileQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 50,
    removeOnFail: false,
  },
});

// Phase 31.20 — final three isolated graph subsystem queues. All 9
// isolated subsystem queues now exist.
//
// `graph-domain-sync` runs the per-team domain reconciler with an
// optional `domain` filter so a single misbehaving domain (e.g.
// EXTERNAL_REVIEW) can be re-synced without re-running the full
// reconcile cron.
//
// `graph-timeline-sync` refreshes timeline projections for a team.
// Today the timeline is computed on-demand from union queries — the
// queue exists so a future incremental projection cache has a
// canonical job target.
//
// `graph-search-projection` refreshes graph-derived search hints
// (e.g. signal counts on evidence search documents). Today this is
// covered by the analyzer-side rebuild, but the queue exists so a
// future projection writer has a canonical job target.
//
// All three reuse the same lightweight idempotent enqueue helper +
// safeRegisterWorker pattern as the prior 6 queues.
export const graphDomainSyncQueueName = "graph-domain-sync";
export const graphDomainSyncJobName = "SyncTeamGraphDomain";
export const graphDomainSyncQueue = new Queue(graphDomainSyncQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 50,
    removeOnFail: false,
  },
});

export const graphTimelineSyncQueueName = "graph-timeline-sync";
export const graphTimelineSyncJobName = "SyncTeamGraphTimeline";
export const graphTimelineSyncQueue = new Queue(graphTimelineSyncQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 50,
    removeOnFail: false,
  },
});

export const graphSearchProjectionQueueName = "graph-search-projection";
export const graphSearchProjectionJobName = "RefreshGraphSearchProjection";
export const graphSearchProjectionQueue = new Queue(
  graphSearchProjectionQueueName,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 50,
      removeOnFail: false,
    },
  },
);

export type GraphDomainSyncJobPayload = {
  teamId: string;
  /** Optional bounded domain filter. When null the job runs the
   *  full reconciler (effectively equivalent to graph-reconcile). */
  domain?:
    | "CASE"
    | "REPORT"
    | "VERIFICATION_PACKAGE"
    | "EXPORT"
    | "REVIEW_TASK"
    | "ESCALATION"
    | "INCIDENT"
    | "EXTERNAL_REVIEW"
    | null;
  reason?: string | null;
};

export type GraphTimelineSyncJobPayload = {
  teamId: string;
  reason?: string | null;
};

export type GraphSearchProjectionJobPayload = {
  teamId: string;
  reason?: string | null;
};

export function buildGraphDomainSyncJobId(
  teamId: string,
  domain: string | null | undefined,
): string {
  const d = (domain ?? "all").toLowerCase();
  return `graph-domain-sync-${teamId}-${d}`;
}

export function buildGraphTimelineSyncJobId(teamId: string): string {
  return `graph-timeline-sync-${teamId}`;
}

export function buildGraphSearchProjectionJobId(teamId: string): string {
  return `graph-search-projection-${teamId}`;
}

export async function enqueueGraphDomainSyncJob(
  payload: GraphDomainSyncJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  const jobId = buildGraphDomainSyncJobId(payload.teamId, payload.domain ?? null);
  return genericIdempotentEnqueue(
    graphDomainSyncQueue,
    graphDomainSyncJobName,
    jobId,
    payload,
    options,
  );
}

export async function enqueueGraphTimelineSyncJob(
  payload: GraphTimelineSyncJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  const jobId = buildGraphTimelineSyncJobId(payload.teamId);
  return genericIdempotentEnqueue(
    graphTimelineSyncQueue,
    graphTimelineSyncJobName,
    jobId,
    payload,
    options,
  );
}

export async function enqueueGraphSearchProjectionJob(
  payload: GraphSearchProjectionJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  const jobId = buildGraphSearchProjectionJobId(payload.teamId);
  return genericIdempotentEnqueue(
    graphSearchProjectionQueue,
    graphSearchProjectionJobName,
    jobId,
    payload,
    options,
  );
}

export type OcrJobPayload = {
  teamId: string;
  evidenceId: string;
  evidencePartId?: string | null;
};

export type TranscriptJobPayload = {
  teamId: string;
  evidenceId: string;
  evidencePartId?: string | null;
};

export type MiSearchIndexJobPayload = {
  teamId: string;
  evidenceId: string;
  /** Why this reindex was enqueued. Bounded catalog. */
  reason: string;
};

export type GraphReconcileJobPayload = {
  teamId: string;
  /** Operator-supplied reason for manual reconciles. Bounded. */
  reason?: string | null;
};

export function buildOcrJobId(evidencePartId: string): string {
  return `mi-ocr-${evidencePartId}`;
}

export function buildTranscriptJobId(evidencePartId: string): string {
  return `mi-transcript-${evidencePartId}`;
}

export function buildMiSearchIndexJobId(evidenceId: string): string {
  return `mi-search-index-${evidenceId}`;
}

export function buildGraphReconcileJobId(teamId: string): string {
  return `graph-reconcile-${teamId}`;
}

/**
 * Idempotent enqueue helper for the mi-ocr queue. Follows the
 * exact same shape as enqueueExifJob (Phase 31.18) — see that
 * helper for invariant documentation. The OCR producer side is
 * still gated on a vendor decision (see Phase 31.19 OCR/transcript
 * producer mode), so this helper is part of the wiring topology
 * rather than an active producer path today.
 */
async function genericIdempotentEnqueue<P extends { teamId: string }>(
  queue: Queue,
  jobName: string,
  jobId: string,
  payload: P,
  options: { delayMs?: number },
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  try {
    const existing = await queue.getJob(jobId);
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
        // ignore race
      }
    }
    await queue.add(jobName, payload, {
      jobId,
      delay: Math.max(0, options.delayMs ?? 0),
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

export async function enqueueOcrJob(
  payload: OcrJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  if (!payload.evidencePartId) {
    return { enqueued: false, reason: "evidence_part_id_required" };
  }
  const jobId = buildOcrJobId(payload.evidencePartId);
  return genericIdempotentEnqueue(ocrQueue, ocrJobName, jobId, payload, options);
}

export async function enqueueTranscriptJob(
  payload: TranscriptJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  if (!payload.evidencePartId) {
    return { enqueued: false, reason: "evidence_part_id_required" };
  }
  const jobId = buildTranscriptJobId(payload.evidencePartId);
  return genericIdempotentEnqueue(
    transcriptQueue,
    transcriptJobName,
    jobId,
    payload,
    options,
  );
}

export async function enqueueMiSearchIndexJob(
  payload: MiSearchIndexJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  const jobId = buildMiSearchIndexJobId(payload.evidenceId);
  return genericIdempotentEnqueue(
    miSearchIndexQueue,
    miSearchIndexJobName,
    jobId,
    payload,
    options,
  );
}

export async function enqueueGraphReconcileJob(
  payload: GraphReconcileJobPayload,
  options: { delayMs?: number } = {},
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: string }> {
  const jobId = buildGraphReconcileJobId(payload.teamId);
  return genericIdempotentEnqueue(
    graphReconcileQueue,
    graphReconcileJobName,
    jobId,
    payload,
    options,
  );
}

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

// =============================================================================
// Phase 31.6 — Media intelligence enqueue helper
// =============================================================================

export type MediaIntelligenceJobKind =
  | "analyze_metadata"
  // Phase 31.8 — real EXIF extraction (bytes → bounded summary).
  | "extract_exif"
  | "extract_assets"
  | "compute_duplicates"
  | "compute_lineage"
  | "wire_ocr_transcript"
  | "reindex"
  | "reconcile";

export type MediaIntelligenceJobPayload = {
  teamId: string;
  evidenceId: string;
  kind: MediaIntelligenceJobKind;
  /** Optional run id from media_intelligence_runs (set by the
   *  producer when the run tracker row already exists). */
  runId?: string | null;
  /** Phase 31.8 — Optional evidence-part-id. When the job kind is
   *  per-part (e.g. extract_exif on a specific multipart material),
   *  the producer pins which part the worker should fetch. */
  evidencePartId?: string | null;
};

/** Deterministic job id — collapses duplicate triggers for the same
 *  (kind, evidenceId). One queued/active job per (kind, evidenceId)
 *  at a time. */
export function buildMediaIntelligenceJobId(
  kind: MediaIntelligenceJobKind,
  evidenceId: string,
): string {
  return `mi-${kind}-${evidenceId}`;
}

/**
 * Enqueue a media intelligence job. Idempotent — repeat calls
 * collapse to the existing queued/active/delayed job. Never throws
 * to the calling flow; a Redis outage returns
 * `{ enqueued: false, reason: "queue_unavailable" }` so the producer
 * (POST /v1/evidence/:id/media-intelligence/run) can surface a 503
 * without blocking the evidence lifecycle.
 */
export async function enqueueMediaIntelligenceJob(
  payload: MediaIntelligenceJobPayload,
  options: { delayMs?: number } = {},
): Promise<
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string }
> {
  const jobId = buildMediaIntelligenceJobId(payload.kind, payload.evidenceId);
  try {
    const existing = await mediaIntelligenceQueue.getJob(jobId);
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
        // ignore race
      }
    }
    await mediaIntelligenceQueue.add(mediaIntelligenceJobName, payload, {
      jobId,
      delay: Math.max(0, options.delayMs ?? 0),
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: false,
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

// =============================================================================
// Phase 31.18 — Dedicated EXIF enqueue helper
// =============================================================================

/** Deterministic job id — collapses duplicate triggers on the same
 *  evidence-part. One queued/active EXIF job per (evidencePartId) at
 *  a time. */
export function buildExifJobId(evidencePartId: string): string {
  return `mi-exif-${evidencePartId}`;
}

/**
 * Enqueue a real EXIF extraction job into the dedicated `mi-exif`
 * queue. Idempotent — repeat calls collapse to the existing job.
 * Never throws to the calling flow; a Redis outage returns
 * `{ enqueued: false, reason: "queue_unavailable" }` so the producer
 * surfaces a 503 without blocking the evidence lifecycle.
 *
 * The payload shape matches the generic media-intelligence payload
 * (`kind: "extract_exif"` is required) so the same processor branch
 * handles both queues.
 */
export async function enqueueExifJob(
  payload: MediaIntelligenceJobPayload,
  options: { delayMs?: number } = {},
): Promise<
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string }
> {
  if (payload.kind !== "extract_exif") {
    return { enqueued: false, reason: "invalid_kind_for_exif_queue" };
  }
  if (!payload.evidencePartId) {
    return { enqueued: false, reason: "evidence_part_id_required" };
  }
  const jobId = buildExifJobId(payload.evidencePartId);
  try {
    const existing = await exifQueue.getJob(jobId);
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
        // ignore race
      }
    }
    await exifQueue.add(exifJobName, payload, {
      jobId,
      delay: Math.max(0, options.delayMs ?? 0),
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: false,
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

