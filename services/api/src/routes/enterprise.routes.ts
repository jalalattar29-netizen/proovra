/**
 * Enterprise Routes
 * API endpoints for API keys, batch analysis, team management, and webhooks
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { apiKeyService } from "../services/api-keys.service.js";
import { batchAnalysisService } from "../services/batch-analysis.service.js";
import { getEmailService } from "../services/email.service.js";
import { getWebhookService } from "../services/webhook.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditEnterpriseAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "enterprise",
    severity: params.severity ?? "info",
    source: "api_enterprise",
    outcome: params.outcome ?? "success",
    resourceType: params.resourceType ?? "enterprise",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireEnterpriseAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "enterprise",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextMonthStart(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clampRemaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

async function getRealUsageStats(userId: string) {
  const today = startOfToday();
  const week = startOfWeek();
  const month = startOfMonth();

  const billableEventTypes = [
    "ai_analysis_completed",
    "ai_tags_suggested",
    "ai_safety_checked",
  ];

  const [todayCount, weekCount, monthCount, totalCount, evidenceTypes] =
    await Promise.all([
      prisma.analyticsEvent.count({
        where: {
          userId,
          eventType: { in: billableEventTypes },
          createdAt: { gte: today },
        },
      }),
      prisma.analyticsEvent.count({
        where: {
          userId,
          eventType: { in: billableEventTypes },
          createdAt: { gte: week },
        },
      }),
      prisma.analyticsEvent.count({
        where: {
          userId,
          eventType: { in: billableEventTypes },
          createdAt: { gte: month },
        },
      }),
      prisma.analyticsEvent.count({
        where: {
          userId,
          eventType: { in: billableEventTypes },
        },
      }),
      prisma.evidence.groupBy({
        by: ["type"],
        where: {
          ownerUserId: userId,
          deletedAt: null,
        },
        _count: { type: true },
      }),
    ]);

  const unitCost = readFloatEnv("AI_ANALYSIS_UNIT_PRICE_USD", 0.1);

  const topEvidenceTypes: Record<string, number> = {};
  for (const row of evidenceTypes) {
    topEvidenceTypes[String(row.type).toLowerCase()] = row._count.type;
  }

  const activeApiKeys = apiKeyService
    .listKeys(userId)
    .filter((key) => key.isActive).length;

  const activeBatches = batchAnalysisService
    .listJobs(userId)
    .filter((job) => job.status === "pending" || job.status === "processing").length;

  return {
    dailyAnalyses: {
      today: todayCount,
      thisWeek: weekCount,
      thisMonth: monthCount,
    },
    costBreakdown: {
      totalCost: totalCount * unitCost,
      thisMonth: monthCount * unitCost,
      averagePerAnalysis: totalCount > 0 ? (totalCount * unitCost) / totalCount : 0,
    },
    topEvidenceTypes,
    activeApiKeys,
    activeBatches,
  };
}

async function getRealQuotas(userId: string) {
  const month = startOfMonth();

  const analysesUsed = await prisma.analyticsEvent.count({
    where: {
      userId,
      eventType: {
        in: ["ai_analysis_completed", "ai_tags_suggested", "ai_safety_checked"],
      },
      createdAt: { gte: month },
    },
  });

  const batchJobsUsed = batchAnalysisService.listJobs(userId).length;
  const apiKeysUsed = apiKeyService.listKeys(userId).filter((key) => key.isActive).length;

  let teamMembersUsed = 0;

  try {
    teamMembersUsed = await prisma.teamMember.count({
      where: {
        team: {
          ownerUserId: userId,
        },
      },
    });
  } catch {
    teamMembersUsed = 0;
  }
  
  const analysesLimit = readIntEnv("QUOTA_ANALYSES_MONTHLY_LIMIT", 10000);
  const batchJobsLimit = readIntEnv("QUOTA_BATCH_JOBS_LIMIT", 100);
  const apiKeysLimit = readIntEnv("QUOTA_API_KEYS_LIMIT", 50);
  const activeEntitlement = await prisma.entitlement.findFirst({
  where: {
    userId,
    active: true,
  },
  orderBy: {
    createdAt: "desc",
  },
});

const teamMembersLimit =
  activeEntitlement?.teamSeats && activeEntitlement.teamSeats > 0
    ? activeEntitlement.teamSeats
    : readIntEnv("QUOTA_TEAM_MEMBERS_LIMIT", 10);

  return {
    analyses: {
      limit: analysesLimit,
      used: analysesUsed,
      remaining: clampRemaining(analysesLimit, analysesUsed),
      resetDate: nextMonthStart().toISOString(),
    },
    batchJobs: {
      limit: batchJobsLimit,
      used: batchJobsUsed,
      remaining: clampRemaining(batchJobsLimit, batchJobsUsed),
    },
    apiKeys: {
      limit: apiKeysLimit,
      used: apiKeysUsed,
      remaining: clampRemaining(apiKeysLimit, apiKeysUsed),
    },
    teamMembers: {
      limit: teamMembersLimit,
      used: teamMembersUsed,
      remaining: clampRemaining(teamMembersLimit, teamMembersUsed),
    },
  };
}

export async function enterpriseRoutes(app: FastifyInstance) {
  app.post<{
    Body: { name: string; scopes?: string[]; expiresInDays?: number };
  }>(
    "/v1/api-keys",
    { preHandler: [requireAuthAndLegal] },
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

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_create",
          outcome: "success",
          resourceType: "api_key",
          resourceId: metadata.id,
          metadata: {
            name: metadata.name,
            scopes: metadata.scopes,
            expiresAt: metadata.expiresAt,
          },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "api_key_created",
          userId,
          req,
          entityType: "api_key",
          entityId: metadata.id,
          metadata: { scopes: metadata.scopes.length },
        });

        return {
          data: {
            id: metadata.id,
            name: metadata.name,
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            rateLimit: metadata.rateLimit,
            scopes: metadata.scopes,
            isActive: metadata.isActive,
            apiKey: raw,
            secret: raw,
          },
          message: "Save your API key securely. You won't be able to see it again.",
        };
      } catch (_error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_create",
          outcome: "failure",
          severity: "critical",
          resourceType: "api_key",
          metadata: { name },
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to generate API key");
      }
    }
  );

  app.get(
    "/v1/api-keys",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const keys = apiKeyService.listKeys(userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_keys_list",
          outcome: "success",
          resourceType: "api_key",
          metadata: { count: keys.length },
        });

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
            preview: `${key.keyHash.slice(0, 8)}...`,
          })),
        };
      } catch (_error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_keys_list",
          outcome: "failure",
          severity: "critical",
          resourceType: "api_key",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to list API keys");
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/api-keys/:id",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const revoked = apiKeyService.revokeKey(userId, id);

        if (!revoked) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.api_key_revoke",
            outcome: "failure",
            severity: "warning",
            resourceType: "api_key",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_revoke",
          outcome: "success",
          resourceType: "api_key",
          resourceId: id,
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "api_key_revoked",
          userId,
          req,
          entityType: "api_key",
          entityId: id,
        });

        return { message: "API key revoked successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_revoke",
          outcome: "failure",
          severity: "critical",
          resourceType: "api_key",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to revoke API key");
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/v1/api-keys/:id/rotate",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;
      const { name } = req.body;

      try {
        const result = await apiKeyService.rotateKey(userId, id, name || "Rotated Key");

        if (!result) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.api_key_rotate",
            outcome: "failure",
            severity: "warning",
            resourceType: "api_key",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_rotate",
          outcome: "success",
          resourceType: "api_key",
          resourceId: result.metadata.id,
          metadata: { name: result.metadata.name },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "api_key_rotated",
          userId,
          req,
          entityType: "api_key",
          entityId: result.metadata.id,
        });

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

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_rotate",
          outcome: "failure",
          severity: "critical",
          resourceType: "api_key",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to rotate API key");
      }
    }
  );

  app.patch<{
    Params: { id: string };
    Body: { requestsPerMinute: number; requestsPerDay: number };
  }>(
    "/v1/api-keys/:id/rate-limit",
    { preHandler: [requireAuthAndLegal] },
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
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.api_key_rate_limit_update",
            outcome: "failure",
            severity: "warning",
            resourceType: "api_key",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "API key not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_rate_limit_update",
          outcome: "success",
          resourceType: "api_key",
          resourceId: id,
          metadata: { requestsPerMinute, requestsPerDay },
        });

        return { message: "Rate limits updated successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.api_key_rate_limit_update",
          outcome: "failure",
          severity: "critical",
          resourceType: "api_key",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to update rate limits");
      }
    }
  );

  app.post<{
    Body: { evidenceIds: string[]; name: string; description?: string };
  }>(
    "/v1/batch-analysis",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { evidenceIds, name, description } = req.body;

      if (!evidenceIds || !Array.isArray(evidenceIds) || evidenceIds.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "At least one evidence ID is required");
      }

      if (!name) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Batch name is required");
      }

      try {
        const evidence = await prisma.evidence.findMany({
          where: {
            id: { in: evidenceIds },
            ownerUserId: userId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (evidence.length !== evidenceIds.length) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_create",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            metadata: { reason: "evidence_not_found_or_forbidden" },
          });

          throw new AppError(
            ErrorCode.EVIDENCE_NOT_FOUND,
            "Some evidence items not found or you don't have access"
          );
        }

        const job = batchAnalysisService.createJob(userId, evidenceIds, name, description);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_create",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: job.id,
          metadata: {
            name: job.name,
            totalItems: job.totalItems,
          },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_created",
          userId,
          req,
          entityType: "batch_job",
          entityId: job.id,
          metadata: { totalItems: job.totalItems },
        });

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

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_create",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to create batch job");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_view",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_view",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
          metadata: { status: job.status },
        });

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

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to retrieve batch job");
      }
    }
  );

  app.get(
    "/v1/batch-analysis",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const jobs = batchAnalysisService.listJobs(userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_list",
          outcome: "success",
          resourceType: "batch_job",
          metadata: { count: jobs.length },
        });

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
      } catch (_error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_list",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to list batch jobs");
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/process",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_process",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        const processingPromise = batchAnalysisService.processBatch(id);

        processingPromise
          .then(() => {
            try {
              const webhookService = getWebhookService();
              const completedJob = batchAnalysisService.getJob(userId, id);
              if (completedJob) {
                void webhookService;
              }
            } catch (error) {
              console.error("Failed to trigger webhook event:", error);
            }

            try {
              const emailService = getEmailService();
              if (emailService.isConfigured()) {
                const completedJob = batchAnalysisService.getJob(userId, id);
                if (completedJob) {
                  const userEmail = req.user?.email || "";
                  if (userEmail) {
                    void emailService.sendBatchComplete(
                      userEmail,
                      "Organization",
                      completedJob.name,
                      completedJob.totalItems,
                      completedJob.failedItems,
                      `${process.env.APP_URL || "https://app.proovra.com"}/batch/${completedJob.id}`
                    );
                  }
                }
              }
            } catch (error) {
              console.error("Failed to send batch completion email:", error);
            }
          })
          .catch((error) => {
            console.error("Error in batch processing completion handlers:", error);
          });

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_process",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
          metadata: { status: "processing" },
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_processing_started",
          userId,
          req,
          entityType: "batch_job",
          entityId: id,
        });

        return {
          message: "Batch processing started",
          data: { jobId: id, status: "processing" },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_process",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to start batch processing");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/results",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_results_view",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        if (job.status !== "completed" && job.status !== "cancelled") {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_results_view",
            outcome: "blocked",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "still_processing", status: job.status },
          });
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Batch job is still processing");
        }

        const aggregatedResults = batchAnalysisService.getAggregateResults(id);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_results_view",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        return { data: aggregatedResults };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_results_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to retrieve batch results");
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/cancel",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const cancelled = batchAnalysisService.cancelJob(userId, id);

        if (!cancelled) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_cancel",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_cancel",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        fireEnterpriseAnalyticsEvent({
          eventType: "batch_job_cancelled",
          userId,
          req,
          entityType: "batch_job",
          entityId: id,
        });

        return { message: "Batch job cancelled" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_cancel",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to cancel batch job");
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/export",
    { preHandler: [requireAuthAndLegal] },
    async (req: any, res: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const job = batchAnalysisService.getJob(userId, id);

        if (!job) {
          auditEnterpriseAction(req, {
            userId,
            action: "enterprise.batch_export",
            outcome: "failure",
            severity: "warning",
            resourceType: "batch_job",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Batch job not found");
        }

        const csv = batchAnalysisService.exportAsCSV(id);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_export",
          outcome: "success",
          resourceType: "batch_job",
          resourceId: id,
        });

        res.header("Content-Type", "text/csv");
        res.header("Content-Disposition", `attachment; filename="batch-${id}.csv"`);

        return res.send(csv);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_export",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
          resourceId: id,
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to export batch results");
      }
    }
  );

  app.get(
    "/v1/quotas",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const data = await getRealQuotas(userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.quotas_view",
          outcome: "success",
          resourceType: "quotas",
        });

        return { data };
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.quotas_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "quotas",
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to load quotas"
        );
      }
    }
  );
  
  app.get(
    "/v1/usage-stats",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const data = await getRealUsageStats(userId);

        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.usage_stats_view",
          outcome: "success",
          resourceType: "usage_stats",
        });

        return { data };
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.usage_stats_view",
          outcome: "failure",
          severity: "critical",
          resourceType: "usage_stats",
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to load usage statistics"
        );
      }
    }
  );
}