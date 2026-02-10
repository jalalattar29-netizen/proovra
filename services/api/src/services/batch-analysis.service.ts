/**
 * Batch Analysis Service
 * Handles analysis of multiple evidence items with progress tracking and aggregation
 */

import { aiService } from "./ai.service.js";

export enum BatchStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export interface BatchJobItem {
  evidenceId: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface BatchJobMetadata {
  id: string;
  userId: string;
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

interface BatchJobStore {
  [jobId: string]: BatchJobMetadata;
}

class BatchAnalysisService {
  private jobs: BatchJobStore = {};
  private processingQueues = new Map<string, Promise<void>>();

  /**
   * Create a new batch analysis job
   */
  createJob(
    userId: string,
    evidenceIds: string[],
    name: string,
    description?: string
  ): BatchJobMetadata {
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const job: BatchJobMetadata = {
      id: jobId,
      userId,
      name,
      description,
      status: BatchStatus.PENDING,
      items: evidenceIds.map((id) => ({
        evidenceId: id,
        status: "pending",
      })),
      createdAt: new Date(),
      totalItems: evidenceIds.length,
      processedItems: 0,
      failedItems: 0,
    };

    this.jobs[jobId] = job;
    return job;
  }

  /**
   * Get job details
   */
  getJob(userId: string, jobId: string): BatchJobMetadata | null {
    const job = this.jobs[jobId];
    if (!job || job.userId !== userId) {
      return null;
    }
    return job;
  }

  /**
   * List all jobs for a user
   */
  listJobs(userId: string): BatchJobMetadata[] {
    return Object.values(this.jobs).filter((job) => job.userId === userId);
  }

  /**
   * Start processing a batch job
   */
  async processBatch(jobId: string, evidenceGetter?: (id: string) => Promise<any>): Promise<void> {
    const job = this.jobs[jobId];
    if (!job) throw new Error("Job not found");

    // Check if already processing
    if (this.processingQueues.has(jobId)) {
      throw new Error("Batch job already processing");
    }

    // Mark as processing
    job.status = BatchStatus.PROCESSING;
    job.startedAt = new Date();

    // Create processing promise
    const processingPromise = (async () => {
      try {
        for (let i = 0; i < job.items.length; i++) {
          const item = job.items[i];
          item.status = "processing";
          item.startedAt = new Date();

          try {
            // Get evidence image URL
            let imageUrl = `https://storage.example.com/evidence/${item.evidenceId}`;
            if (evidenceGetter) {
              const evidence = await evidenceGetter(item.evidenceId);
              if (evidence?.storageBucket && evidence?.storageKey) {
                imageUrl = `https://storage.example.com/${evidence.storageBucket}/${evidence.storageKey}`;
              }
            }

            // Run analysis
            const analysisResult = await aiService.analyzeEvidence(
              imageUrl,
              "evidence"
            );

            item.status = "completed";
            item.result = analysisResult;
            item.completedAt = new Date();
            job.processedItems++;
          } catch (error) {
            item.status = "failed";
            item.error = error instanceof Error ? error.message : "Unknown error";
            item.completedAt = new Date();
            job.failedItems++;
          }

          // Update progress
          const progressPercent = Math.round(
            ((job.processedItems + job.failedItems) / job.totalItems) * 100
          );
          item.progress = progressPercent;
        }

        // Mark job as completed
        job.status = BatchStatus.COMPLETED;
        job.completedAt = new Date();
      } catch (error) {
        job.status = BatchStatus.FAILED;
        job.completedAt = new Date();
      } finally {
        this.processingQueues.delete(jobId);
      }
    })();

    this.processingQueues.set(jobId, processingPromise);
    return processingPromise;
  }

  /**
   * Cancel a batch job
   */
  cancelJob(userId: string, jobId: string): boolean {
    const job = this.jobs[jobId];
    if (!job || job.userId !== userId) {
      return false;
    }

    if (job.status === BatchStatus.PROCESSING) {
      // Mark all processing items as cancelled
      job.items.forEach((item) => {
        if (item.status === "processing") {
          item.status = "failed";
          item.error = "Job cancelled by user";
        }
      });
      job.status = BatchStatus.CANCELLED;
      job.completedAt = new Date();
    }

    return true;
  }

  /**
   * Get aggregate results from batch job
   */
  getAggregateResults(jobId: string): {
    classifications: Record<string, number>;
    averageConfidence: number;
    safetyBreakdown: Record<string, number>;
    mostCommonTags: Array<{ tag: string; count: number }>;
    successRate: number;
  } {
    const job = this.jobs[jobId];
    if (!job) {
      throw new Error("Job not found");
    }

    const classifications: Record<string, number> = {};
    const safetyBreakdown: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};
    let totalConfidence = 0;
    let confidenceCount = 0;

    job.items.forEach((item) => {
      if (item.result) {
        const result = item.result as any;

        // Count classifications
        if (result.classification?.category) {
          classifications[result.classification.category] =
            (classifications[result.classification.category] || 0) + 1;
          totalConfidence += result.classification.confidence || 0;
          confidenceCount++;
        }

        // Count safety levels
        if (result.moderation?.risk_level) {
          safetyBreakdown[result.moderation.risk_level] =
            (safetyBreakdown[result.moderation.risk_level] || 0) + 1;
        }

        // Count tags
        if (result.tags?.tags) {
          result.tags.tags.forEach((tag: string) => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        }
      }
    });

    // Calculate most common tags
    const mostCommonTags = Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    return {
      classifications,
      averageConfidence:
        confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
      safetyBreakdown,
      mostCommonTags,
      successRate:
        job.totalItems > 0 ? (job.processedItems / job.totalItems) * 100 : 0,
    };
  }

  /**
   * Export batch results as CSV
   */
  exportAsCSV(jobId: string): string {
    const job = this.jobs[jobId];
    if (!job) {
      throw new Error("Job not found");
    }

    const rows = [
      "Evidence ID,Status,Classification,Confidence,Risk Level,Tags,Error",
    ];

    job.items.forEach((item) => {
      if (item.result) {
        const result = item.result as any;
        const tags =
          result.tags?.tags?.join(";") || "";
        const classification =
          result.classification?.category || "N/A";
        const confidence =
          result.classification?.confidence?.toFixed(2) || "N/A";
        const riskLevel =
          result.moderation?.risk_level || "N/A";

        rows.push(
          `${item.evidenceId},${item.status},${classification},${confidence},${riskLevel},"${tags}",${item.error || ""}`
        );
      } else {
        rows.push(
          `${item.evidenceId},${item.status},N/A,N/A,N/A,,${item.error || ""}`
        );
      }
    });

    return rows.join("\n");
  }

  /**
   * Estimate completion time
   */
  estimateCompletion(jobId: string): Date | null {
    const job = this.jobs[jobId];
    if (!job || !job.startedAt) {
      return null;
    }

    if (job.processedItems === 0) {
      return null;
    }

    const elapsed = new Date().getTime() - job.startedAt.getTime();
    const avgTimePerItem = elapsed / (job.processedItems + job.failedItems);
    const remainingItems = job.totalItems - (job.processedItems + job.failedItems);
    const estimatedRemainingMs = remainingItems * avgTimePerItem;

    const completion = new Date(
      new Date().getTime() + estimatedRemainingMs
    );
    job.estimatedCompletion = completion;
    return completion;
  }
}

export const batchAnalysisService = new BatchAnalysisService();
