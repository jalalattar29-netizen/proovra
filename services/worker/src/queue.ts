/**
 * PHASE 12 — POINT 5: the worker's transport layer.
 *
 * What this file used to be: nineteen `new Queue(...)` declarations each with
 * a hand-written retry policy, twelve enqueue helpers each with its own job-id
 * builder and its own copy of the collapse-or-replace ladder, and a `payload`
 * per queue carrying whatever the producer happened to know — `teamId`,
 * `evidenceId`, `kind`, `reason`, `domain`, `forceRegenerate`, `chunkIds`.
 *
 * What it is now: queue handles, and one delegation.
 *
 * Queue name, job name, payload shape, payload version, job id and retry policy
 * all live in `@proovra/shared/queue-integrity`, and the api calls the SAME
 * `enqueueCanonicalJob` this file does — not the same policy implemented twice.
 * Every producer's only remaining decision is which durable row its command
 * names.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config.js";
// Phase O1.3 — cross-service trace propagation (API enqueue → worker handler).
// PHASE 12 POINT 5 moved the carrier from an unbounded `_otel` blob to a
// validated `traceparent` field on the canonical envelope; see
// `observability/queue-otel-context.ts`.
import {
  currentTraceparent,
  injectOtelContextIntoJobData,
} from "./observability/queue-otel-context.js";
import {
  // PHASE 12 POINT 4 PASS C2 — ONE redaction job identity + enqueue policy.
  REDACTION_DERIVATIVE_JOB_NAME,
  REDACTION_DERIVATIVE_QUEUE_NAME,
  type RedactionDerivativeJobPayload,
  // PHASE 12 POINT 5 — the ONE enqueue authority + the ONE job registry.
  JOB_NAMES,
  QUEUE_NAMES,
  buildGraphDomainCommandId,
  buildSearchIndexCommandId,
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  type GraphSyncDomain,
  type QueueHandleLike,
  type SearchIndexDocumentKind,
  type WorkName,
} from "@proovra/shared";

/**
 * Every name below is now an ALIAS of the registry value, not a second
 * declaration of it.
 *
 * They stay as named exports because the worker bootstrap, the telemetry
 * sampler and the health endpoint read them, and renaming those is churn with
 * no safety gain. What changed is that none of them can hold a different
 * string from the one the producer, the processor, the retry policy and the
 * closure gate all read. Before this, the report queue's name was written out
 * as a literal in three separate files.
 */
export const generateReportJobName = JOB_NAMES.GENERATE_REPORT;
export const reportQueueName = QUEUE_NAMES.REPORT;
export const reportDlqQueueName = QUEUE_NAMES.REPORT_DLQ;
export const otsUpgradeQueueName = QUEUE_NAMES.OTS_UPGRADE;
export const otsUpgradeJobName = JOB_NAMES.UPGRADE_OTS;
export const evidencePurgeQueueName = QUEUE_NAMES.EVIDENCE_PURGE;
export const purgeDeletedEvidenceJobName = JOB_NAMES.PURGE_DELETED_EVIDENCE;
export const searchIndexingQueueName = QUEUE_NAMES.SEARCH_INDEXING;
export const searchIndexingJobName = JOB_NAMES.REBUILD_SEARCH_DOCUMENT;
export const mediaIntelligenceQueueName = QUEUE_NAMES.MEDIA_INTELLIGENCE;
export const mediaIntelligenceDlqQueueName =
  QUEUE_NAMES.MEDIA_INTELLIGENCE_DLQ;
