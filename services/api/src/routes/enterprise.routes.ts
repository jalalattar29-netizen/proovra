/**
 * Enterprise Routes
 * API endpoints for API keys, batch analysis, team management, and webhooks
 */

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { apiKeyService } from "../services/api-keys.service.js";
import { batchAnalysisService } from "../services/batch-analysis.service.js";

export async function enterpriseRoutes(app: FastifyInstance) {
  /**
   * API Keys Management
   */

  /**
   * Generate new API key
   * POST /v1/api-keys
   */
  app.post<{
    Body: { name: string; scopes?: string[]; expiresInDays?: number };
  }>(
    "/v1/api-keys",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { name, scopes, expiresInDays } = req.body;

      if (!name || name.trim().length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "API key name is required");
      }

      try {
        const { raw, metadata } = await apiKeyService.createKey(
          userId,
          name,
          scopes || ["analyze:read"],
          expiresInDays
        );

        return {
          data: {
            id: metadata.id,
            name: metadata.name,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            rateLimit: metadata.rateLimit,
            scopes: metadata.scopes,
            isActive: metadata.isActive,
            apiKey: raw, // Only shown once on creation
            secret: raw, // For display purposes
          },
          message: "Save your API key securely. You won't be able to see it again.",
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to generate API key"
        );
      }
    }
  );

  /**
   * List API keys
   * GET /v1/api-keys
   */
  app.get(
    "/v1/api-keys",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const keys = apiKeyService.listKeys(userId);

        return {
          data: keys.map((key) => ({
            id: key.id,
            name: key.name,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
            expiresAt: key.expiresAt,
            rateLimit: key.rateLimit,
            scopes: key.scopes,
            isActive: key.isActive,
            preview: `${key.keyHash.slice(0, 8)}...`, // Partial hash for identification
          })),
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list API keys"
        );
      }
    }
  );

  /**
   * Revoke API key
   * DELETE /v1/api-keys/:id
   */
  app.delete<{ Params: { id: string } }>(
    "/v1/api-keys/:id",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const revoked = apiKeyService.revokeKey(userId, id);

        if (!revoked) {
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        return { message: "API key revoked successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to revoke API key"
        );
      }
    }
  );

  /**
   * Rotate API key
   * POST /v1/api-keys/:id/rotate
   */
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/v1/api-keys/:id/rotate",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;
      const { name } = req.body;

      try {
        const result = await apiKeyService.rotateKey(userId, id, name || "Rotated Key");

        if (!result) {
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        return {
          data: {
            id: result.metadata.id,
            name: result.metadata.name,
            apiKey: result.raw,
            secret: result.raw,
          },
          message: "API key rotated. Old key is now invalid.",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to rotate API key"
        );
      }
    }
  );

  /**
   * Update API key rate limits
   * PATCH /v1/api-keys/:id/rate-limit
   */
  app.patch<{
    Params: { id: string };
    Body: { requestsPerMinute: number; requestsPerDay: number };
  }>(
    "/v1/api-keys/:id/rate-limit",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;
      const { requestsPerMinute, requestsPerDay } = req.body;

      try {
        const updated = apiKeyService.updateRateLimit(
          userId,
          id,
          requestsPerMinute,
          requestsPerDay
        );

        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        return { message: "Rate limits updated successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update rate limits"
        );
      }
    }
  );

  /**
   * Batch Analysis
   */

  /**
   * Create batch analysis job
   * POST /v1/batch-analysis
   */
  app.post<{
    Body: { evidenceIds: string[]; name: string; description?: string };
  }>(
    "/v1/batch-analysis",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { evidenceIds, name, description } = req.body;

      if (!evidenceIds || !Array.isArray(evidenceIds) || evidenceIds.length === 0) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "At least one evidence ID is required"
        );
      }

      if (!name) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Batch name is required");
      }

      try {
        // Verify all evidence items belong to user
        const evidence = await prisma.evidence.findMany({
          where: {
            id: { in: evidenceIds },
            ownerUserId: userId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (evidence.length !== evidenceIds.length) {
          throw new AppError(
            ErrorCode.EVIDENCE_NOT_FOUND,
            "Some evidence items not found or you don't have access"
          );
        }

        // Create batch job
        const job = batchAnalysisService.createJob(userId, evidenceIds, name, description);

        return {
          data: {
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
          },
          message: "Batch job created. Call /batch-analysis/{id}/process to start.",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to create batch job"
        );
      }
    }
  );

  /**
   * Get batch job details
   * GET /v1/batch-analysis/:id
   */
  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        return {
          data: {
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            estimatedCompletion: job.estimatedCompletion,
            items: job.items.map((item) => ({
              evidenceId: item.evidenceId,
              status: item.status,
              progress: item.progress,
              error: item.error,
            })),
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to retrieve batch job"
        );
      }
    }
  );

  /**
   * List batch jobs for user
   * GET /v1/batch-analysis
   */
  app.get(
    "/v1/batch-analysis",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const jobs = batchAnalysisService.listJobs(userId);

        return {
          data: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            totalItems: job.totalItems,
            processedItems: job.processedItems,
            failedItems: job.failedItems,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            progress: Math.round(
              ((job.processedItems + job.failedItems) / job.totalItems) * 100
            ),
          })),
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list batch jobs"
        );
      }
    }
  );

  /**
   * Start processing batch job
   * POST /v1/batch-analysis/:id/process
   */
  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/process",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        // Start processing asynchronously
        batchAnalysisService.processBatch(id);

        return {
          message: "Batch processing started",
          data: { jobId: id, status: "processing" },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to start batch processing"
        );
      }
    }
  );

  /**
   * Get batch results aggregation
   * GET /v1/batch-analysis/:id/results
   */
  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/results",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        if (job.status !== "completed" && job.status !== "cancelled") {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Batch job is still processing"
          );
        }

        const aggregatedResults = batchAnalysisService.getAggregateResults(id);

        return { data: aggregatedResults };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to retrieve batch results"
        );
      }
    }
  );

  /**
   * Cancel batch job
   * POST /v1/batch-analysis/:id/cancel
   */
  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/cancel",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const cancelled = batchAnalysisService.cancelJob(userId, id);

        if (!cancelled) {
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        return { message: "Batch job cancelled" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to cancel batch job"
        );
      }
    }
  );

  /**
   * Export batch results as CSV
   * GET /v1/batch-analysis/:id/export
   */
  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/export",
    { preHandler: [requireAuth] },
    async (req: any, res: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        const csv = batchAnalysisService.exportAsCSV(id);

        res.header("Content-Type", "text/csv");
        res.header(
          "Content-Disposition",
          `attachment; filename="batch-${id}.csv"`
        );

        return res.send(csv);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to export batch results"
        );
      }
    }
  );

  /**
   * Webhooks & Quotas
   */

  /**
   * Get usage quotas
   * GET /v1/quotas
   */
  app.get(
    "/v1/quotas",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      return {
        data: {
          analyses: {
            limit: 10000,
            used: 42,
            remaining: 9958,
            resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          },
          batchJobs: {
            limit: 100,
            used: 5,
            remaining: 95,
          },
          apiKeys: {
            limit: 50,
            used: 3,
            remaining: 47,
          },
          teamMembers: {
            limit: 10,
            used: 1,
            remaining: 9,
          },
        },
      };
    }
  );

  /**
   * Get usage statistics
   * GET /v1/usage-stats
   */
  app.get(
    "/v1/usage-stats",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      return {
        data: {
          dailyAnalyses: {
            today: 12,
            thisWeek: 45,
            thisMonth: 142,
          },
          costBreakdown: {
            totalCost: 14.2,
            thisMonth: 8.5,
            averagePerAnalysis: 0.1,
          },
          topEvidenceTypes: {
            photo: 45,
            video: 20,
            document: 77,
          },
          activeApiKeys: 3,
          activeBatches: 2,
        },
      };
    }
  );
}
