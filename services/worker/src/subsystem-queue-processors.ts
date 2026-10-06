/**
 * Phase 31.19 — subsystem queue processors.
 *
 * Each of the isolated subsystem queues (graph-reconcile and
 * graph-search-projection) gets a thin processor here.
 *
 * Hard contracts:
 *   - Each processor imports the SHARED Prisma instance via ./db.js;
 *     it NEVER constructs its own. (Bare `new PrismaClient()` was
 *     the worker hotfix root cause.)
 *   - Each processor returns within bounded time.
 *   - graph-reconcile invokes the existing `reconcileTeamGraph`
 *     service (read-only graph rebuild for one team).
 *   - graph-search-projection defers to the existing Phase 24-J search
 *     indexing queue so we keep a single canonical writer for the
 *     search index.
 *   - PHASE 12 POINT 5: no processor here reports completion for work
 *     it did not perform. The two that did — `mi-ocr` and
 *     `mi-transcript` — are gone; see the note below.
 *   - ET-Q-07 (2026-09-30): no processor here sits behind a queue with
 *     no producer. The four that did are gone; see the note below.
 */

import type { Job } from "bullmq";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
// Phase O1.5D — bounded graph spans. Attributes carry only the
// bounded teamId + operation. NEVER raw graph data or PII.
import { PROOVRA_SPAN_NAMES, withProovraSpan } from "./otel.js";
import { randomUUID } from "node:crypto";

import { JOB_NAMES, type WorkName } from "@proovra/shared";

import {
  decodeCanonicalJob,
  resolveActiveWorkspace,
  type JobLike,
} from "./canonical-job.js";

/**
 * PHASE 12 — POINT 5: the shared preamble for the workspace-scoped subsystem
 * jobs.
 *
 * Both processors in this file address a WORKSPACE rather than a
 * row inside one, so their command id is a workspace id. That is a reference,
 * not an assertion: it must resolve to a live Team, and the owning
 * Organization must still be ACTIVE, before any work happens. A suspended
 * organization's projections are not rebuilt.
 *
 * Returns null when the job should complete as a bounded no-op — logged, not
 * thrown, because neither a deleted workspace nor a suspended organization
 * becomes valid on a retry.
 */
async function resolveWorkspaceJob(
  workName: WorkName,
  job: JobLike,
  logKind: string,
): Promise<{ workspaceId: string; reason: string; requestId: string } | null> {
  const requestId = randomUUID();
  const decoded = decodeCanonicalJob(workName, job, { requestId });
  const resolved = await resolveActiveWorkspace(prisma, decoded.commandId);
  if (!resolved) {
    logger.warn(
      { requestId, jobId: job.id ?? null, kind: logKind },
      `${logKind}.workspace_unresolved_or_inactive`,
    );
    return null;
  }
  return {
    workspaceId: resolved.workspaceId,
    reason: decoded.traceId || "unspecified",
    requestId,
  };
}

// =============================================================================
// PHASE 12 — POINT 5: the `mi-ocr` and `mi-transcript` no-op processors are
// GONE, together with their queues, their unused producers and their registry
// entries.
//
// They were the second authority for two capabilities that already had a real
// one. OCR and transcript extraction run on the `media-intelligence` queue,
// under the `extract_ocr_azure` / `extract_transcript_deepgram` run kinds,
// against a durable `MediaIntelligenceRun` row: provider call, budget gate,
// claim fence, terminal state, reconciler. The processors here had none of
// that — they logged `not_configured_completed` and returned success, which is
// a FALSE terminal signal for work that never ran.
//
// The removal is safe by measurement, not by argument: `enqueueOcrJob` and
// `enqueueTranscriptJob` had no caller in ANY commit of this repository, so
// neither queue has ever received a job and no in-flight legacy payload can
// exist. That is also why neither retains a legacy adapter.
//
// `services/api/test/phase-12-point5-ocr-transcript-authority.test.ts` keeps
// them removed.
// =============================================================================
// ET-Q-07 (2026-09-30): FOUR MORE PROCESSORS ARE GONE FROM THIS FILE —
// `processMiSearchIndexJob` (`mi-search-index`), `processGraphDomainSyncJob`
// (`graph-domain-sync`), `processGraphTimelineSyncJob` (`graph-timeline-sync`)
// and `processOrgHealthRefreshJob` (`org-health-refresh`) — together with their
// queues, enqueue helpers, worker registrations, registry entries and legacy
// adapters.
//
// Unlike the OCR/transcript pair these had REAL bodies. What they did not have
// was a producer: every one of their enqueue helpers had zero callers in every
// commit, so a correct processor sat behind a queue nothing wrote to while the
// registry called the chain CURRENT_RUNTIME.
//
// What they wrapped is still reachable where it is actually used:
//   * search reindex        -> `search-indexing` (`RebuildSearchDocument`);
//   * graph stale sweeps    -> inside `reconcileTeamGraph`, on `graph-reconcile`;
//   * org-health projection -> `refreshOrgHealthProjection`, called at read
//                              time by the api's command-center service.
//
// A future feature that needs one of them must reintroduce it END TO END —
// producer, consumer, idempotency, retries, reconciliation, DLQ and a runtime
// proof. `services/worker/test/et-q-07-retired-queues-resurrection-guard.test.ts`
// keeps them removed.
// =============================================================================
// graph-reconcile — invokes the read-only reconciler for one team.
// =============================================================================