export const mediaIntelligenceJobName = JOB_NAMES.RUN_MEDIA_INTELLIGENCE;
export const derivedAssetsQueueName = QUEUE_NAMES.DERIVED_ASSETS;
export const derivedAssetsJobName = JOB_NAMES.GENERATE_DERIVED_ASSET;
export const redactionDerivativeQueueName = REDACTION_DERIVATIVE_QUEUE_NAME;
export const redactionDerivativeJobName = REDACTION_DERIVATIVE_JOB_NAME;
export const exifQueueName = QUEUE_NAMES.MI_EXIF;
export const exifJobName = JOB_NAMES.EXTRACT_EXIF;
export const miSearchIndexQueueName = QUEUE_NAMES.MI_SEARCH_INDEX;
export const miSearchIndexJobName = JOB_NAMES.INDEX_MEDIA_INTELLIGENCE;
export const miEmbedQueueName = QUEUE_NAMES.MI_EMBED;
export const miEmbedJobName = JOB_NAMES.EMBED_SEMANTIC_CHUNKS;
export const graphReconcileQueueName = QUEUE_NAMES.GRAPH_RECONCILE;
export const graphReconcileJobName = JOB_NAMES.RECONCILE_TEAM_GRAPH;
export const graphDomainSyncQueueName = QUEUE_NAMES.GRAPH_DOMAIN_SYNC;
export const graphDomainSyncJobName = JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN;
export const graphTimelineSyncQueueName = QUEUE_NAMES.GRAPH_TIMELINE_SYNC;
export const graphTimelineSyncJobName = JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE;
export const graphSearchProjectionQueueName =
  QUEUE_NAMES.GRAPH_SEARCH_PROJECTION;
export const graphSearchProjectionJobName =
  JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION;
export const orgHealthRefreshQueueName = QUEUE_NAMES.ORG_HEALTH_REFRESH;
export const orgHealthRefreshJobName = JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION;

/** @deprecated Import `SearchIndexDocumentKind` from `@proovra/shared`. */
export type SearchIndexingDocumentKind = SearchIndexDocumentKind;

export type PurgeDeletedEvidenceJobPayload = {
  evidenceId: string;
};

// ===========================================================================
// Redis
// ===========================================================================

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Phase 32.6.1 — Redis connection observability.
//
// Background: production Sentry showed `connect ECONNREFUSED` events
// when the Redis container was recreated. ioredis tolerated the
// reconnect transparently (workers resumed after Redis came back),
// but the LACK of any logged "redis.reconnected" line made it
// impossible for SRE to confirm recovery without digging into
// process-level diagnostics.
//
// We attach three bounded log lines:
//   * `redis.connection.ready`   — first connect succeeded
//   * `redis.connection.error`   — transient connection-layer error;
//                                  ioredis will retry, NO action
//                                  required from SRE
//   * `redis.connection.close`   — connection closed; pair with the
//                                  next `ready` to confirm recovery
//
// Frequency: each event fires AT MOST once per state transition.
// We do NOT emit on every retry (ioredis fires its own retry events
// internally and we don't want to amplify them into the log stream).
let redisLastReadyAtMs: number | null = null;
let redisLastErrorLoggedAtMs = 0;
const REDIS_ERROR_LOG_THROTTLE_MS = 5_000;

redisConnection.on("ready", () => {
  redisLastReadyAtMs = Date.now();
  // Lazy import to avoid a circular dependency on the worker's
  // logger module during queue construction.
  void import("./logger.js").then(({ logger }) => {
    logger.info(
      { event: "redis.connection.ready", at: new Date().toISOString() },
      "redis.connection.ready",
    );
  });
});

redisConnection.on("error", (err: Error) => {
  const now = Date.now();
  if (now - redisLastErrorLoggedAtMs < REDIS_ERROR_LOG_THROTTLE_MS) return;
  redisLastErrorLoggedAtMs = now;
  void import("./logger.js").then(({ logger }) => {
    logger.warn(
      {
        event: "redis.connection.error",
        code: (err as NodeJS.ErrnoException).code ?? null,
        message: err.message.slice(0, 200),
      },
      "redis.connection.error",
    );
  });
});

redisConnection.on("close", () => {
  void import("./logger.js").then(({ logger }) => {
    logger.warn(
      {
        event: "redis.connection.close",
        lastReadyAtMs: redisLastReadyAtMs,
        at: new Date().toISOString(),
      },
      "redis.connection.close",
    );
  });
});

