/**
 * Phase 31.19 — subsystem queue processors.
 *
 * Each of the isolated subsystem queues (mi-search-index,
 * graph-reconcile and the workspace projection chains) gets a thin
 * processor here.
 *
 * Hard contracts:
 *   - Each processor imports the SHARED Prisma instance via ./db.js;
 *     it NEVER constructs its own. (Bare `new PrismaClient()` was
 *     the worker hotfix root cause.)
 *   - Each processor returns within bounded time.
 *   - graph-reconcile invokes the existing `reconcileTeamGraph`
 *     service (read-only graph rebuild for one team).
 *   - mi-search-index defers to the existing Phase 24-J search
 *     indexing queue so we keep a single canonical writer for the
 *     search index.
 *   - PHASE 12 POINT 5: no processor here reports completion for work
 *     it did not perform. The two that did — `mi-ocr` and
 *     `mi-transcript` — are gone; see the note below.
 */

import type { Job } from "bullmq";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
// Phase O1.5D — bounded graph spans. Attributes carry only the
// bounded teamId + operation. NEVER raw graph data or PII.
import { PROOVRA_SPAN_NAMES, withProovraSpan } from "./otel.js";
import { randomUUID } from "node:crypto";

import {
  JOB_NAMES,
  parseGraphDomainCommandId,
  type GraphSyncDomain,
  type WorkName,
} from "@proovra/shared";

import {
  decodeCanonicalJob,
  resolveActiveWorkspace,
  type JobLike,
} from "./canonical-job.js";

/**
 * PHASE 12 — POINT 5: the shared preamble for the workspace-scoped subsystem
 * jobs.
 *
 * Five of the eight processors in this file address a WORKSPACE rather than a
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
// mi-search-index — bounded reindex trigger for a single evidence.
// Defers to the existing search-indexing queue.
// =============================================================================

export async function processMiSearchIndexJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const requestId = randomUUID();
  const decoded = decodeCanonicalJob(JOB_NAMES.INDEX_MEDIA_INTELLIGENCE, job, {
    requestId,
  });
  const evidence = await prisma.evidence.findFirst({
    where: { id: decoded.commandId, deletedAt: null },
    select: { id: true, teamId: true },
  });
  if (!evidence?.teamId) {
    logger.warn(
      { requestId, jobId: job.id ?? null, kind: "mi-search-index" },
      "mi_search_index.evidence_unresolved",
    );
    return;
  }
  const reason = decoded.traceId || "media_intelligence_indexed";
  logger.info(
    {
      requestId,
      jobId: job.id ?? null,
      kind: "mi-search-index",
      teamId: evidence.teamId,
      evidenceId: evidence.id,
      reason,
    },
    "mi_search_index.received",
  );
  const { enqueueSearchIndexingJob } = await import("./queue.js");
  const r = await enqueueSearchIndexingJob({
    teamId: evidence.teamId,
    kind: "evidence",
    sourceId: evidence.id,
    reason,
  });
  logger.info(
    {
      requestId,
      jobId: job.id ?? null,
      teamId: evidence.teamId,
      evidenceId: evidence.id,
      delegated: r,
    },
    "mi_search_index.delegated_to_search_indexing_queue",
  );
}

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
      },
      "graph_reconcile.completed",
    );
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

/**
 * PHASE 12 — POINT 5. The command is `<domain>:<workspaceId>`, and the domain
 * half is validated against a CLOSED catalog by the parser before any database
 * access. It used to be an optional payload field, so an unknown value produced
 * a job that completed as a silent no-op — a request that looked accepted and
 * did nothing.
 */
export async function processGraphDomainSyncJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const requestId = randomUUID();
  const decoded = decodeCanonicalJob(JOB_NAMES.SYNC_TEAM_GRAPH_DOMAIN, job, {
    requestId,
  });
  const { domain, workspaceId } = parseGraphDomainCommandId(decoded.commandId);
  const resolved = await resolveActiveWorkspace(prisma, workspaceId);
  if (!resolved) {
    logger.warn(
      { requestId, jobId: job.id ?? null, kind: "graph-domain-sync" },
      "graph_domain_sync.workspace_unresolved_or_inactive",
    );
    return;
  }
  const ctx = {
    workspaceId: resolved.workspaceId,
    reason: decoded.traceId || "unspecified",
    requestId,
    domain,
  };
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.GRAPH_DOMAIN_SYNC,
    {
      "proovra.team_id": ctx.workspaceId,
      "proovra.operation": "graph_domain_sync",
    },
    () => processGraphDomainSyncJobInner(job, ctx),
  );
}

async function processGraphDomainSyncJobInner(
  job: Job<unknown, void, string>,
  ctx: {
    workspaceId: string;
    reason: string;
    requestId: string;
    domain: GraphSyncDomain;
  },
): Promise<void> {
  logger.info(
    {
      requestId: ctx.requestId,
      jobId: job.id ?? null,
      kind: "graph-domain-sync",
      teamId: ctx.workspaceId,
      domain: ctx.domain,
      reason: ctx.reason,
    },
    "graph_domain_sync.received",
  );
  // Phase 31.21 — real bounded domain sync. The job either targets
  // a single named domain (preferred — incremental) or runs a sweep
  // across all bounded catalog domains.
  try {
    const { DOMAIN_SYNC_DOMAINS, runDomainStaleSweep } = await import(
      "@proovra/shared-runtime/graph"
    );
    // `all` is a real member of the closed catalog, not a null: an absent
    // filter and an unknown filter must not be the same value.
    const targets =
      ctx.domain === "all"
        ? (DOMAIN_SYNC_DOMAINS as readonly string[])
        : [ctx.domain];
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
        ctx.workspaceId,
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
        teamId: ctx.workspaceId,
        domain: ctx.domain,
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
        teamId: ctx.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_domain_sync.failed",
    );
    throw err;
  }
}

