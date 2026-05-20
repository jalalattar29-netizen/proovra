/**
 * Phase 31.19 — subsystem queue processors.
 *
 * Each of the four new isolated queues (mi-ocr, mi-transcript,
 * mi-search-index, graph-reconcile) gets a thin processor here.
 *
 * Hard contracts:
 *   - Each processor imports the SHARED Prisma instance via ./db.js;
 *     it NEVER constructs its own. (Bare `new PrismaClient()` was
 *     the worker hotfix root cause.)
 *   - Each processor returns within bounded time. The mi-ocr and
 *     mi-transcript processors complete fast in the absence of a
 *     vendor — they record receipt + emit a NOT_CONFIGURED log line
 *     and return. This keeps the queue drain healthy.
 *   - graph-reconcile invokes the existing `reconcileTeamGraph`
 *     service (read-only graph rebuild for one team).
 *   - mi-search-index defers to the existing Phase 24-J search
 *     indexing queue so we keep a single canonical writer for the
 *     search index.
 *
 * The producers for mi-ocr / mi-transcript are gated on the
 * OCR/transcript vendor decision (see Phase 31.19 producer mode).
 * Until a producer enqueues these, the queues stay empty and the
 * workers idle.
 */

import type { Job } from "bullmq";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import type {
  GraphDomainSyncJobPayload,
  GraphReconcileJobPayload,
  GraphSearchProjectionJobPayload,
  GraphTimelineSyncJobPayload,
  MiSearchIndexJobPayload,
  OcrJobPayload,
  TranscriptJobPayload,
} from "./queue.js";

// =============================================================================
// mi-ocr — gated on OCR vendor decision. Records receipt and emits
// a single NOT_CONFIGURED log line.
// =============================================================================

export async function processOcrJob(
  job: Job<OcrJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "mi-ocr",
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
      evidencePartId: job.data.evidencePartId ?? null,
    },
    "mi_ocr.received",
  );
  // Vendor producer not yet configured. We complete the job rather
  // than failing so the queue stays drained.
  logger.warn(
    {
      jobId: job.id ?? null,
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
    },
    "mi_ocr.not_configured_completed",
  );
}

// =============================================================================
// mi-transcript — same shape as mi-ocr.
// =============================================================================

export async function processTranscriptJob(
  job: Job<TranscriptJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "mi-transcript",
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
      evidencePartId: job.data.evidencePartId ?? null,
    },
    "mi_transcript.received",
  );
  logger.warn(
    {
      jobId: job.id ?? null,
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
    },
    "mi_transcript.not_configured_completed",
  );
}

// =============================================================================
// mi-search-index — bounded reindex trigger for a single evidence.
// Defers to the existing search-indexing queue.
// =============================================================================

export async function processMiSearchIndexJob(
  job: Job<MiSearchIndexJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "mi-search-index",
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
      reason: job.data.reason,
    },
    "mi_search_index.received",
  );
  const { enqueueSearchIndexingJob } = await import("./queue.js");
  const r = await enqueueSearchIndexingJob({
    teamId: job.data.teamId,
    kind: "evidence",
    sourceId: job.data.evidenceId,
    reason: job.data.reason,
  });
  logger.info(
    {
      jobId: job.id ?? null,
      teamId: job.data.teamId,
      evidenceId: job.data.evidenceId,
      delegated: r,
    },
    "mi_search_index.delegated_to_search_indexing_queue",
  );
}

// =============================================================================
// graph-reconcile — invokes the read-only reconciler for one team.
// =============================================================================

export async function processGraphReconcileJob(
  job: Job<GraphReconcileJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "graph-reconcile",
      teamId: job.data.teamId,
      reason: job.data.reason ?? null,
    },
    "graph_reconcile.received",
  );
  try {
    const { reconcileTeamGraph } = await import(
      "../../api/src/services/graph/graph-builder.service.js"
    );
    const result = await reconcileTeamGraph(job.data.teamId, prisma);
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        ok: result.ok,
        nodesUpserted: result.nodesUpserted,
        edgesUpserted: result.edgesUpserted,
        edgesStaled: result.edgesStaled,
      },
      "graph_reconcile.completed",
    );
  } catch (err) {
    logger.error(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_reconcile.failed",
    );
    throw err;
  }

  // Phase 31.20 — opportunistic OCR/transcript indexing producer
  // sidecar. The graph reconcile is the natural place to also emit
  // OCR_AVAILABLE / OCR_INDEXED / TRANSCRIPT_AVAILABLE /
  // TRANSCRIPT_INDEXED signals from existing rows. Gated on the
  // producer mode env so the call is a no-op when extraction is
  // explicitly NOT_CONFIGURED.
  //
  // Failure is non-blocking — a failed indexer pass MUST NOT fail
  // the graph reconcile (which has already succeeded above).
  try {
    const { summariseProducerModes } = await import(
      "../../api/src/services/media-intelligence/producer-mode.js"
    );
    const modes = summariseProducerModes();
    const anyIndexing =
      modes.ocr !== "NOT_CONFIGURED" || modes.transcript !== "NOT_CONFIGURED";
    if (anyIndexing) {
      const { indexExistingOcrAndTranscript } = await import(
        "../../api/src/services/media-intelligence/ocr-transcript-indexer.service.js"
      );
      const indexerResult = await indexExistingOcrAndTranscript(
        { teamId: job.data.teamId },
        prisma,
      );
      logger.info(
        {
          jobId: job.id ?? null,
          teamId: job.data.teamId,
          modes,
          indexer: indexerResult,
        },
        "graph_reconcile.ocr_transcript_indexer_completed",
      );
    } else {
      logger.info(
        {
          jobId: job.id ?? null,
          teamId: job.data.teamId,
        },
        "graph_reconcile.ocr_transcript_indexer_skipped_not_configured",
      );
    }
  } catch (err) {
    logger.warn(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_reconcile.ocr_transcript_indexer_failed_non_fatal",
    );
  }
}

