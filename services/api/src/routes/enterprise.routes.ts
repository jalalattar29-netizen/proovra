/**
 * Enterprise Routes
 * API endpoints for API keys, batch analysis, team management, and webhooks
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
// A-3 closure — legacy in-memory `apiKeyService` import retired.
// The Phase 17 `ApiCredential` model + `/v1/integrations/api-keys`
// (team-scoped, durable, audit-backed) is the single source of truth.
// The five `/v1/api-keys*` handlers below now return HTTP 410 Gone
// and the quota counter reads directly from Prisma.
import { batchAnalysisService } from "../services/batch-analysis.service.js";
import { getEmailService } from "../services/email.service.js";
// CR1 Phase E — legacy `getWebhookService` import removed. Its only use
// in this file was a dead try/catch that fetched the service and
// immediately void'd it (no webhook was ever fired). Canonical webhook
// delivery happens via `services/integrations/webhook-dispatcher.ts`
// triggered through the integrations subsystem.
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

// PHASE 11 §3 Batch C — no Workspace/Organization is ever available here:
// `batchAnalysisService` jobs are keyed by userId only (no tenant column),
// and the legacy `/v1/api-keys*` handlers are pure retirement notices. So
// every event in this file is genuinely PLATFORM-scoped (never fabricate a
// tenant subject).
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
  const outcome =
    params.outcome === "blocked" ? "denied" : params.outcome === "failure" ? "error" : "success";
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome === "denied" ? params.action : undefined,
    sourceApp: "API",
    actorUserId: params.userId,
    resourceType: params.resourceType ?? "enterprise",
    resourceId: params.resourceId ?? null,
    correlationId: req.id,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
    },
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

  // A-3 closure — count durable, team-scoped `ApiCredential`s
  // (status = ACTIVE) for teams owned by this user. The legacy
  // in-memory user-scoped key store has been retired.
  const activeApiKeys = await prisma.apiCredential.count({
    where: {
      status: "ACTIVE",
      team: { ownerUserId: userId },
    },
  });

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
  // A-3 closure — quota counter sources from canonical `ApiCredential`
  // (Phase 17). Legacy in-memory key-store enumeration is retired.
  const apiKeysUsed = await prisma.apiCredential.count({
    where: {
      status: "ACTIVE",
      team: { ownerUserId: userId },
    },
  });

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
  // ---------------------------------------------------------------------------
  // A-3 CLOSURE — `/v1/api-keys*` legacy surface retired (HTTP 410 Gone).
  //
  // The previous handlers wrote to an in-memory `Map<>` in
  // `services/api-keys.service.ts`. That store was user-scoped, not durable,
  // had no audit trail, and was a parallel implementation to the canonical
  // Phase 17 `ApiCredential` model surfaced at `/v1/integrations/api-keys`
  // (team-scoped, durable, audit-backed, scoped to canonical permissions).
  //
  // Two-surface key management is a security finding (parallel auth state),
  // so the legacy surface is now retired:
  //
  //   - All 5 handlers below (`POST`, `GET`, `DELETE`, `POST /rotate`,
  //     `PATCH /rate-limit`) return HTTP 410 Gone.
  //   - Each retired call emits a `enterprise.api_key_legacy_endpoint_called`
  //     platform audit event tagged with the original method/path so
  //     operators can watch for residual clients that still try these.
  //   - Callers are redirected to `/v1/integrations/api-keys` via the
  //     `code: "API_KEYS_LEGACY_RETIRED"` payload.
  //
  // The legacy `services/api-keys.service.ts` file has been deleted and
  // `phase-cr1-legacy-purge.test.ts` now asserts BOTH the deletion and
  // these 410 responders.
  // ---------------------------------------------------------------------------

  const LEGACY_RETIRED_BODY = {
    code: "API_KEYS_LEGACY_RETIRED" as const,
    detail:
      "The legacy /v1/api-keys surface (in-memory, user-scoped) has been retired. " +
      "Use /v1/integrations/api-keys (team-scoped, durable, audit-backed). " +
      "See docs/recovery/audit-closure-ledger.md → A-3.",
    canonicalSurface: "/v1/integrations/api-keys",
  };

  function emitLegacyEndpointAuditAndRespond(
    req: FastifyRequest,
    reply: FastifyReply,
    legacyAction: string,
  ) {
    const userId = req.user?.sub ?? null;
    auditEnterpriseAction(req, {
      userId,
      action: "enterprise.api_key_legacy_endpoint_called",
      outcome: "blocked",
      severity: "warning",
      resourceType: "api_key",
      metadata: {
        legacyAction,
        method: req.method,
        path: getRequestPath(req),
        canonicalSurface: LEGACY_RETIRED_BODY.canonicalSurface,
      },
    });
    return reply.code(410).send(LEGACY_RETIRED_BODY);
  }

  // Phase Final-A3-PT2 — collapse the 5 explicit 410 handlers
  // (POST/GET on `/v1/api-keys`, DELETE/POST/PATCH on `/v1/api-keys/:id*`)
  // into two wildcard registrations covering every method + sub-path.
  // The closure audit ledger row for A-3 references this collapse.
  app.all("/v1/api-keys", { preHandler: [requireAuthAndLegal] }, async (req, reply) =>
    emitLegacyEndpointAuditAndRespond(req, reply, "api_keys_root"),
  );
  app.all("/v1/api-keys/*", { preHandler: [requireAuthAndLegal] }, async (req, reply) =>
    emitLegacyEndpointAuditAndRespond(req, reply, "api_keys_subpath"),
  );

  app.post<{
    Body: { evidenceIds: string[]; name: string; description?: string };
  }>(
    "/v1/batch-analysis",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
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
    async (req) => {
      const userId = getAuthUserId(req);
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
    async (req) => {
      const userId = getAuthUserId(req);

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
      } catch (error) {
        auditEnterpriseAction(req, {
          userId,
          action: "enterprise.batch_list",
          outcome: "failure",
          severity: "critical",
          resourceType: "batch_job",
        });

        throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "Failed to list batch jobs", {
          reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error",
        });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/batch-analysis/:id/process",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
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
            // CR1 Phase E — legacy in-memory webhook trigger removed.
            // It was a dead try/catch that fetched the legacy webhook
            // service factory and immediately void'd the handle. Canonical
            // webhook fan-out for batch completion belongs in the
            // integrations subsystem (see `webhook-dispatcher.ts`); add
            // it there if/when batch-complete events are wired.

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
    async (req) => {
      const userId = getAuthUserId(req);
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
    async (req) => {
      const userId = getAuthUserId(req);
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
    async (req, res) => {
      const userId = getAuthUserId(req);
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
    async (req) => {
      const userId = getAuthUserId(req);

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
          "Failed to load quotas",
          { reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error" }
        );
      }
    }
  );
  
  app.get(
    "/v1/usage-stats",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);

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
          "Failed to load usage statistics",
          { reason: error instanceof Error ? error.name.slice(0, 64) : "unknown_error" }
        );
      }
    }
  );
}