// ===========================================================================
// Queue construction
// ===========================================================================
//
// Every queue takes its retry policy FROM THE REGISTRY. They used to declare
// their own — `attempts: 3, exponential 10s` written out fifteen times, with
// four different answers for what "bounded" meant — and the enqueue helpers
// then declared them AGAIN at the call site, so a queue's default and its
// producer's per-add options could disagree. They did: the report queue's
// default said 5 attempts while its producer passed 3 for a regeneration and 5
// otherwise, which meant a reconciler re-enqueue ran under a different budget
// than the request path for the same work.

/** BullMQ queue options derived from a registered unit of work. */
function queueOptions(
  workName: WorkName,
  retention: {
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
  } = {},
) {
  const entry = getWorkEntryOrThrow(workName);
  return {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: entry.retry.attempts,
      backoff: {
        type: entry.retry.backoff,
        delay: entry.retry.backoffDelayMs,
      },
      removeOnComplete: retention.removeOnComplete ?? 100,
      removeOnFail: retention.removeOnFail ?? false,
    },
  };
}

export type WorkEnqueueResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: string };

/**
 * The worker's single enqueue path.
 *
 * Behaviourally identical to the api's `enqueueCanonicalWork` because it is the
 * same shared function underneath. That is the property the twelve helpers this
 * replaced did not have: each carried its own copy of the collapse-or-replace
 * ladder, and at least one pair had already drifted on whether a collapsed
 * enqueue reports success.
 *
 * Never throws. A Redis outage is a bounded `{ enqueued: false, reason }`, so a
 * committed durable row stays recoverable rather than taking its caller down.
 */