// =============================================================================
// Phase 31.20 — graph-domain-sync / graph-timeline-sync /
// graph-search-projection
//
// All three queues delegate to the existing reconciler today. The
// distinct queue names let SRE dashboards split per-queue backlog,
// per-queue oldest-pending-age, and per-queue DLQ behavior without
// needing a producer split. A future incremental projection writer
// can replace each processor body without changing the queue
// contract.
// =============================================================================

export async function processGraphDomainSyncJob(
  job: Job<GraphDomainSyncJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "graph-domain-sync",
      teamId: job.data.teamId,
      domain: job.data.domain ?? null,
      reason: job.data.reason ?? null,
    },
    "graph_domain_sync.received",
  );
  // Phase 31.21 — real bounded domain sync. The job either targets
  // a single named domain (preferred — incremental) or runs a sweep
  // across all bounded catalog domains.
  try {
    const { DOMAIN_SYNC_DOMAINS, runDomainStaleSweep } = await import(
      "../../api/src/services/graph/domain-sync.service.js"
    );
    const targets = job.data.domain
      ? [job.data.domain]
      : (DOMAIN_SYNC_DOMAINS as readonly string[]);
    let totalTombstoned = 0;
    const perDomain: Array<{
      domain: string;
      ok: boolean;
      tombstoned: number;
      reason?: string;
    }> = [];
    for (const d of targets) {
      // Bounded vocabulary check — only the bounded catalog domains
      // are processed; an unknown value short-circuits to a logged
      // skip without throwing.
      if (
        !(DOMAIN_SYNC_DOMAINS as readonly string[]).includes(d as string)
      ) {
        perDomain.push({
          domain: String(d),
          ok: false,
          tombstoned: 0,
          reason: "unknown_domain",
        });
        continue;
      }
      const r = await runDomainStaleSweep(
        job.data.teamId,
        d as (typeof DOMAIN_SYNC_DOMAINS)[number],
        prisma,
      );
      perDomain.push({
        domain: r.domain,
        ok: r.ok,
        tombstoned: r.tombstoned,
        reason: r.reason,
      });
      totalTombstoned += r.tombstoned;
    }
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        domain: job.data.domain ?? "all",
        totalTombstoned,
        perDomain,
      },
      "graph_domain_sync.completed",
    );
  } catch (err) {
    // The runDomainStaleSweep helper never throws — but the import
    // can fail (very unlikely; defense in depth).
    logger.error(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_domain_sync.failed",
    );
    throw err;
  }
}

export async function processGraphTimelineSyncJob(
  job: Job<GraphTimelineSyncJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "graph-timeline-sync",
      teamId: job.data.teamId,
      reason: job.data.reason ?? null,
    },
    "graph_timeline_sync.received",
  );
  // Phase 31.21 — real bounded timeline sync. Builds the bounded
  // timeline to record its current size + runs the cross-edge stale
  // sweep that tombstones edges whose endpoints both went stale.
  try {
    const { runTimelineSync } = await import(
      "../../api/src/services/graph/domain-sync.service.js"
    );
    const result = await runTimelineSync(job.data.teamId, prisma);
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        ok: result.ok,
        eventCount: result.eventCount,
        truncated: result.truncated,
        edgesStaled: result.edgesStaled,
        reason: result.reason,
      },
      "graph_timeline_sync.completed",
    );
  } catch (err) {
    logger.error(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_timeline_sync.failed",
    );
    throw err;
  }
}

export async function processGraphSearchProjectionJob(
  job: Job<GraphSearchProjectionJobPayload, void, string>,
): Promise<void> {
  logger.info(
    {
      jobId: job.id ?? null,
      kind: "graph-search-projection",
      teamId: job.data.teamId,
      reason: job.data.reason ?? null,
    },
    "graph_search_projection.received",
  );
  // Phase 31.21 — real bounded search projection sync. Finds
  // evidence rows with recent signal activity (last hour) and
  // enqueues bounded search-index rebuilds for them via the
  // existing Phase 24-J search indexing queue. Idempotent
  // (the underlying enqueue collapses dups).
  try {
    const { runSearchProjectionSync } = await import(
      "../../api/src/services/graph/domain-sync.service.js"
    );
    // Provide an explicit enqueueImpl that uses the worker's
    // already-loaded queue helper — avoids a second Redis
    // connection and avoids the dynamic-import path the service's
    // default uses (which is the fallback for API-only callers).
    const { enqueueSearchIndexingJob } = await import("./queue.js");
    const result = await runSearchProjectionSync(job.data.teamId, prisma, {
      enqueueImpl: async (input) => {
        const r = await enqueueSearchIndexingJob({
          teamId: input.teamId,
          kind: "evidence",
          sourceId: input.evidenceId,
          reason: input.reason,
        });
        return { enqueued: Boolean(r.enqueued) };
      },
    });
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        ok: result.ok,
        enqueued: result.enqueued,
        reason: result.reason,
      },
      "graph_search_projection.completed",
    );
  } catch (err) {
    logger.error(
      {
        jobId: job.id ?? null,
        teamId: job.data.teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_search_projection.failed",
    );
    throw err;
  }
}
