/**
 * Advanced Search Routes
 * Full-text search, filtering, and pagination for evidence
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";
import { z } from "zod";
import {
  SAVED_VIEW_VISIBILITIES,
  SearchFilterSchema,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_SORT_MODES,
  type SavedViewVisibility,
  type SearchFilterInput,
} from "@proovra/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  createRelationship,
  executeSearch,
  listRelationshipsForEvidence,
} from "../services/search/evidence-search.service.js";
import {
  createSavedView,
  deleteSavedView,
  listSavedViewsForUser,
} from "../services/search/saved-search.service.js";
import {
  indexEvidence,
  indexWorkflowInstance,
} from "../services/search/evidence-indexing.service.js";
import {
  listSearchAudit,
  recordSearchAudit,
} from "../services/search/search-audit.service.js";

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

/**
 * Phase 24 — 404-on-non-member + reviewer-capability resolution.
 * Returns `null` when the actor is not a team member; the route should
 * return immediately. `isReviewerCapable` controls whether the search
 * service exposes reviewer-restricted rows.
 */
async function requireSearchActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string
): Promise<{ userId: string; isReviewerCapable: boolean } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const baseDecision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!baseDecision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: baseDecision.reason,
        detail: baseDecision.detail ?? null,
      },
    });
    return null;
  }
  const reviewerDecision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.access_review.action",
  });
  return { userId, isReviewerCapable: reviewerDecision.allowed };
}

/**
 * Phase 24 — Operator gate for write actions (reindex + create
 * relationship). Requires identity.access_review.action.
 */
async function requireSearchOperator(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string
): Promise<{ userId: string } | null> {
  const actor = await requireSearchActor(req, reply, teamId);
  if (!actor) return null;
  if (!actor.isReviewerCapable) {
    reply.code(403).send({
      error: { code: "permission_denied", reason: "operator_required" },
    });
    return null;
  }
  return { userId: actor.userId };
}