async function enqueueWork(
  queue: Queue,
  workName: WorkName,
  commandId: string,
  options: {
    traceId?: string | null;
    delayMs?: number;
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
  } = {},
): Promise<WorkEnqueueResult> {
  const outcome = await enqueueCanonicalJob({
    queue: queue as unknown as QueueHandleLike,
    entry: getWorkEntryOrThrow(workName),
    commandId,
    traceId: options.traceId ?? "",
    delayMs: options.delayMs,
    removeOnComplete: options.removeOnComplete,
    removeOnFail: options.removeOnFail,
    traceparent: currentTraceparent(),
  });
  return outcome.enqueued
    ? { enqueued: true, jobId: outcome.jobId }
    : { enqueued: false, reason: outcome.reason };
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

export const reportQueue = new Queue(
  reportQueueName,
  queueOptions(JOB_NAMES.GENERATE_REPORT),
);

/**
 * DLQ sink. No registered job and no worker BY DESIGN: exhausted jobs are
 * moved here for operator triage, and giving it a processor would turn a
 * dead-letter queue into a retry loop.
 */
export const reportDlqQueue = new Queue(reportDlqQueueName, {
  connection: redisConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
});

export const otsUpgradeQueue = new Queue(
  otsUpgradeQueueName,
  queueOptions(JOB_NAMES.UPGRADE_OTS),
);

export const evidencePurgeQueue = new Queue(
  evidencePurgeQueueName,
  queueOptions(JOB_NAMES.PURGE_DELETED_EVIDENCE),
);

export const searchIndexingQueue = new Queue(
  searchIndexingQueueName,
  queueOptions(JOB_NAMES.REBUILD_SEARCH_DOCUMENT, {
    removeOnComplete: 200,
    removeOnFail: 200,
  }),
);

export const mediaIntelligenceQueue = new Queue(
  mediaIntelligenceQueueName,
  queueOptions(JOB_NAMES.RUN_MEDIA_INTELLIGENCE),
);

/** The second DLQ sink. Same design note as `reportDlqQueue`. */
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

export const derivedAssetsQueue = new Queue(
  derivedAssetsQueueName,
  queueOptions(JOB_NAMES.GENERATE_DERIVED_ASSET),
);

export const redactionDerivativeQueue = new Queue(
  redactionDerivativeQueueName,
  queueOptions(JOB_NAMES.RENDER_REDACTION_DERIVATIVE),
);

export const exifQueue = new Queue(
  exifQueueName,
  queueOptions(JOB_NAMES.EXTRACT_EXIF),
);

export const miSearchIndexQueue = new Queue(
  miSearchIndexQueueName,
  queueOptions(JOB_NAMES.INDEX_MEDIA_INTELLIGENCE, {
    removeOnComplete: 200,
    removeOnFail: 200,
  }),
);

export const miEmbedQueue = new Queue(
  miEmbedQueueName,
  queueOptions(JOB_NAMES.EMBED_SEMANTIC_CHUNKS, {
    removeOnComplete: 200,
    removeOnFail: 200,
  }),
);

export const graphReconcileQueue = new Queue(
  graphReconcileQueueName,
  queueOptions(JOB_NAMES.RECONCILE_TEAM_GRAPH, { removeOnComplete: 50 }),
);

export const graphDomainSyncQueue = new Queue(
  graphDomainSyncQueueName,
  queueOptions(JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN, { removeOnComplete: 50 }),
);

export const graphTimelineSyncQueue = new Queue(
  graphTimelineSyncQueueName,
  queueOptions(JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE, { removeOnComplete: 50 }),
);

export const graphSearchProjectionQueue = new Queue(
  graphSearchProjectionQueueName,
  queueOptions(JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION, {
    removeOnComplete: 50,
  }),
);

export const orgHealthRefreshQueue = new Queue(
  orgHealthRefreshQueueName,
  queueOptions(JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION, {
    removeOnComplete: 100,
    removeOnFail: 100,
  }),
);

// ===========================================================================
// Producers
// ===========================================================================
//
// Each producer's ONLY remaining decision is which durable row its command
// names. Everything the old helpers put on the wire — `teamId`, an
// `evidenceId` alongside a run id, `kind` as a free field, `reason`,
// `forceRegenerate`, `domain`, an inline list of chunk ids — is either derived
// by the processor from that row or encoded into the command id against a
// CLOSED catalog.

/** Redaction: the derivative row is the authority. */
export async function enqueueRedactionDerivativeRenderWorker(
  payload: RedactionDerivativeJobPayload,
): Promise<{ enqueued: boolean }> {
  const outcome = await enqueueWork(
    redactionDerivativeQueue,
    JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
    payload.derivativeId,
    { traceId: payload.trace ?? "" },
  );
  return { enqueued: outcome.enqueued };
}

/** Reports: the `ReportGenerationRequest` row is the authority. */
export async function enqueueReportGenerationRequest(
  reportRequestId: string,
  options: { traceId?: string; delayMs?: number } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(reportQueue, JOB_NAMES.GENERATE_REPORT, reportRequestId, {
    traceId: options.traceId,
    delayMs: options.delayMs,
  });
}

/**
 * Search projection rebuild.
 *
 * `teamId` is accepted as producer INPUT for the caller's own attribution and
 * is deliberately not serialised — the processor loads the source row and
 * derives the workspace from it.
 */
export type SearchIndexingJobPayload = {
  teamId?: string | null;
  kind: SearchIndexDocumentKind;
  sourceId: string;
  /** Bounded catalog, e.g. "lifecycle_changed", "operator_reindex". */
  reason: string;
};

export async function enqueueSearchIndexingJob(
  payload: SearchIndexingJobPayload,
  options: { delayMs?: number } = {},
): Promise<WorkEnqueueResult> {
  let commandId: string;
  try {
    commandId = buildSearchIndexCommandId(payload.kind, payload.sourceId);
  } catch {
    return { enqueued: false, reason: "unknown_document_kind" };
  }
  return enqueueWork(
    searchIndexingQueue,
    JOB_NAMES.REBUILD_SEARCH_DOCUMENT,
    commandId,
    {
      traceId: (payload.reason ?? "").slice(0, 64),
      delayMs: options.delayMs,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  );
}

/**
 * OTS upgrade: the Evidence row is the authority.
 *
 * The previous implementation is worth recording because its complexity was
 * load-bearing and is now gone. It paginated every runnable job on the queue
 * looking for one targeting the same evidence, and it appended `Date.now()` to
 * the job id when a job re-enqueued ITSELF — because a stable id collided with
 * the currently-active job, BullMQ refused the add, and the evidence sat in
 * PENDING forever with no future retry.
 *
 * Neither is needed now. The deterministic id IS the dedupe (one live
 * `ots-upgrade-<evidenceId>` at a time, no scan), and the self-reschedule case
 * collapses onto the live job and reports it rather than failing silently. The
 * timestamp suffix is deleted rather than kept: a job id with a clock in it is
 * not deterministic, and two of them for the same evidence would both run.
 */
export async function enqueueOtsUpgradeJob(
  evidenceId: string,
  options: {
    delayMs?: number;
    traceId?: string;
    /**
     * Set by `processOtsUpgrade` when a running job schedules its OWN next
     * follow-up. Without it the enqueue collapses onto the caller's own active
     * job, schedules nothing, and the evidence stays OTS-PENDING forever —
     * which is a real production incident, not a hypothetical.
     */
    selfJobId?: string | number | null;
  } = {},
): Promise<WorkEnqueueResult> {
  const outcome = await enqueueCanonicalJob({
    queue: otsUpgradeQueue as unknown as QueueHandleLike,
    entry: getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS),
    commandId: evidenceId,
    traceId: options.traceId ?? "",
    delayMs: options.delayMs ?? 5 * 60 * 1000,
    traceparent: currentTraceparent(),
    selfJobId: options.selfJobId,
  });
  return outcome.enqueued
    ? { enqueued: true, jobId: outcome.jobId }
    : { enqueued: false, reason: outcome.reason };
}

/** Evidence purge: the Evidence row is the authority. */
export async function enqueueEvidencePurgeJob(
  evidenceId: string,
  runAtUtc: string | Date,
  options: { correlationId?: string } = {},
): Promise<WorkEnqueueResult & { delay: number }> {
  const when =
    runAtUtc instanceof Date ? runAtUtc.getTime() : new Date(runAtUtc).getTime();
  if (!Number.isFinite(when)) {
    return { enqueued: false, reason: "invalid_run_at", delay: 0 };
  }
  const delay = Math.max(0, when - Date.now());
  const outcome = await enqueueWork(
    evidencePurgeQueue,
    JOB_NAMES.PURGE_DELETED_EVIDENCE,
    evidenceId,
    { traceId: options.correlationId ?? "", delayMs: delay },
  );
  return { ...outcome, delay };
}

/**
 * Media intelligence: the `MediaIntelligenceRun` row is the authority.
 *
 * Used by the stranded-run reconciler, which knows only a run id, and by the
 * request path through the api transport client — the same function either way.
 */
export async function enqueueMediaIntelligenceRunById(
  runId: string,
  options: { delayMs?: number; traceId?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    mediaIntelligenceQueue,
    JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    runId,
    { traceId: options.traceId ?? "reconciler", delayMs: options.delayMs },
  );
}

/** Derived assets: the `MediaIntelligenceRun` row is the authority. */
export async function enqueueDerivedAssetJob(
  runId: string,
  options: { delayMs?: number; traceId?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    derivedAssetsQueue,
    JOB_NAMES.GENERATE_DERIVED_ASSET,
    runId,
    { traceId: options.traceId, delayMs: options.delayMs },
  );
}

/**
 * EXIF extraction: the evidence PART is the authority.
 *
 * `mi-exif` and `media-intelligence` used to share one processor AND one
 * payload shape, which meant one function had two identities and its command
 * meant different things depending on which queue delivered it. They are now
 * separate work names with separate authorities: an EXIF job addresses the part
 * whose bytes it reads, and a media-intelligence job addresses the run row that
 * tracks its lifecycle.
 */
export async function enqueueExifJob(
  evidencePartId: string,
  options: { delayMs?: number; traceId?: string } = {},
): Promise<WorkEnqueueResult> {
  if (!evidencePartId.trim()) {
    return { enqueued: false, reason: "evidence_part_id_required" };
  }
  return enqueueWork(exifQueue, JOB_NAMES.EXTRACT_EXIF, evidencePartId, {
    traceId: options.traceId,
    delayMs: options.delayMs,
  });
}

/** Media-intelligence reindex: the Evidence row is the authority. */
export async function enqueueMiSearchIndexJob(
  evidenceId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    miSearchIndexQueue,
    JOB_NAMES.INDEX_MEDIA_INTELLIGENCE,
    evidenceId,
    { traceId: options.reason, delayMs: options.delayMs },
  );
}

