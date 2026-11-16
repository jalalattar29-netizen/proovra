/**
 * BATCH ANALYSIS — durable jobs over the canonical database.
 *
 * ===========================================================================
 * BD-2, AND WHY THIS IS NOT A SECOND JOB SYSTEM
 * ===========================================================================
 * This service used to keep `this.jobs` in a plain object on a module
 * singleton. A restart lost every job, and two API instances could not see
 * each other's — so a job could simply vanish. Both clients reported that
 * honestly because neither could do anything about it; the fix belonged here.
 *
 * The state now lives in `batch_analysis_jobs` / `batch_analysis_job_items`,
 * modelled on `EvidenceIntelligenceJob` — this repository's existing durable
 * job shape — rather than a new one. There is no new queue, no new worker and
 * no second processing model: the same in-process execution runs, and what
 * changed is where its state is kept and how a second instance is stopped from
 * running the same job twice.
 *
 * ===========================================================================
 * WHAT MAKES IT SAFE ACROSS INSTANCES
 * ===========================================================================
 * `processBatch` CLAIMS the job with a conditional update — PENDING and
 * unclaimed, to PROCESSING and claimed, in one statement. Postgres decides, so
 * a second instance that races loses and is told the job is already
 * processing. The old guard was a Map in one process and could not answer that
 * question at all, which is the other half of BD-2.
 *
 * Workspace isolation is a column, not a convention: `team_id` is on the job
 * row, so a read is scoped by a predicate rather than by a filter each caller
 * has to remember to apply.
 *
 * Privacy is unchanged and deliberate: this is a METADATA-ONLY analyser. No
 * raw file, storage key or document content is sent to a provider from here,
 * and `error` is bounded operator-readable text.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { error as logError } from "../utils/logger.js";

/**
 * The status vocabulary the routes and both clients already speak.
 *
 * Kept as the lowercase strings the API has always returned, so persisting the
 * jobs changed no response shape. The database enum is uppercase — this
 * repository's convention for every other enum — and the mapping lives here
 * and nowhere else.
 */
export enum BatchStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

const JOB_STATUS_FROM_DB: Record<prismaPkg.BatchAnalysisJobStatus, BatchStatus> = {
  PENDING: BatchStatus.PENDING,
  PROCESSING: BatchStatus.PROCESSING,
  COMPLETED: BatchStatus.COMPLETED,
  FAILED: BatchStatus.FAILED,
  CANCELLED: BatchStatus.CANCELLED,
};

type ItemStatus = "pending" | "processing" | "completed" | "failed";

const ITEM_STATUS_FROM_DB: Record<prismaPkg.BatchAnalysisItemStatus, ItemStatus> = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
};

/**
 * What a cancellation actually did.
 *
 * A boolean could not distinguish "cancelled" from "this job already
 * finished", so the route reported both as success — and, for a PENDING job,
 * reported success for doing nothing at all.
 */
export type BatchCancelOutcome = "CANCELLED" | "NOT_FOUND" | "ALREADY_TERMINAL";

/**
 * The bounded shape the legacy batch service reads back out of an item result.
 * It is stored as an open record, so consumers narrow through this instead of
 * asserting `any`.
 */
export type BatchItemAnalysis = {
  classification?: { category?: string; confidence?: number };
  moderation?: { risk_level?: string };
  tags?: { tags?: string[] };
};

/** The evidence fields the metadata-only legacy batch projection reads. */
type BatchEvidenceMetadataSource = {
  type?: unknown;
  mimeType?: unknown;
  status?: unknown;
  verificationStatus?: unknown;
  createdAt?: unknown;
  sizeBytes?: bigint | number | null;
  storageBucket?: unknown;
  storageKey?: unknown;
};

