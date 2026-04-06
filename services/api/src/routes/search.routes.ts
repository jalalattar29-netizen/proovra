/**
 * Advanced Search Routes
 * Full-text search, filtering, and pagination for evidence
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
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

function auditSearchAction(
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
    category: "search",
    severity: params.severity ?? "info",
    source: "api_search",
    outcome: params.outcome ?? "success",
    resourceType: params.resourceType ?? "search",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireSearchAnalytics(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "search",
    entityId: params.entityId ?? null,
    severity: "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/v1/search/evidence",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      try {
        const querySchema = z.object({
          q: z.string().min(1).max(200).optional(),
          type: z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]).optional(),
          status: z.enum(["PENDING", "SIGNED", "ARCHIVED"]).optional(),
          fromDate: z.string().datetime().optional(),
          toDate: z.string().datetime().optional(),
          caseId: z.string().uuid().optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          sortBy: z.enum(["createdAt", "updatedAt", "type"]).default("createdAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        });

        const query = querySchema.parse(req.query);
        const userId = req.user!.sub;

        const where: Record<string, any> = {
          ownerUserId: userId,
          deletedAt: null,
        };

        if (query.type) {
          where.type = query.type;
        }

        if (query.status) {
          where.status = query.status;
        }

        if (query.caseId) {
          where.caseId = query.caseId;
        }

        if (query.fromDate || query.toDate) {
          where.createdAt = {};
          if (query.fromDate) {
            where.createdAt.gte = new Date(query.fromDate);
          }
          if (query.toDate) {
            where.createdAt.lte = new Date(query.toDate);
          }
        }

        if (query.q) {
          where.OR = [
            {
              id: {
                contains: query.q,
                mode: "insensitive",
              },
            },
            {
              mimeType: {
                contains: query.q,
                mode: "insensitive",
              },
            },
          ];
        }

        const total = await prisma.evidence.count({ where });
        const skip = (query.page - 1) * query.limit;

        const evidence = await prisma.evidence.findMany({
          where,
          select: {
            id: true,
            type: true,
            status: true,
            mimeType: true,
            createdAt: true,
            updatedAt: true,
            caseId: true,
          },
          orderBy: {
            [query.sortBy]: query.sortOrder,
          },
          skip,
          take: query.limit,
        });

        auditSearchAction(req, {
          userId,
          action: "search.evidence",
          outcome: "success",
          metadata: {
            q: query.q ?? null,
            type: query.type ?? null,
            status: query.status ?? null,
            caseId: query.caseId ?? null,
            page: query.page,
            limit: query.limit,
            total,
          },
        });

        fireSearchAnalytics({
          eventType: "evidence_search_performed",
          userId,
          req,
          metadata: {
            hasQuery: Boolean(query.q),
            resultCount: evidence.length,
            total,
          },
        });

        return {
          data: evidence,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          auditSearchAction(req, {
            userId: req.user?.sub ?? null,
            action: "search.evidence",
            outcome: "failure",
            severity: "warning",
            metadata: { reason: "invalid_search_parameters" },
          });

          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid search parameters",
            { fields: error.flatten() }
          );
        }

        auditSearchAction(req, {
          userId: req.user?.sub ?? null,
          action: "search.evidence",
          outcome: "failure",
          severity: "critical",
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        throw error;
      }
    }
  );

  app.get(
    "/v1/search/cases",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      try {
        const querySchema = z.object({
          q: z.string().min(1).max(200).optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          sortBy: z.enum(["createdAt", "name"]).default("createdAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        });

        const query = querySchema.parse(req.query);
        const userId = req.user!.sub;

        const where: Record<string, any> = {
          ownerUserId: userId,
        };

        if (query.q) {
          where.OR = [
            {
              name: {
                contains: query.q,
                mode: "insensitive",
              },
            },
          ];
        }

        const total = await prisma.case.count({ where });
        const skip = (query.page - 1) * query.limit;

        const cases = await prisma.case.findMany({
          where,
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: {
            [query.sortBy]: query.sortOrder,
          },
          skip,
          take: query.limit,
        });

        auditSearchAction(req, {
          userId,
          action: "search.cases",
          outcome: "success",
          metadata: {
            q: query.q ?? null,
            page: query.page,
            limit: query.limit,
            total,
          },
        });

        fireSearchAnalytics({
          eventType: "case_search_performed",
          userId,
          req,
          metadata: {
            hasQuery: Boolean(query.q),
            resultCount: cases.length,
            total,
          },
        });

        return {
          data: cases,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          auditSearchAction(req, {
            userId: req.user?.sub ?? null,
            action: "search.cases",
            outcome: "failure",
            severity: "warning",
            metadata: { reason: "invalid_search_parameters" },
          });

          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid search parameters",
            { fields: error.flatten() }
          );
        }

        auditSearchAction(req, {
          userId: req.user?.sub ?? null,
          action: "search.cases",
          outcome: "failure",
          severity: "critical",
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        throw error;
      }
    }
  );

  app.get(
    "/v1/search/suggest",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      try {
        const q = typeof req.query.q === "string" ? req.query.q : "";
        const userId = req.user!.sub;

        if (!q || q.length < 2) {
          auditSearchAction(req, {
            userId,
            action: "search.suggest",
            outcome: "success",
            metadata: { q, suggestionCount: 0, skipped: true },
          });
          return { suggestions: [] };
        }

        const searchTerm = q.toLowerCase();

        const suggestions: Array<{
          type: string;
          id: string;
          title: string;
        }> = [];

        const evidence = await prisma.evidence.findMany({
          where: {
            ownerUserId: userId,
            deletedAt: null,
            mimeType: { contains: searchTerm, mode: "insensitive" },
          },
          select: { id: true, type: true, createdAt: true },
          take: 3,
        });

        suggestions.push(
          ...evidence.map((e: { id: string; type: string; createdAt: Date }) => ({
            type: "evidence",
            id: e.id,
            title: `${e.type} - ${new Date(e.createdAt).toLocaleDateString()}`,
          }))
        );

        const cases = await prisma.case.findMany({
          where: {
            ownerUserId: userId,
            name: { contains: searchTerm, mode: "insensitive" },
          },
          select: { id: true, name: true },
          take: 3,
        });

        suggestions.push(
          ...cases.map((c: { id: string; name: string }) => ({
            type: "case",
            id: c.id,
            title: c.name,
          }))
        );

        auditSearchAction(req, {
          userId,
          action: "search.suggest",
          outcome: "success",
          metadata: {
            q,
            suggestionCount: suggestions.length,
          },
        });

        fireSearchAnalytics({
          eventType: "search_suggestions_requested",
          userId,
          req,
          metadata: {
            qLength: q.length,
            suggestionCount: suggestions.length,
          },
        });

        return { suggestions };
      } catch (error) {
        auditSearchAction(req, {
          userId: req.user?.sub ?? null,
          action: "search.suggest",
          outcome: "failure",
          severity: "warning",
          metadata: {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });

        req.log.error({ error }, "Search suggest failed");
        return { suggestions: [] };
      }
    }
  );
}