/**
 * AI Analysis Routes
 * Endpoints for evidence analysis, classification, and insights
 */

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { aiService } from "../services/ai.service.js";

// In-memory analysis cache (in production, would use Redis or DB)
const analysisCache = new Map<string, any>();

export async function aiRoutes(app: FastifyInstance) {
  /**
   * Analyze evidence with AI
   * POST /v1/evidence/:id/analyze
   */
  app.post<{ Params: { id: string } }>(
    "/v1/evidence/:id/analyze",
    { preHandler: [requireAuth] },
    async (req: any, res: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        // Get evidence
        const evidence = await prisma.evidence.findFirst({
          where: { id, ownerUserId: userId },
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

        // Get signed URL for image
        // For now, use a placeholder - in production, would get actual S3 URL
        const imageUrl = `https://storage.example.com/${evidence.storageBucket}/${evidence.storageKey}`;

        // Run AI analysis
        const analysis = await aiService.analyzeEvidence(imageUrl, evidence.type);

        // Cache analysis result (in-memory for now)
        const cacheKey = `${userId}:${id}`;
        analysisCache.set(cacheKey, {
          ...analysis,
          createdAt: new Date(),
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
            createdAt: new Date(),
          },
        };
      } catch (error) {
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
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      // Verify evidence exists and belongs to user
      const evidence = await prisma.evidence.findFirst({
        where: { id, ownerUserId: userId },
        select: { id: true },
      });

      if (!evidence) {
        throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND);
      }

      // Get cached analysis result
      const cacheKey = `${userId}:${id}`;
      const analysis = analysisCache.get(cacheKey);

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
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        // Verify evidence exists
        const evidence = await prisma.evidence.findFirst({
          where: { id, ownerUserId: userId },
          select: { id: true, type: true },
        });

        if (!evidence) {
          throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND);
        }

        // Get image URL
        const imageUrl = `https://storage.example.com/evidence/${id}`;

        // Get tags
        const tagSuggestion = await aiService.suggestTags(imageUrl, evidence.type);

        return {
          data: {
            tags: tagSuggestion.tags,
            confidence: tagSuggestion.confidence_per_tag,
          },
        };
      } catch (error) {
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
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        // Get all cached analyses for user
        const userAnalyses: any[] = [];
        analysisCache.forEach((analysis, key) => {
          if (key.startsWith(`${userId}:`)) {
            userAnalyses.push(analysis);
          }
        });

        // Aggregate classifications
        const classificationCounts: Record<string, number> = {};
        const moderationRisks: Record<string, number> = {};
        const allTags: Record<string, number> = {};

        userAnalyses.forEach((analysis) => {
          // Count classifications
          const classification = analysis.classification?.category;
          if (classification) {
            classificationCounts[classification] =
              (classificationCounts[classification] || 0) + 1;
          }

          // Count moderation risks
          const risk = analysis.moderation?.risk_level || "unknown";
          moderationRisks[risk] = (moderationRisks[risk] || 0) + 1;

          // Count tags
          const tags = analysis.tags?.tags || [];
          tags.forEach((tag: string) => {
            allTags[tag] = (allTags[tag] || 0) + 1;
          });
        });

        // Get API usage stats
        const usageStats = aiService.getUsageStats();

        // Get total evidence count
        const evidenceCount = await prisma.evidence.count({
          where: {
            ownerUserId: userId,
            deletedAt: null,
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
            recent_analyses: userAnalyses
              .slice(0, 10)
              .map((a) => ({
                id: a.id || "unknown",
                evidenceId: a.evidenceId || "unknown",
                classification: a.classification?.category,
                riskLevel: a.moderation?.risk_level,
                createdAt: a.createdAt,
              })),
          },
        };
      } catch (error) {
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
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        // Verify evidence exists
        const evidence = await prisma.evidence.findFirst({
          where: { id, ownerUserId: userId },
          select: { id: true },
        });

        if (!evidence) {
          throw new AppError(ErrorCode.EVIDENCE_NOT_FOUND);
        }

        // Get image URL
        const imageUrl = `https://storage.example.com/evidence/${id}`;

        // Check moderation
        const moderation = await aiService.checkModeration(imageUrl);

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
    { preHandler: [requireAuth] },
    async (req: any) => {
      const stats = aiService.getUsageStats();

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