export interface BatchJobItem {
  evidenceId: string;
  status: ItemStatus;
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface BatchJobMetadata {
  id: string;
  userId: string;
  teamId: string;
  name: string;
  description?: string;
  status: BatchStatus;
  items: BatchJobItem[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  estimatedCompletion?: Date;
}

type JobRow = prismaPkg.BatchAnalysisJob & {
  items: prismaPkg.BatchAnalysisJobItem[];
};

/** The persisted rows, in the shape the API has always returned. */
function toMetadata(row: JobRow): BatchJobMetadata {
  return {
    id: row.id,
    userId: row.ownerUserId,
    teamId: row.teamId,
    name: row.name,
    description: row.description ?? undefined,
    status: JOB_STATUS_FROM_DB[row.status],
    items: [...row.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
        evidenceId: item.evidenceId,
        status: ITEM_STATUS_FROM_DB[item.status],
        result: (item.resultJson as Record<string, unknown> | null) ?? undefined,
        error: item.error ?? undefined,
        startedAt: item.startedAtUtc ?? undefined,
        completedAt: item.completedAtUtc ?? undefined,
      })),
    createdAt: row.createdAt,
    startedAt: row.startedAtUtc ?? undefined,
    completedAt: row.completedAtUtc ?? undefined,
    totalItems: row.totalItems,
    processedItems: row.processedItems,
    failedItems: row.failedItems,
  };
}

const WITH_ITEMS = { items: true } as const;

/**
 * B6-F-40 (Free-user audit 0ea0) — the workspace a read or write is bound to.
 *
 * The routes check plan and role on the REQUEST workspace; every job read and
 * write used to filter on the owner alone, so a job (and the evidence it
 * names) in another workspace — a Free personal one, or one the caller has
 * left — was served and acted on under the entitlement of whichever paid
 * workspace was current. A route passes the proven workspace and the
 * predicate carries it; omitted (service-level callers and tests), the
 * owner predicate alone applies as before.
 */
export type BatchWorkspaceScope = { teamId?: string | null };

function teamPredicate(scope?: BatchWorkspaceScope): { teamId?: string } {
  return scope?.teamId ? { teamId: scope.teamId } : {};
}

/**
 * Create a batch job.
 *
 * `teamId` is the workspace every item belongs to. The caller establishes
 * that the evidence is the caller's own and in ONE workspace before calling:
 * a batch spanning two has no honest `team_id`, and picking one of them
 * would make the rest invisible to their own workspace's reads.
 */
export async function createJob(input: {
  ownerUserId: string;
  teamId: string;
  evidenceIds: string[];
  name: string;
  description?: string;
}): Promise<BatchJobMetadata> {
  const row = await prisma.batchAnalysisJob.create({
    data: {
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
      name: input.name.slice(0, 200),
      description: input.description?.slice(0, 1000) ?? null,
      status: "PENDING",
      totalItems: input.evidenceIds.length,
      items: {
        create: input.evidenceIds.map((evidenceId, position) => ({
          evidenceId,
          position,
          status: "PENDING" as const,
        })),
      },
    },
    include: WITH_ITEMS,
  });
  return toMetadata(row);
}

/** One job the caller owns, or null. A stranger's job answers the same. */
export async function getJob(
userId: string,
jobId: string,
scope?: BatchWorkspaceScope,
): Promise<BatchJobMetadata | null> {
  if (!isUuid(jobId)) return null;
  const row = await prisma.batchAnalysisJob.findFirst({
    where: { id: jobId, ownerUserId: userId, ...teamPredicate(scope) },
    include: WITH_ITEMS,
  });
  return row ? toMetadata(row) : null;
}

