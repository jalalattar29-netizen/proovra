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

class BatchAnalysisService {
  /**
   * Create a batch job.
   *
   * `teamId` is the workspace every item belongs to. The caller establishes
   * that the evidence is the caller's own and in ONE workspace before calling:
   * a batch spanning two has no honest `team_id`, and picking one of them
   * would make the rest invisible to their own workspace's reads.
   */
  async createJob(input: {
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
  async getJob(userId: string, jobId: string): Promise<BatchJobMetadata | null> {
    if (!isUuid(jobId)) return null;
    const row = await prisma.batchAnalysisJob.findFirst({
      where: { id: jobId, ownerUserId: userId },
      include: WITH_ITEMS,
    });
    return row ? toMetadata(row) : null;
  }

  /** Every job the caller owns, newest first. */
  async listJobs(userId: string): Promise<BatchJobMetadata[]> {
    const rows = await prisma.batchAnalysisJob.findMany({
      where: { ownerUserId: userId },
      include: WITH_ITEMS,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toMetadata);
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
  async processBatch(
    jobId: string,
    evidenceGetter?: (id: string) => Promise<unknown>,
  ): Promise<void> {
    if (!isUuid(jobId)) throw new Error("Job not found");

    const job = await prisma.batchAnalysisJob.findUnique({
      where: { id: jobId },
      include: WITH_ITEMS,
    });
    if (!job) throw new Error("Job not found");

    const claimedAt = new Date();
    const claim = await prisma.batchAnalysisJob.updateMany({
      where: { id: jobId, status: "PENDING", claimedAtUtc: null },
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
        const current = await prisma.batchAnalysisJob.findUnique({
          where: { id: jobId },
          select: { status: true },
        });
        if (current?.status === "CANCELLED") return;

        await prisma.batchAnalysisJobItem.update({
          where: { id: item.id },
          data: { status: "PROCESSING", startedAtUtc: new Date() },
        });

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

          await prisma.batchAnalysisJobItem.update({
            where: { id: item.id },
            data: {
              status: "COMPLETED",
              resultJson: evidenceMetadata as prismaPkg.Prisma.InputJsonValue,
              completedAtUtc: new Date(),
            },
          });
          processedItems += 1;
        } catch (itemError) {
          await prisma.batchAnalysisJobItem.update({
            where: { id: item.id },
            data: {
              status: "FAILED",
              error: boundedError(itemError),
              completedAtUtc: new Date(),
            },
          });
          failedItems += 1;
        }

        await prisma.batchAnalysisJob.update({
          where: { id: jobId },
          data: { processedItems, failedItems },
        });
      }

      // A cancellation that arrived while the last item ran must not be
      // overwritten with COMPLETED. The conditional says so.
      await prisma.batchAnalysisJob.updateMany({
        where: { id: jobId, status: "PROCESSING" },
        data: { status: "COMPLETED", completedAtUtc: new Date(), processedItems, failedItems },
      });
    } catch (error) {
      await prisma.batchAnalysisJob.updateMany({
        where: { id: jobId, status: "PROCESSING" },
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
  async cancelJob(userId: string, jobId: string): Promise<BatchCancelOutcome> {
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
      await tx.batchAnalysisJobItem.updateMany({
        where: { jobId, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED", error: "Job cancelled by user", completedAtUtc: stoppedAt },
      });
      await tx.batchAnalysisJob.update({
        where: { id: jobId },
        data: { status: "CANCELLED", completedAtUtc: stoppedAt },
      });
      return "CANCELLED" as const;
    });
  }

  /** Aggregate results from a batch job. */
  async getAggregateResults(jobId: string): Promise<{
    classifications: Record<string, number>;
    averageConfidence: number;
    safetyBreakdown: Record<string, number>;
    mostCommonTags: Array<{ tag: string; count: number }>;
    successRate: number;
  }> {
    const job = await this.requireJob(jobId);

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
    };
  }

  /** Export batch results as CSV. */
  async exportAsCSV(jobId: string): Promise<string> {
    const job = await this.requireJob(jobId);

    const rows = ["Evidence ID,Status,Classification,Confidence,Risk Level,Tags,Error"];

    job.items.forEach((item) => {
      if (item.result) {
        const result = item.result as BatchItemAnalysis;
        const tags = result.tags?.tags?.join(";") || "";
        const classification = result.classification?.category || "N/A";
        const confidence = result.classification?.confidence?.toFixed(2) || "N/A";
        const riskLevel = result.moderation?.risk_level || "N/A";

        rows.push(
          `${item.evidenceId},${item.status},${classification},${confidence},${riskLevel},"${tags}",${item.error || ""}`,
        );
      } else {
        rows.push(`${item.evidenceId},${item.status},N/A,N/A,N/A,,${item.error || ""}`);
      }
    });

    return rows.join("\n");
  }

  /** Estimate completion, or null while there is nothing to estimate from. */
  async estimateCompletion(jobId: string): Promise<Date | null> {
    const job = await this.requireJob(jobId);
    if (!job.startedAt || job.processedItems === 0) return null;

    const elapsed = Date.now() - job.startedAt.getTime();
    const avgTimePerItem = elapsed / (job.processedItems + job.failedItems);
    const remainingItems = job.totalItems - (job.processedItems + job.failedItems);
    return new Date(Date.now() + remainingItems * avgTimePerItem);
  }

  private async requireJob(jobId: string): Promise<BatchJobMetadata> {
    if (!isUuid(jobId)) throw new Error("Job not found");
    const row = await prisma.batchAnalysisJob.findUnique({
      where: { id: jobId },
      include: WITH_ITEMS,
    });
    if (!row) throw new Error("Job not found");
    return toMetadata(row);
  }
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

export const batchAnalysisService = new BatchAnalysisService();