export async function processGraphTimelineSyncJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const ctx = await resolveWorkspaceJob(
    JOB_NAMES.SYNC_TEAM_GRAPH_TIMELINE,
    job,
    "graph_timeline_sync",
  );
  if (!ctx) return;
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.GRAPH_TIMELINE_BUILD,
    {
      "proovra.team_id": ctx.workspaceId,
      "proovra.operation": "graph_timeline_build",
    },
    () => processGraphTimelineSyncJobInner(job, ctx),
  );
}

async function processGraphTimelineSyncJobInner(
  job: Job<unknown, void, string>,
  ctx: { workspaceId: string; reason: string; requestId: string },
): Promise<void> {
  logger.info(
    {
      requestId: ctx.requestId,
      jobId: job.id ?? null,
      kind: "graph-timeline-sync",
      teamId: ctx.workspaceId,
      reason: ctx.reason,
    },
    "graph_timeline_sync.received",
  );
  // Phase 31.21 — real bounded timeline sync. Builds the bounded
  // timeline to record its current size + runs the cross-edge stale
  // sweep that tombstones edges whose endpoints both went stale.
  try {
    const { runTimelineSync } = await import(
      "@proovra/shared-runtime/graph"
    );
    const result = await runTimelineSync(ctx.workspaceId, prisma);
    logger.info(
      {
        jobId: job.id ?? null,
        teamId: ctx.workspaceId,
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
        teamId: ctx.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "graph_timeline_sync.failed",
    );
    throw err;
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

// ============================================================================
// PHASE 37.98 — Org-health projection refresh processor.
//
// One job payload = one teamId. The processor runs bounded count queries
// scoped by that teamId only and upserts the latest OrgHealthProjection
// row. Tenant safety holds:
//
//   - the input is a single teamId; no other tenant is touched,
//   - every Prisma .count call carries `where: { teamId }`,
//   - the upsert key is `(teamId, sampledAtUtc)`,
//   - no audit/billing/legal-hold side effects.
//
// The processor is intentionally lean — when the API-side
// `refresh-org-health.service.ts` grows new counters, mirror them here
// or extract to a shared package.
// ============================================================================
export async function processOrgHealthRefreshJob(
  job: Job<unknown, void, string>,
): Promise<void> {
  const ctx = await resolveWorkspaceJob(
    JOB_NAMES.REFRESH_ORG_HEALTH_PROJECTION,
    job,
    "org_health_refresh",
  );
  if (!ctx) return;
  const teamId = ctx.workspaceId;
  logger.info(
    {
      requestId: ctx.requestId,
      jobId: job.id ?? null,
      teamId,
      kind: "org-health-refresh",
    },
    "org_health_refresh.received",
  );
  try {
    // PHASE 12 — POINT 5, CLAIM 2. The sample instant is BUCKETED to the
    // minute, and that is what makes this unit's declared idempotency real.
    //
    // `OrgHealthProjection`'s primary key is (team_id, sampled_at_utc), and
    // the registry records `upsert_by_natural_key` as this unit's only
    // protection — it declares no claim. With `new Date()` the key was
    // different on every execution, so the upsert could never collapse
    // anything: it was an INSERT wearing an upsert's clothes, and two
    // concurrent ticks wrote two rows for the same observation. Measured, not
    // theorised — the concurrency probe in the reconciliation family suite
    // caught it adding a tenth row to nine.
    //
    // A minute is the smallest bucket that makes concurrent and
    // immediately-retried ticks collapse while leaving a genuine time series
    // intact at any real cadence: two ticks a minute apart still sample twice.
    const sampledAtUtc = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const [
      evidenceCount,
      caseCount,
      pendingReportCount,
      pendingPackageCount,
    ] = await Promise.all([
      prisma.evidence.count({ where: { teamId, deletedAt: null } }),
      prisma.case.count({ where: { teamId } }),
      prisma.evidence.count({
        where: { teamId, deletedAt: null, reports: { none: {} } },
      }),
      prisma.evidence.count({
        where: { teamId, deletedAt: null, verificationPackages: { none: {} } },
      }),
    ]);

    // Counters that depend on subsystem-specific tables; default to 0
    // until those subsystems plumb in their own per-tenant counters.
    const openIncidentCount = 0;
    const slaBreachCount = 0;
    const governanceBlockerCount = 0;
    const recentVerificationCount = 0;

    await prisma.orgHealthProjection.upsert({
      where: { teamId_sampledAtUtc: { teamId, sampledAtUtc } },
      create: {
        teamId,
        sampledAtUtc,
        evidenceCount,
        caseCount,
        openIncidentCount,
        slaBreachCount,
        governanceBlockerCount,
        recentVerificationCount,
        pendingPackageCount,
        pendingReportCount,
        source: "worker_refresh_v1",
      },
      update: {
        evidenceCount,
        caseCount,
        openIncidentCount,
        slaBreachCount,
        governanceBlockerCount,
        recentVerificationCount,
        pendingPackageCount,
        pendingReportCount,
        source: "worker_refresh_v1",
      },
    });

    logger.info(
      {
        jobId: job.id ?? null,
        teamId,
        evidenceCount,
        caseCount,
        pendingReportCount,
        pendingPackageCount,
      },
      "org_health_refresh.completed",
    );
  } catch (err) {
    logger.error(
      {
        jobId: job.id ?? null,
        teamId,
        err: err instanceof Error ? err.message : String(err),
      },
      "org_health_refresh.failed",
    );
    throw err;
  }
}