/** Every job the caller owns, newest first. */
export async function listJobs(userId: string): Promise<BatchJobMetadata[]> {
  const rows = await prisma.batchAnalysisJob.findMany({
    where: { ownerUserId: userId },
    include: WITH_ITEMS,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toMetadata);
}

/** A job without its items: what the job list shows. */
export type BatchJobSummary = Omit<BatchJobMetadata, "items" | "description" | "estimatedCompletion">;

/** F-21 — the most jobs one list read returns. */
export const BATCH_JOB_LIST_LIMIT = 100;

/**
 * F-21 — the job list the console polls: the caller's newest jobs, bounded,
 * WITHOUT items. `listJobs` loaded every item (with its result JSON) of every
 * job the caller ever made on each 4 s poll, and the list shows only job-level
 * counts. `truncated` says older jobs exist beyond the bound.
 */
export async function listJobSummaries(
  userId: string,
  limit: number = BATCH_JOB_LIST_LIMIT,
  scope?: BatchWorkspaceScope,
): Promise<{ jobs: BatchJobSummary[]; truncated: boolean }> {
  const rows = await prisma.batchAnalysisJob.findMany({
    where: { ownerUserId: userId, ...teamPredicate(scope) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  return {
    jobs: rows.slice(0, limit).map((row) => ({
      id: row.id,
      userId: row.ownerUserId,
      teamId: row.teamId,
      name: row.name,
      status: JOB_STATUS_FROM_DB[row.status],
      createdAt: row.createdAt,
      startedAt: row.startedAtUtc ?? undefined,
      completedAt: row.completedAtUtc ?? undefined,
      totalItems: row.totalItems,
      processedItems: row.processedItems,
      failedItems: row.failedItems,
    })),
    truncated: rows.length > limit,
  };
}

/** F-21 — how many jobs the caller owns (optionally in these states), counted in the database. */
export async function countJobs(
  userId: string,
  statuses?: ReadonlyArray<prismaPkg.BatchAnalysisJobStatus>,
  scope?: BatchWorkspaceScope,
): Promise<number> {
  return prisma.batchAnalysisJob.count({
    where: {
      ownerUserId: userId,
      ...teamPredicate(scope),
      ...(statuses ? { status: { in: [...statuses] } } : {}),
    },
  });
}

/**
 * Process a batch job.
 *
 * THE CLAIM IS THE POINT. One conditional update moves the job from
 * PENDING-and-unclaimed to PROCESSING-and-claimed; Postgres decides, so a
 * second instance that races loses and is told the job is already
 * processing. The previous in-memory guard could only answer that for its
 * own process.
 */
export async function processBatch(
  ownerUserId: string,
  jobId: string,
  evidenceGetter?: (id: string) => Promise<unknown>,
  scope?: BatchWorkspaceScope,
): Promise<void> {
  if (!isUuid(jobId)) throw new Error("Job not found");

  // Owner-scoped, like every other read here. A job belonging to someone else
  // is not found — the same answer they get for one that does not exist.
  const job = await prisma.batchAnalysisJob.findFirst({
    where: { id: jobId, ownerUserId, ...teamPredicate(scope) },
    include: WITH_ITEMS,
  });
  if (!job) throw new Error("Job not found");

  // THE CLAIM CARRIES THE OWNERSHIP PREDICATE ITSELF.
  //
  // It used to match on the id alone and rely on the route having checked
  // ownership one call earlier. That is a binding a caller has to remember,
  // and this service's own rule is that isolation belongs in the predicate.
  const claimedAt = new Date();
  const claim = await prisma.batchAnalysisJob.updateMany({
    where: { id: jobId, ownerUserId, status: "PENDING", claimedAtUtc: null },
    data: { status: "PROCESSING", claimedAtUtc: claimedAt, startedAtUtc: claimedAt },
  });
  if (claim.count === 0) {
    // Claimed by another instance, or already past PENDING.
    throw new Error("Batch job already processing");
  }

  let processedItems = 0;
  let failedItems = 0;

  try {
    const items = [...job.items].sort((a, b) => a.position - b.position);
    for (const item of items) {
      // A cancellation that lands mid-run stops at the next item rather than
      // finishing the batch the operator asked to stop. One indexed lookup
      // per item is the cost of honouring the cancel at all.
      const current = await prisma.batchAnalysisJob.findFirst({
        where: { id: jobId, ownerUserId },
        select: { status: true },
      });
      if (current?.status === "CANCELLED") return;

      // B6-F-41 — every item write is conditional on the state the runner
      // expects, so a cancellation that lands between the check above and
      // this write (cancelJob moves PENDING/PROCESSING items to FAILED) is
      // never overwritten.
      const started = await prisma.batchAnalysisJobItem.updateMany({
        where: { id: item.id, status: "PENDING", job: { status: "PROCESSING" } },
        data: { status: "PROCESSING", startedAtUtc: new Date() },
      });
      if (started.count === 0) return;

      try {
        // Privacy-safe legacy batch result.
        // Do not send raw files, image URLs, storage keys, PDFs, videos, or
        // document contents to AI from this legacy batch service. New AI
        // analysis must go through /v1/ai/capture/* metadata-only endpoints.
        let evidenceMetadata: Record<string, unknown> = {};

        if (evidenceGetter) {
          const evidence = (await evidenceGetter(item.evidenceId)) as
            | BatchEvidenceMetadataSource
            | null
            | undefined;

          evidenceMetadata = {
            id: item.evidenceId,
            type: evidence?.type ?? null,
            mimeType: evidence?.mimeType ?? null,
            status: evidence?.status ?? null,
            verificationStatus: evidence?.verificationStatus ?? null,
            createdAt: evidence?.createdAt ?? null,
            sizeBytes:
              typeof evidence?.sizeBytes === "bigint"
                ? evidence.sizeBytes.toString()
                : (evidence?.sizeBytes ?? null),
            hasStorageObject: Boolean(evidence?.storageBucket && evidence?.storageKey),
          };
        }

        await prisma.batchAnalysisJobItem.updateMany({
          where: { id: item.id, status: "PROCESSING" },
          data: {
            status: "COMPLETED",
            resultJson: evidenceMetadata as prismaPkg.Prisma.InputJsonValue,
            completedAtUtc: new Date(),
          },
        });
        processedItems += 1;
      } catch (itemError) {
        await prisma.batchAnalysisJobItem.updateMany({
          where: { id: item.id, status: "PROCESSING" },
          data: {
            status: "FAILED",
            error: boundedError(itemError),
            completedAtUtc: new Date(),
          },
        });
        failedItems += 1;
      }

      await prisma.batchAnalysisJob.updateMany({
        where: { id: jobId, ownerUserId, status: "PROCESSING" },
        data: { processedItems, failedItems },
      });
    }

    // A cancellation that arrived while the last item ran must not be
    // overwritten with COMPLETED. The conditional says so.
    await prisma.batchAnalysisJob.updateMany({
      where: { id: jobId, ownerUserId, status: "PROCESSING" },
      data: { status: "COMPLETED", completedAtUtc: new Date(), processedItems, failedItems },
    });
  } catch (error) {
    await prisma.batchAnalysisJob.updateMany({
      where: { id: jobId, ownerUserId, status: "PROCESSING" },
      data: { status: "FAILED", completedAtUtc: new Date(), processedItems, failedItems },
    });
    // A whole-job failure previously left no trace of WHY. Bounded
    // diagnostic — error class only, never the message, which can carry
    // evidence-side detail.
    logError("batch_analysis.job_failed", {
      jobId,
      processedItems,
      failedItems,
      totalItems: job.totalItems,
      errorCode: error instanceof Error ? error.name.slice(0, 64) : "unknown_error",
    });
  }
}

/**
 * Cancel a batch job.
 *
 * PENDING is cancellable — more cheaply than PROCESSING, because nothing has
 * started. This used to act only on PROCESSING and return `true` regardless,
 * so cancelling a pending job changed nothing, told the operator it had
 * worked, and wrote `outcome: success` into the audit log. The job then ran.
 *
 * A terminal job is NOT a failure to report as one: it is a job that already
 * finished, and the caller is owed that answer rather than "not found",
 * which would say the job never existed.
 */
export async function cancelJob(
  userId: string,
  jobId: string,
): Promise<BatchCancelOutcome> {
  if (!isUuid(jobId)) return "NOT_FOUND";

  return prisma.$transaction(async (tx) => {
    const job = await tx.batchAnalysisJob.findFirst({
      where: { id: jobId, ownerUserId: userId },
      select: { id: true, status: true },
    });
    // A job belonging to someone else answers exactly as a job that does not
    // exist. The caller learns nothing either way.
    if (!job) return "NOT_FOUND" as const;

    if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
      return "ALREADY_TERMINAL" as const;
    }

    const stoppedAt = new Date();
    // An item that was mid-flight is recorded as stopped BY THE OPERATOR
    // rather than as a generic failure: "this could not be analysed" and
    // "somebody stopped this" are different things to say about evidence.
    // The WRITE carries the ownership predicate, not just the read above it.
    // A binding that lives only in an earlier statement is one a future
    // caller has to remember; this service's rule is that isolation is a
    // predicate.
    await tx.batchAnalysisJobItem.updateMany({
      where: {
        jobId,
        job: { ownerUserId: userId },
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "FAILED", error: "Job cancelled by user", completedAtUtc: stoppedAt },
    });
    // B6-F-41 — the counters say what the items say: a cancelled job reports
    // the items it completed and the ones it failed or stopped, not the
    // runner's last snapshot.
    const [completedCount, failedCount] = await Promise.all([
      tx.batchAnalysisJobItem.count({ where: { jobId, status: "COMPLETED" } }),
      tx.batchAnalysisJobItem.count({ where: { jobId, status: "FAILED" } }),
    ]);
    await tx.batchAnalysisJob.updateMany({
      where: { id: jobId, ownerUserId: userId },
      data: {
        status: "CANCELLED",
        completedAtUtc: stoppedAt,
        processedItems: completedCount,
        failedItems: failedCount,
      },
    });
    return "CANCELLED" as const;
  });
}

/** Aggregate results from a batch job. */
export async function getAggregateResults(
  ownerUserId: string,
  jobId: string,
  scope?: BatchWorkspaceScope,
): Promise<{
  classifications: Record<string, number>;
  averageConfidence: number;
  safetyBreakdown: Record<string, number>;
  mostCommonTags: Array<{ tag: string; count: number }>;
  successRate: number;
  /** B6-F-41 — what the analyser actually produced: record metadata only. */
  mode: "METADATA_ONLY";
  typeBreakdown: Record<string, number>;
  verificationBreakdown: Record<string, number>;
}> {
  const job = await requireJob(ownerUserId, jobId, scope);
  const typeBreakdown: Record<string, number> = {};
  const verificationBreakdown: Record<string, number> = {};
  for (const item of job.items) {
    const meta = item.result as { type?: unknown; verificationStatus?: unknown } | undefined;
    if (meta && typeof meta.type === "string") typeBreakdown[meta.type] = (typeBreakdown[meta.type] ?? 0) + 1;
    if (meta && typeof meta.verificationStatus === "string") {
      verificationBreakdown[meta.verificationStatus] = (verificationBreakdown[meta.verificationStatus] ?? 0) + 1;
    }
  }

  const classifications: Record<string, number> = {};
  const safetyBreakdown: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  let totalConfidence = 0;
  let confidenceCount = 0;

  job.items.forEach((item) => {
    if (!item.result) return;
    const result = item.result as BatchItemAnalysis;

    if (result.classification?.category) {
      classifications[result.classification.category] =
        (classifications[result.classification.category] || 0) + 1;
      totalConfidence += result.classification.confidence || 0;
      confidenceCount++;
    }

    if (result.moderation?.risk_level) {
      safetyBreakdown[result.moderation.risk_level] =
        (safetyBreakdown[result.moderation.risk_level] || 0) + 1;
    }

    if (result.tags?.tags) {
      result.tags.tags.forEach((tag: string) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    }
  });

  const mostCommonTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    classifications,
    averageConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    safetyBreakdown,
    mostCommonTags,
    successRate: job.totalItems > 0 ? (job.processedItems / job.totalItems) * 100 : 0,
    mode: "METADATA_ONLY",
    typeBreakdown,
    verificationBreakdown,
  };
}

/**
 * Export batch results as CSV.
 *
 * B6-F-41 (Free-user audit 0ea0) — the columns are the ones the analyser
 * produces. This is a METADATA-ONLY analyser (header): it never wrote the
 * legacy classification / confidence / risk / tag fields, so every row of the
 * old export read N/A. The export now carries the per-record metadata the run
 * recorded, each value CSV-quoted.
 */
export async function exportAsCSV(
  ownerUserId: string,
  jobId: string,
  scope?: BatchWorkspaceScope,
): Promise<string> {
  const job = await requireJob(ownerUserId, jobId, scope);
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    // Formula neutralisation, as the platform's other CSV exports do.
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [
    "Evidence ID,Status,Type,MIME type,Record status,Verification status,Size (bytes),Stored object,Error",
  ];
  for (const item of job.items) {
    const meta = (item.result ?? {}) as Record<string, unknown>;
    rows.push(
      [
        item.evidenceId,
        item.status,
        meta.type,
        meta.mimeType,
        meta.status,
        meta.verificationStatus,
        meta.sizeBytes,
        meta.hasStorageObject === undefined ? "" : meta.hasStorageObject ? "yes" : "no",
        item.error,
      ]
        .map(cell)
        .join(","),
    );
  }
  return rows.join("\n");
}

/** Estimate completion, or null while there is nothing to estimate from. */
export async function estimateCompletion(
  ownerUserId: string,
  jobId: string,
): Promise<Date | null> {
  const job = await requireJob(ownerUserId, jobId);
  if (!job.startedAt || job.processedItems === 0) return null;

  const elapsed = Date.now() - job.startedAt.getTime();
  const avgTimePerItem = elapsed / (job.processedItems + job.failedItems);
  const remainingItems = job.totalItems - (job.processedItems + job.failedItems);
  return new Date(Date.now() + remainingItems * avgTimePerItem);
}

async function requireJob(
  ownerUserId: string,
  jobId: string,
  scope?: BatchWorkspaceScope,
): Promise<BatchJobMetadata> {
  if (!isUuid(jobId)) throw new Error("Job not found");
  // Owner-scoped. These read paths are reached from routes that check first,
  // but a function that answers about ANY job by id alone is one refactor away
  // from being called somewhere that does not.
  const row = await prisma.batchAnalysisJob.findFirst({
    where: { id: jobId, ownerUserId, ...teamPredicate(scope) },
    include: WITH_ITEMS,
  });
  if (!row) throw new Error("Job not found");
  return toMetadata(row);
}

/**
 * A job id that is not a UUID is not a job.
 *
 * The ids used to be `batch_<timestamp>_<random>`, so a stale client can still
 * present one. Prisma would throw on a malformed UUID; answering "not found"
 * is what the caller would have been told anyway, without a 500.
 */
function isUuid(value: string): boolean {
return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Operator-readable, bounded. Never a provider response or file content. */
function boundedError(error: unknown): string {
const raw = error instanceof Error ? error.message : "Analysis failed";
return raw.slice(0, 400);
}

/**
 * The facade the routes call.
 *
 * An object over module-level functions, not a class instance. Every write
 * therefore sits in a NAMED function the capability engine can trace to an
 * entrypoint — as a class, all ten Prisma writers had `BatchAnalysisService`
 * as their enclosing declaration, which nothing imports by name, and the
 * engine correctly reported them unreachable.
 *
 * Each key is the function's OWN name, deliberately. Aliasing them
 * (`createJob: createBatchJob`) put the same three writers back out of reach:
 * the trace follows the name the caller uses.
 */
export const batchAnalysisService = {
  createJob,
  getJob,
  listJobs,
  listJobSummaries,
  countJobs,
  processBatch,
  cancelJob,
  getAggregateResults,
  exportAsCSV,
  estimateCompletion,
};