/**
 * Semantic embedding: the ANCHOR chunk is the authority.
 *
 * The old payload carried up to 200 chunk ids inline plus a `teamId`. The
 * processor now loads the anchor chunk, derives the workspace from it, and
 * selects the batch itself from rows that are actually still pending — which
 * also closes a real defect: a payload listing chunks that were embedded
 * between enqueue and execution used to re-embed them, spending provider
 * budget on work already done.
 */
export async function enqueueMiEmbedJob(
  anchorChunkId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  if (!anchorChunkId.trim()) {
    return { enqueued: false, reason: "no_chunk_ids" };
  }
  return enqueueWork(
    miEmbedQueue,
    JOB_NAMES.EMBED_SEMANTIC_CHUNKS,
    anchorChunkId,
    {
      traceId: options.reason,
      delayMs: options.delayMs,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  );
}

/** Full graph reconcile: the workspace row is the authority. */
export async function enqueueGraphReconcileJob(
  workspaceId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    graphReconcileQueue,
    JOB_NAMES.RECONCILE_TEAM_GRAPH,
    workspaceId,
    { traceId: options.reason, delayMs: options.delayMs, removeOnComplete: 50 },
  );
}

/**
 * Narrowed graph sync.
 *
 * The domain filter is encoded into the command id against a CLOSED catalog, so
 * an unknown domain fails at the producer. It used to be an optional payload
 * field, which meant an unknown value produced a job the processor silently
 * completed as a no-op — a request that looked accepted and did nothing.
 */
