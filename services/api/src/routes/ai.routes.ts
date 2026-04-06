/**
 * AI Analysis Routes
 * Endpoints for evidence analysis, classification, and insights
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { aiService } from "../services/ai.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { presignGetObject } from "../storage.js";

// In-memory analysis cache (in production, would use Redis or DB)
const analysisCache = new Map<string, any>();

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

function auditAiAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "ai",
    severity: params.severity ?? "info",
    source: "api_ai",
    outcome: params.outcome ?? "success",
    resourceType: "evidence_ai",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireAiAnalytics(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: "evidence_ai",
    entityId: params.entityId ?? null,
    severity: "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

async function getEvidenceImageUrlOrThrow(params: {
  evidenceId: string;
  userId: string;
}) {
  const evidence = await prisma.evidence.findFirst({
    where: {
      id: params.evidenceId,
      ownerUserId: params.userId,
      deletedAt: null,
    },
    select: {
      id: true,
      type: true,
      storageBucket: true,
      storageKey: true,
    },
  });

  if (!evidence) {
    throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND);
  }

  if (!evidence.storageBucket || !evidence.storageKey) {
    throw new AppError(
      ErrorCode.INVALID_REQUEST,
      "Evidence file is not available for AI analysis"
    );
  }

  const imageUrl = await presignGetObject({
    bucket: evidence.storageBucket,
    key: evidence.storageKey,
    expiresInSeconds: 600,
  });

  return {
    evidence,
    imageUrl,
  };
}

export async function aiRoutes(app: FastifyInstance) {
  /**
   * Analyze evidence with AI
   * POST /v1/evidence/:id/analyze
   */
  app.post<{ Params: { id: string } }>(
    "/v1/evidence/:id/analyze",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const { evidence, imageUrl } = await getEvidenceImageUrlOrThrow({
          evidenceId: id,
          userId,
        });

        const analysis = await aiService.analyzeEvidence(imageUrl, evidence.type);

        const cacheKey = `${userId}:${id}`;
        const createdAt = new Date();

        analysisCache.set(cacheKey, {
          evidenceId: id,
          ...analysis,
          createdAt,
        });

        auditAiAction(req, {
          userId,
          action: "ai.analysis_run",
          outcome: "success",
          resourceId: id,
          metadata: {
            evidenceType: evidence.type,
            classification: analysis.classification?.category ?? null,
            riskLevel: analysis.moderation?.risk_level ?? null,
            tagCount: Array.isArray(analysis.tags?.tags) ? analysis.tags.tags.length : 0,
          },
        });

        fireAiAnalytics({
          eventType: "ai_analysis_completed",
          userId,
          req,
          entityId: id,
          metadata: {
            evidenceType: evidence.type,
            classification: analysis.classification?.category ?? null,
            riskLevel: analysis.moderation?.risk_level ?? null,
          },
        });

        return {
          data: {
            id: `analysis_${id}`,
            evidenceId: id,
            classification: analysis.classification,
            metadata: analysis.metadata,
            description: analysis.description,
            moderation: analysis.moderation,
            tags: analysis.tags,
            createdAt,
          },
        };
      } catch (error) {
        auditAiAction(req, {
          userId,
          action: "ai.analysis_run",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        if (error instanceof AppError) {
          throw error;
        }

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to analyze evidence"
        );
      }
    }
  );

  /**
   * Get analysis result for evidence
   * GET /v1/evidence/:id/analysis
   */
  app.get<{ Params: { id: string } }>(
    "/v1/evidence/:id/analysis",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      const evidence = await prisma.evidence.findFirst({
        where: { id, ownerUserId: userId, deletedAt: null },
        select: { id: true },
      });

      if (!evidence) {
        auditAiAction(req, {
          userId,
          action: "ai.analysis_view",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_not_found" },
        });
        throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND);
      }

      const cacheKey = `${userId}:${id}`;
      const analysis = analysisCache.get(cacheKey);

      auditAiAction(req, {
        userId,
        action: "ai.analysis_view",
        outcome: "success",
        resourceId: id,
        metadata: {
          cached: Boolean(analysis),
        },
      });

      if (!analysis) {
        return {
          data: null,
          message: "No analysis available. Run analysis first.",
        };
      }

      return { data: analysis };
    }
  );

  /**
   * Suggest tags for evidence
   * POST /v1/evidence/:id/suggest-tags
   */
  app.post<{ Params: { id: string } }>(
    "/v1/evidence/:id/suggest-tags",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const { evidence, imageUrl } = await getEvidenceImageUrlOrThrow({
          evidenceId: id,
          userId,
        });

        const tagSuggestion = await aiService.suggestTags(imageUrl, evidence.type);

        auditAiAction(req, {
          userId,
          action: "ai.tags_suggested",
          outcome: "success",
          resourceId: id,
          metadata: {
            evidenceType: evidence.type,
            tagCount: Array.isArray(tagSuggestion.tags) ? tagSuggestion.tags.length : 0,
          },
        });

        fireAiAnalytics({
          eventType: "ai_tags_suggested",
          userId,
          req,
          entityId: id,
          metadata: {
            evidenceType: evidence.type,
            tagCount: Array.isArray(tagSuggestion.tags) ? tagSuggestion.tags.length : 0,
          },
        });

        return {
          data: {
            tags: tagSuggestion.tags,
            confidence: tagSuggestion.confidence_per_tag,
          },
        };
      } catch (error) {
        auditAiAction(req, {
          userId,
          action: "ai.tags_suggested",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        if (error instanceof AppError) {
          throw error;
        }

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to suggest tags"
        );
      }
    }
  );

  /**
   * Get AI insights dashboard
   * GET /v1/insights
   */
  app.get(
    "/v1/insights",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const userAnalyses: any[] = [];
        analysisCache.forEach((analysis, key) => {
          if (key.startsWith(`${userId}:`)) {
            userAnalyses.push(analysis);
          }
        });

        const classificationCounts: Record<string, number> = {};
        const moderationRisks: Record<string, number> = {};
        const allTags: Record<string, number> = {};

        userAnalyses.forEach((analysis) => {
          const classification = analysis.classification?.category;
          if (classification) {
            classificationCounts[classification] =
              (classificationCounts[classification] || 0) + 1;
          }

          const risk = analysis.moderation?.risk_level || "unknown";
          moderationRisks[risk] = (moderationRisks[risk] || 0) + 1;

          const tags = analysis.tags?.tags || [];
          tags.forEach((tag: string) => {
            allTags[tag] = (allTags[tag] || 0) + 1;
          });
        });

        const usageStats = aiService.getUsageStats();

        const evidenceCount = await prisma.evidence.count({
          where: {
            ownerUserId: userId,
            deletedAt: null,
          },
        });

        auditAiAction(req, {
          userId,
          action: "ai.insights_view",
          outcome: "success",
          metadata: {
            totalAnalyzed: userAnalyses.length,
            totalEvidence: evidenceCount,
          },
        });

        fireAiAnalytics({
          eventType: "ai_insights_viewed",
          userId,
          req,
          metadata: {
            totalAnalyzed: userAnalyses.length,
            totalEvidence: evidenceCount,
          },
        });

        return {
          data: {
            total_analyzed: userAnalyses.length,
            total_evidence: evidenceCount,
            classification_distribution: classificationCounts,
            moderation_distribution: moderationRisks,
            top_tags: Object.entries(allTags)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([tag, count]) => ({ tag, count })),
            api_usage: {
              total_calls: usageStats.total_calls,
              total_cost_usd: usageStats.total_cost_usd.toFixed(2),
              average_cost_per_call: usageStats.average_cost_per_call.toFixed(4),
            },
            recent_analyses: userAnalyses.slice(0, 10).map((a) => ({
              id: a.id || "unknown",
              evidenceId: a.evidenceId || "unknown",
              classification: a.classification?.category,
              riskLevel: a.moderation?.risk_level,
              createdAt: a.createdAt,
            })),
          },
        };
      } catch (error) {
        auditAiAction(req, {
          userId,
          action: "ai.insights_view",
          outcome: "failure",
          severity: "warning",
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        req.log.error({ error }, "Failed to get insights");
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to load insights"
        );
      }
    }
  );

  /**
   * Check content safety (quick moderation)
   * POST /v1/evidence/:id/check-safety
   */
  app.post<{ Params: { id: string } }>(
    "/v1/evidence/:id/check-safety",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const { evidence, imageUrl } = await getEvidenceImageUrlOrThrow({
          evidenceId: id,
          userId,
        });

        const moderation = await aiService.checkModeration(imageUrl);

        auditAiAction(req, {
          userId,
          action: "ai.safety_check",
          outcome: "success",
          resourceId: id,
          metadata: {
            evidenceType: evidence.type,
            isSafe: moderation.is_safe,
            riskLevel: moderation.risk_level,
          },
        });

        fireAiAnalytics({
          eventType: "ai_safety_checked",
          userId,
          req,
          entityId: id,
          metadata: {
            evidenceType: evidence.type,
            isSafe: moderation.is_safe,
            riskLevel: moderation.risk_level,
          },
        });

        return {
          data: {
            is_safe: moderation.is_safe,
            risk_level: moderation.risk_level,
            flags: moderation.flags,
            confidence: moderation.confidence,
            recommendation: moderation.recommendation,
          },
        };
      } catch (error) {
        auditAiAction(req, {
          userId,
          action: "ai.safety_check",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        if (error instanceof AppError) {
          throw error;
        }

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to check content safety"
        );
      }
    }
  );

  /**
   * Get AI usage statistics
   * GET /v1/ai/usage
   */
  app.get(
    "/v1/ai/usage",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const stats = aiService.getUsageStats();

      auditAiAction(req, {
        userId,
        action: "ai.usage_view",
        outcome: "success",
        metadata: {
          totalCalls: stats.total_calls,
        },
      });

      return {
        data: {
          total_calls: stats.total_calls,
          total_cost_usd: stats.total_cost_usd.toFixed(2),
          average_cost_per_call: stats.average_cost_per_call.toFixed(4),
          calls_by_type: stats.calls_by_type,
        },
      };
    }
  );
}