function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
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

  // =========================================================================
  // Phase 24 — Enterprise Search + Evidence Discovery Platform
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /v1/search — main discovery query
  // -------------------------------------------------------------------------
  app.get(
    "/v1/search",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.query ?? {}) as Record<string, unknown>;
      const teamId = typeof raw.teamId === "string" ? raw.teamId : null;
      if (!teamId) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", reason: "teamId_required" } });
      }
      const actor = await requireSearchActor(req, reply, teamId);
      if (!actor) return;

      const candidate: Record<string, unknown> = {
        teamId,
        q: typeof raw.q === "string" ? raw.q : undefined,
        documentTypes: parseStringList(raw.documentTypes),
        evidenceTypes: parseStringList(raw.evidenceTypes),
        workflowStatuses: parseStringList(raw.workflowStatuses),
        reviewStatuses: parseStringList(raw.reviewStatuses),
        onLegalHold: parseBool(raw.onLegalHold),
        exportRestricted: parseBool(raw.exportRestricted),
        incidentLinked: parseBool(raw.incidentLinked),
        workflowLinked: parseBool(raw.workflowLinked),
        contributorScoped: parseBool(raw.contributorScoped),
        updatedSinceUtc:
          typeof raw.updatedSinceUtc === "string" ? raw.updatedSinceUtc : undefined,
        updatedUntilUtc:
          typeof raw.updatedUntilUtc === "string" ? raw.updatedUntilUtc : undefined,
        sort: typeof raw.sort === "string" ? raw.sort : undefined,
        cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
        limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
      };
      // Strip undefined so .strict() doesn't reject.
      for (const k of Object.keys(candidate)) {
        if (candidate[k] === undefined) delete candidate[k];
      }
      const parsed = SearchFilterSchema.safeParse(candidate);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "validation_error",
            detail: parsed.error.flatten(),
          },
        });
      }
      const filter: SearchFilterInput = parsed.data;
      const result = await executeSearch({
        actorUserId: actor.userId,
        isReviewerCapable: actor.isReviewerCapable,
        filter,
        // Phase 24-B — propagate request context so the dedicated
        // audit row carries surface + requestId + hashed ip.
        surface: "api:/v1/search",
        requestId: req.id,
        ipAddress: req.ip,
      });
      return reply.code(200).send({
        rows: result.rows,
        nextCursor: result.nextCursor,
        totalReturned: result.totalReturned,
        filteredByGovernance: result.filteredByGovernance,
        filteredByVisibility: result.filteredByVisibility,
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/search/saved-views?teamId=...
  // -------------------------------------------------------------------------
  app.get(
    "/v1/search/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireSearchActor(req, reply, q.teamId);
      if (!actor) return;
      const views = await listSavedViewsForUser({
        teamId: q.teamId,
        userId: actor.userId,
        limit: q.limit,
      });
      return reply.code(200).send({ views });
    }
  );

  // -------------------------------------------------------------------------
  // POST /v1/search/saved-views — create a saved view
  // -------------------------------------------------------------------------
  app.post(
    "/v1/search/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().min(1).max(120),
          description: z.string().max(400).nullable().optional(),
          visibility: z.enum(
            SAVED_VIEW_VISIBILITIES as unknown as [string, ...string[]]
          ),
          pinned: z.boolean().optional(),
          query: SearchFilterSchema,
        })
        .parse(req.body ?? {});
      if (body.query.teamId !== body.teamId) {
        return reply.code(400).send({
          error: { code: "validation_error", reason: "teamId_mismatch" },
        });
      }
      const actor = await requireSearchActor(req, reply, body.teamId);
      if (!actor) return;
      const view = await createSavedView({
        teamId: body.teamId,
        actorUserId: actor.userId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility as SavedViewVisibility,
        pinned: body.pinned ?? false,
        query: body.query,
      });
      if (!view) {
        return reply
          .code(409)
          .send({ error: { code: "duplicate_saved_view" } });
      }
      return reply.code(201).send({ view });
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/search/saved-views/:id
  // -------------------------------------------------------------------------
  app.delete(
    "/v1/search/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
      const actor = await requireSearchActor(req, reply, q.teamId);
      if (!actor) return;
      const ok = await deleteSavedView({
        teamId: q.teamId,
        actorUserId: actor.userId,
        id,
      });
      if (!ok) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(204).send();
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/search/relationships/:evidenceId
  // -------------------------------------------------------------------------
  app.get(
    "/v1/search/relationships/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireSearchActor(req, reply, q.teamId);
      if (!actor) return;
      const relationships = await listRelationshipsForEvidence({
        teamId: q.teamId,
        evidenceId,
        limit: q.limit,
      });
      return reply.code(200).send({ relationships });
    }
  );

  // -------------------------------------------------------------------------
  // POST /v1/search/relationships — create
  // -------------------------------------------------------------------------
  app.post(
    "/v1/search/relationships",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          sourceEvidenceId: z.string().uuid(),
          targetEvidenceId: z.string().uuid(),
          relationshipType: z.enum([
            "RELATED",
            "SUPPORTS",
            "DUPLICATE_OF",
            "DERIVED_FROM",
            "SAME_INCIDENT",
            "CONTRADICTS",
            "REPLACES",
            "REFERENCES",
          ]),
          note: z.string().max(1000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const operator = await requireSearchOperator(req, reply, body.teamId);
      if (!operator) return;
      const row = await createRelationship({
        teamId: body.teamId,
        sourceEvidenceId: body.sourceEvidenceId,
        targetEvidenceId: body.targetEvidenceId,
        relationshipType:
          body.relationshipType as prismaPkg.EvidenceRelationshipType,
        note: body.note ?? null,
        createdByUserId: operator.userId,
      });
      if (!row) {
        return reply
          .code(409)
          .send({ error: { code: "duplicate_or_invalid_relationship" } });
      }
      return reply.code(201).send({
        relationship: {
          relationshipId: row.id,
          sourceEvidenceId: row.sourceEvidenceId,
          targetEvidenceId: row.targetEvidenceId,
          relationshipType: row.relationshipType,
          note: row.note,
          createdByUserId: row.createdByUserId,
          createdAt: row.createdAt.toISOString(),
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /v1/search/reindex/evidence/:id — operator reindex
  // -------------------------------------------------------------------------
  app.post(
    "/v1/search/reindex/evidence/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const operator = await requireSearchOperator(req, reply, body.teamId);
      if (!operator) return;
      const result = await indexEvidence({ teamId: body.teamId, evidenceId: id });
      if (!result.ok) {
        return reply.code(409).send({
          error: { code: "indexing_failed", reason: result.reason },
        });
      }
      return reply.code(200).send({
        documentId: result.documentId,
        created: result.created,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /v1/search/reindex/workflow/:id — operator reindex
  // -------------------------------------------------------------------------
  app.post(
    "/v1/search/reindex/workflow/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const operator = await requireSearchOperator(req, reply, body.teamId);
      if (!operator) return;
      const result = await indexWorkflowInstance({
        teamId: body.teamId,
        workflowInstanceId: id,
      });
      if (!result.ok) {
        return reply.code(409).send({
          error: { code: "indexing_failed", reason: result.reason },
        });
      }
      return reply.code(200).send({
        documentId: result.documentId,
        created: result.created,
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/search/audit — Phase 24-J Discovery audit log
  //
  // Operator-facing audit log for every Discovery / Enterprise Search
  // query the platform has run. The handler enforces the same
  // `requireSearchOperator` gate the reindex handlers use — only
  // OWNER / ADMIN / REVIEWER roles can read who searched for what.
  // Raw query text is NEVER returned (only a hash prefix), so this
  // surface does not become a leak vector.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/search/audit",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          actorUserId: z.string().uuid().optional(),
          failClosedOnly: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          beforeUtc: z.string().datetime().optional(),
        })
        .parse(req.query ?? {});
      const operator = await requireSearchOperator(req, reply, q.teamId);
      if (!operator) return;
      const result = await listSearchAudit({
        teamId: q.teamId,
        actorUserId: q.actorUserId ?? null,
        failClosedOnly: q.failClosedOnly ?? false,
        limit: q.limit,
        beforeUtc: q.beforeUtc ?? null,
      });
      // The act of reading the audit log is itself an audit-worthy
      // operation. We record it with a synthetic surface so compliance
      // can see "who pulled the search audit log".
      void recordSearchAudit({
        teamId: q.teamId,
        actorUserId: operator.userId,
        surface: "api:/v1/search/audit",
        queryText: null,
        documentTypes: null,
        filters: {
          actorUserId: q.actorUserId ?? null,
          failClosedOnly: q.failClosedOnly ?? false,
        },
        resultCount: result.rows.length,
        filteredGovernanceCount: 0,
        filteredVisibilityCount: 0,
        failClosed: false,
        requestId: req.id,
        ipAddress: req.ip,
      });
      return reply.code(200).send({
        rows: result.rows,
        nextBeforeUtc: result.nextBeforeUtc,
      });
    },
  );

  // Reference SEARCH_DOCUMENT_TYPES / SEARCH_SORT_MODES to keep them
  // surfaced for OpenAPI tooling (avoids unused-import lint noise).
  void SEARCH_DOCUMENT_TYPES;
  void SEARCH_SORT_MODES;
}