export async function enqueueGraphDomainSyncJob(
  workspaceId: string,
  domain: GraphSyncDomain | null | undefined,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  let commandId: string;
  try {
    commandId = buildGraphDomainCommandId(domain, workspaceId);
  } catch {
    return { enqueued: false, reason: "unknown_graph_domain" };
  }
  return enqueueWork(
    graphDomainSyncQueue,
    JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN,
    commandId,
    { traceId: options.reason, delayMs: options.delayMs, removeOnComplete: 50 },
  );
}

/** Timeline projection refresh: the workspace row is the authority. */
export async function enqueueGraphTimelineSyncJob(
  workspaceId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    graphTimelineSyncQueue,
    JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE,
    workspaceId,
    { traceId: options.reason, delayMs: options.delayMs, removeOnComplete: 50 },
  );
}

/** Graph-derived search hints refresh: the workspace row is the authority. */
export async function enqueueGraphSearchProjectionJob(
  workspaceId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    graphSearchProjectionQueue,
    JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION,
    workspaceId,
    { traceId: options.reason, delayMs: options.delayMs, removeOnComplete: 50 },
  );
}

/** Organization-health projection refresh: the workspace row is the authority. */
export async function enqueueOrgHealthRefreshJob(
  workspaceId: string,
  options: { delayMs?: number; reason?: string } = {},
): Promise<WorkEnqueueResult> {
  return enqueueWork(
    orgHealthRefreshQueue,
    JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION,
    workspaceId,
    {
      traceId: options.reason,
      delayMs: options.delayMs,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
}

// ===========================================================================
// Retained OTEL helper
// ===========================================================================
//
// `injectOtelContextIntoJobData` is no longer used by any producer here — the
// traceparent rides the canonical envelope now — but the DLQ sinks still write
// raw diagnostic records and benefit from the carrier. Re-exported rather than
// deleted so a sink write keeps its trace.
//
// `newQueuePayloadEnvelope` / `QueuePayloadEnvelope` are GONE from this module:
// the Phase-X.1 envelope was the evidence-purge payload shape, and it carried a
// `teamId` a processor could believe.
export { injectOtelContextIntoJobData };