export async function processGraphReconcileJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const resolved = await resolveWorkspaceJob(
    JOB_NAMES.RECONCILE_TEAM_GRAPH,
    job,
    "graph_reconcile",
  );
  if (!resolved) return;
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.GRAPH_RECONCILE,
    {
      "proovra.team_id": resolved.workspaceId,
      "proovra.operation": "graph_reconcile",
    },
    () => processGraphReconcileJobInner(job, resolved),
  );
}

async function processGraphReconcileJobInner(
  job: Job<unknown, void, string>,
  ctx: { workspaceId: string; reason: string; requestId: string },
): Promise<void> {
  logger.info(
    {
      requestId: ctx.requestId,
      jobId: job.id ?? null,
      kind: "graph-reconcile",
      teamId: ctx.workspaceId,
      reason: ctx.reason,
    },
    "graph_reconcile.received",
  );
  try {
    const { reconcileTeamGraph } = await import(
      "@proovra/shared-runtime/graph"
    );
    // Phase 14 — Stage 2 trigger #4: refresh graph-derived search hints after
    // a successful reconcile pass.
    //
    // PHASE 12 POINT 5 — this hook was broken. It enqueued
    // `{ kind: "evidence", sourceId: <TEAM id> }`, so the processor looked for
    // an Evidence row whose id was a Team id, never found one, concluded the
    // source had been deleted, and ran a delete against a projection that does
    // not exist. The intended refresh never happened, and the completion log
    // said it did. A per-team refresh is not expressible as a single-document
    // rebuild, and the platform already has the right job for it: the
    // `graph-search-projection` queue exists precisely to refresh
    // graph-derived search hints for a workspace.
    //
    // Best-effort: a failed enqueue NEVER blocks the reconcile completion log.
    const { enqueueGraphSearchProjectionJob } = await import("./queue.js");
    const result = await reconcileTeamGraph(
      ctx.workspaceId,
      prisma,
      {
        onReconciled: ({ teamId: tId }) => {
          enqueueGraphSearchProjectionJob(tId, {
            reason: "graph_reconciled",
          }).catch(() => null);
        },
      },
    );
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: ctx.workspaceId,
        ok: result.ok,
        nodesUpserted: result.nodesUpserted,
        edgesUpserted: result.edgesUpserted,
        edgesStaled: result.edgesStaled,
        nodesTombstoned: result.nodesTombstoned,
        failures: result.failures,
      },
      "graph_reconcile.completed",
    );
    // A partial graph is not a quiet success: every stage that did not
    // complete is named, by family and database code.
    if (result.failures.length > 0) {
      logger.warn(
        { jobId: job.id ?? null, teamId: ctx.workspaceId, failures: result.failures },
        "graph_reconcile.incomplete",
      );
    }
  } catch (err) {
    logger.error(
      {
        jobId: job.id ?? null,
        teamId: ctx.workspaceId,
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
      "@proovra/shared-runtime/media-intelligence"
    );
    const modes = summariseProducerModes();
    const anyIndexing =
      modes.ocr !== "NOT_CONFIGURED" || modes.transcript !== "NOT_CONFIGURED";
    if (anyIndexing) {
      const { indexExistingOcrAndTranscript } = await import(
        "@proovra/shared-runtime/media-intelligence"
      );
      const indexerResult = await indexExistingOcrAndTranscript(
        { teamId: ctx.workspaceId },
        prisma,
      );
      logger.info(
        {
          jobId: job.id ?? null,
          teamId: ctx.workspaceId,
          modes,
          indexer: indexerResult,
        },
        "graph_reconcile.ocr_transcript_indexer_completed",
      );
    } else {
      logger.info(
        {
          jobId: job.id ?? null,
          teamId: ctx.workspaceId,
        },
        "graph_reconcile.ocr_transcript_indexer_skipped_not_configured",
      );
    }
  } catch (err) {
    logger.warn(
      {
        jobId: job.id ?? null,
        teamId: ctx.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_reconcile.ocr_transcript_indexer_failed_non_fatal",
    );
  }
}

export async function processGraphSearchProjectionJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const ctx = await resolveWorkspaceJob(
    JOB_NAMES.REFRESH_GRAPH_SEARCH_PROJECTION,
    job,
    "graph_search_projection",
  );
  if (!ctx) return;
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.GRAPH_SEARCH_PROJECTION,
    {
      "proovra.team_id": ctx.workspaceId,
      "proovra.operation": "graph_search_projection",
    },
    () => processGraphSearchProjectionJobInner(job, ctx),
  );
}

async function processGraphSearchProjectionJobInner(
  job: Job<unknown, void, string>,
  ctx: { workspaceId: string; reason: string; requestId: string },
): Promise<void> {
  logger.info(
    {
      requestId: ctx.requestId,
      jobId: job.id ?? null,
      kind: "graph-search-projection",
      teamId: ctx.workspaceId,
      reason: ctx.reason,
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
      "@proovra/shared-runtime/graph"
    );
    // Provide an explicit enqueueImpl that uses the worker's
    // already-loaded queue helper — avoids a second Redis
    // connection and avoids the dynamic-import path the service's
    // default uses (which is the fallback for API-only callers).
    const { enqueueSearchIndexingJob } = await import("./queue.js");
    const result = await runSearchProjectionSync(ctx.workspaceId, prisma, {
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
        teamId: ctx.workspaceId,
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
        teamId: ctx.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_search_projection.failed",
    );
    throw err;
  }
}

