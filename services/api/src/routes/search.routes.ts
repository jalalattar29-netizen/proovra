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
  renameSavedView,
} from "../services/search/saved-search.service.js";
import {
  indexEvidence,
  indexWorkflowInstance,
} from "../services/search/evidence-indexing.service.js";
import {
  listSearchAudit,
  recordSearchAudit,
} from "../services/search/search-audit.service.js";
// Phase 16 — semantic search admin surface (backfill + status).
import { runSemanticBackfill } from "../services/search/semantic-backfill.service.js";
import { getSemanticUsageSummary } from "../services/search/semantic-budget.service.js";
import {
  isSemanticReadyAtRuntime,
  resolveEmbeddingProviderFromEnv,
} from "../services/search/embedding-provider.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";

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

  // Phase SEARCH-REMEDIATION-CI-FIX — the legacy GET /v1/search/suggest
  // that lived here (querying `prisma.evidence` + `prisma.case` by
  // ownerUserId with mimeType ILIKE and returning an untyped
  // `{type, id, title}` shape) is removed. Fastify rejects two
  // GET handlers for the same path at register-time, which crashed
  // API startup on CI. The canonical handler — lower in this file
  // under "Phase SEARCH-REMEDIATION-2 — type-ahead suggest" — is
  // what the typeahead UI calls. It:
  //   - queries the team-scoped `evidence_search_documents`
  //     projection (so it returns Evidence + Case + Report +
  //     Package + Note suggestions in one round-trip);
  //   - applies the canonical `requireSearchActor` gate so
  //     workspace + reviewer-restriction isolation is enforced;
  //   - returns the `{ id, documentType, sourceId, title, ... }`
  //     shape the frontend expects.
  // The legacy handler's audit + analytics emissions were ported
  // into the canonical handler below.

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
        // Phase 15 — semantic / hybrid mode selector. Defaults to KEYWORD
        // (preserves Phase 14 behavior). The shared Zod schema rejects
        // any value outside the SEARCH_MODES enum, so we forward as-is.
        mode:
          typeof raw.mode === "string"
            ? (raw.mode as string).toUpperCase()
            : undefined,
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
        // Phase 15 — additive response fields. Backward-compatible:
        // existing Phase 14 clients ignore these keys silently.
        modeUsed: result.modeUsed,
        semanticAvailable: result.semanticAvailable,
        fallbackReason: result.fallbackReason,
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
  // Phase SEARCH-REMEDIATION-3 — PATCH /v1/search/saved-views/:id
  // Body: { teamId, name }. Renames the view if the caller is the
  // creator. Anti-enumeration: returns 404 for any mismatch
  // (wrong team, wrong creator, missing row, invalid name).
  // -------------------------------------------------------------------------
  app.patch(
    "/v1/search/saved-views/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().min(1).max(120),
        })
        .parse(req.body ?? {});
      const actor = await requireSearchActor(req, reply, body.teamId);
      if (!actor) return;
      const updated = await renameSavedView({
        id,
        teamId: body.teamId,
        actorUserId: actor.userId,
        name: body.name,
      });
      if (!updated) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ view: updated });
    },
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

  // -------------------------------------------------------------------------
  // Phase 16 — Semantic search admin surface.
  //
  //   POST /v1/search/semantic/backfill  (platform admin)
  //   GET  /v1/search/semantic/status    (workspace-scoped)
  //
  // The route layer ONLY trims + validates the input. The actual
  // backfill loop, budget gate, and provider call live in the
  // services/search/semantic-* modules so the route stays thin.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/search/semantic/backfill",
    { preHandler: [requirePlatformAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          workspaceId: z.string().uuid(),
          batchSize: z.coerce.number().int().min(1).max(200).optional(),
          maxBatches: z.coerce.number().int().min(1).max(1000).optional(),
          cursorChunkId: z.string().uuid().nullable().optional(),
          dryRun: z.coerce.boolean().optional(),
        })
        .parse((req.body ?? {}) as Record<string, unknown>);
      const result = await runSemanticBackfill({
        workspaceId: body.workspaceId,
        batchSize: body.batchSize,
        maxBatches: body.maxBatches,
        cursorChunkId: body.cursorChunkId ?? null,
        dryRun: body.dryRun ?? false,
      });
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/v1/search/semantic/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const actor = await requireSearchActor(req, reply, q.teamId);
      if (!actor) return;
      const enabled = isSemanticReadyAtRuntime();
      const provider = resolveEmbeddingProviderFromEnv();
      const usage = await getSemanticUsageSummary(prisma, q.teamId);
      return reply.code(200).send({
        enabled,
        providerName: provider.name,
        modelUsed: provider.model,
        dimensions: provider.dimensions,
        semanticAvailable: enabled && provider.name !== "disabled",
        fallbackReason:
          enabled && provider.name === "disabled" ? "PROVIDER_UNAVAILABLE" : null,
        usage,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase SEARCH-REMEDIATION — type-ahead suggest endpoint.
  // GET /v1/search/suggest?teamId=...&q=v1 → top-10 title prefixes.
  // Returns the same row shape as /v1/search (so the UI can render
  // suggestions identically to a normal result), but with a cap on
  // payload size and only one column read (title). No relevance
  // ranking — just `title ILIKE :q || '%' OR title ILIKE '%' || :q
  // || '%'` ordered by recency.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/search/suggest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          q: z.string().min(1).max(80),
          limit: z.coerce.number().int().min(1).max(20).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireSearchActor(req, reply, q.teamId);
      if (!actor) return;
      const limit = q.limit ?? 10;
      try {
        // Anchor on prefix match first (preferred), then substring.
        // One query with OR — Prisma adds both clauses and Postgres
        // dedupes via the unique id.
        const rows = await prisma.evidenceSearchDocument.findMany({
          where: {
            teamId: q.teamId,
            // Non-reviewer actors never see reviewer-restricted rows.
            ...(actor.isReviewerCapable ? {} : { reviewerRestricted: false }),
            OR: [
              { title: { contains: q.q, mode: "insensitive" } },
              { searchableText: { contains: q.q, mode: "insensitive" } },
            ],
          },
          select: {
            id: true,
            documentType: true,
            sourceId: true,
            title: true,
            subtitle: true,
            evidenceId: true,
            caseId: true,
            sourceUpdatedAtUtc: true,
          },
          orderBy: [{ sourceUpdatedAtUtc: "desc" }],
          take: limit,
        });
        // Phase SEARCH-REMEDIATION-CI-FIX — preserve the legacy
        // audit + analytics emissions (ported from the removed
        // duplicate handler). Both helpers are fire-and-forget; a
        // failure inside them never blocks the suggest response.
        auditSearchAction(req, {
          userId: actor.userId,
          action: "search.suggest",
          outcome: "success",
          metadata: {
            qLength: q.q.length,
            teamId: q.teamId,
            suggestionCount: rows.length,
          },
        });
        fireSearchAnalytics({
          eventType: "search_suggestions_requested",
          userId: actor.userId,
          req,
          metadata: {
            qLength: q.q.length,
            suggestionCount: rows.length,
          },
        });
        return reply.code(200).send({
          suggestions: rows.map((r) => ({
            id: r.id,
            documentType: r.documentType,
            sourceId: r.sourceId,
            title: r.title,
            subtitle: r.subtitle,
            evidenceId: r.evidenceId,
            caseId: r.caseId,
            updatedAt: r.sourceUpdatedAtUtc.toISOString(),
          })),
        });
      } catch (err) {
        auditSearchAction(req, {
          userId: actor.userId,
          action: "search.suggest",
          outcome: "failure",
          severity: "warning",
          metadata: {
            reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
          },
        });
        // Fail soft: the typeahead UI handles an empty list as
        // "no suggestions". Returning 200 keeps the user able to
        // submit the underlying query.
        return reply.code(200).send({ suggestions: [] });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Phase SEARCH-REMEDIATION — reconciliation endpoint.
  // POST /v1/search/reconcile { teamId } — finds non-deleted evidence
  // and non-deleted cases in this team that have no matching
  // evidence_search_documents row and re-indexes them. Returns
  // {indexed, skipped, failed} counts. The endpoint is safe to call
  // repeatedly (the indexer upserts by (teamId, documentType,
  // sourceId)) and is the manual surface that powers the periodic
  // sweeper from the worker side.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/search/reconcile",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          // Hard ceiling: never process more than 1k rows per
          // request; large workspaces can call repeatedly.
          batch: z.coerce.number().int().min(1).max(1000).optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireSearchActor(req, reply, body.teamId);
      if (!actor) return;
      const limit = body.batch ?? 500;

      const { indexEvidence } = await import(
        "../services/search/evidence-indexing.service.js"
      );
      const { indexCase } = await import(
        "../services/search/case-indexing.service.js"
      );
      // Phase SEARCH-REMEDIATION-2 — extend reconcile to cover the
      // remaining workspace entities: reports, packages, and notes.
      const { indexReport, indexPackage, indexNote } = await import(
        "../services/search/artifact-indexing.service.js"
      );

      // Find orphaned evidence — non-deleted, has teamId, no doc.
      const orphanEvidence = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT e.id::text AS id
         FROM evidence e
         LEFT JOIN evidence_search_documents esd
           ON esd.team_id = e.team_id
          AND esd.document_type = 'EVIDENCE'
          AND esd.source_id = e.id
         WHERE e.deleted_at IS NULL
           AND e.team_id = ${body.teamId}::uuid
           AND esd.id IS NULL
         LIMIT ${limit}`;

      const orphanCases = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT c.id::text AS id
         FROM cases c
         LEFT JOIN evidence_search_documents esd
           ON esd.team_id = c.team_id
          AND esd.document_type = 'CASE'
          AND esd.source_id = c.id
         WHERE c.team_id = ${body.teamId}::uuid
           AND esd.id IS NULL
         LIMIT ${limit}`;

      const orphanReports = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT r.id::text AS id
         FROM reports r
         JOIN evidence e ON e.id = r.evidence_id
         LEFT JOIN evidence_search_documents esd
           ON esd.team_id = e.team_id
          AND esd.document_type = 'REPORT'
          AND esd.source_id = r.id
         WHERE e.deleted_at IS NULL
           AND e.team_id = ${body.teamId}::uuid
           AND esd.id IS NULL
         LIMIT ${limit}`;

      const orphanPackages = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT p.id::text AS id
         FROM verification_packages p
         JOIN evidence e ON e.id = p.evidence_id
         LEFT JOIN evidence_search_documents esd
           ON esd.team_id = e.team_id
          AND esd.document_type = 'PACKAGE'
          AND esd.source_id = p.id
         WHERE e.deleted_at IS NULL
           AND e.team_id = ${body.teamId}::uuid
           AND esd.id IS NULL
         LIMIT ${limit}`;

      const orphanNotes = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT cc.id::text AS id
         FROM case_comments cc
         LEFT JOIN evidence_search_documents esd
           ON esd.team_id = cc.team_id
          AND esd.document_type = 'NOTE'
          AND esd.source_id = cc.id
         WHERE cc.team_id = ${body.teamId}::uuid
           AND esd.id IS NULL
         LIMIT ${limit}`;

      let evidenceIndexed = 0;
      let evidenceFailed = 0;
      for (const row of orphanEvidence) {
        const r = await indexEvidence({ teamId: body.teamId, evidenceId: row.id });
        if (r.ok) evidenceIndexed += 1;
        else evidenceFailed += 1;
      }
      let caseIndexed = 0;
      let caseFailed = 0;
      for (const row of orphanCases) {
        const r = await indexCase({ teamId: body.teamId, caseId: row.id });
        if (r.ok) caseIndexed += 1;
        else caseFailed += 1;
      }
      let reportIndexed = 0;
      let reportFailed = 0;
      for (const row of orphanReports) {
        const r = await indexReport({ reportId: row.id });
        if (r.ok) reportIndexed += 1;
        else reportFailed += 1;
      }
      let packageIndexed = 0;
      let packageFailed = 0;
      for (const row of orphanPackages) {
        const r = await indexPackage({ packageId: row.id });
        if (r.ok) packageIndexed += 1;
        else packageFailed += 1;
      }
      let noteIndexed = 0;
      let noteFailed = 0;
      for (const row of orphanNotes) {
        const r = await indexNote({ noteId: row.id });
        if (r.ok) noteIndexed += 1;
        else noteFailed += 1;
      }

      return reply.code(200).send({
        teamId: body.teamId,
        evidence: {
          orphans: orphanEvidence.length,
          indexed: evidenceIndexed,
          failed: evidenceFailed,
        },
        cases: {
          orphans: orphanCases.length,
          indexed: caseIndexed,
          failed: caseFailed,
        },
        reports: {
          orphans: orphanReports.length,
          indexed: reportIndexed,
          failed: reportFailed,
        },
        packages: {
          orphans: orphanPackages.length,
          indexed: packageIndexed,
          failed: packageFailed,
        },
        notes: {
          orphans: orphanNotes.length,
          indexed: noteIndexed,
          failed: noteFailed,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Search-runtime-diagnostics — answers "why does the UI show 0 results?"
  //
  // Returns the workspace-scoped, in-prod-safe view of search health so
  // the UI can render explicit empty-state copy instead of an ambiguous
  // "0 results" when the real cause is one of:
  //   - API reachable but index empty / partial
  //   - DB pointed at a different server than expected
  //   - Active workspace ≠ workspace that owns the records
  //
  // Auth: requireSearchActor (same gate as /v1/search). Does NOT expose
  // any field that wasn't already derivable from the search endpoint, so
  // safe to ship to all tiers — including prod.
  //
  // Optional `?q=` runs the same Prisma OR over title/subtitle/summary/
  // searchableText as executeSearch and returns the matched count only
  // (no rows) — so the user can sanity-check "does q=X match anything
  // in THIS workspace right now" without authenticating Prisma against
  // an external DB.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/search/diagnostics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = z
        .object({
          teamId: z.string().uuid(),
          q: z.string().min(1).max(200).optional(),
        })
        .safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: parsed.error.flatten() },
        });
      }
      const { teamId, q } = parsed.data;
      const actor = await requireSearchActor(req, reply, teamId);
      if (!actor) return;

      const [team, evidenceTotal, indexedByTypeRaw, dbServer] = await Promise.all([
        prisma.team.findUnique({
          where: { id: teamId },
          select: { id: true, name: true, isPersonal: true },
        }),
        prisma.evidence.count({
          where: { teamId, deletedAt: null },
        }),
        prisma.$queryRaw<Array<{ document_type: string; n: bigint }>>`
          SELECT document_type, COUNT(*)::bigint AS n
            FROM evidence_search_documents
           WHERE team_id = ${teamId}::uuid
           GROUP BY document_type`,
        prisma.$queryRaw<Array<{ server_ip: string | null; server_port: number | null; db: string }>>`
          SELECT inet_server_addr()::text AS server_ip,
                 inet_server_port() AS server_port,
                 current_database() AS db`,
      ]);

      const indexedByType: Record<string, number> = {};
      let indexedTotal = 0;
      for (const row of indexedByTypeRaw) {
        const n = Number(row.n);
        indexedByType[row.document_type] = n;
        indexedTotal += n;
      }
      const indexedEvidence = indexedByType.EVIDENCE ?? 0;

      // Sample query probe — same OR shape as executeSearch. Honors
      // reviewer-restriction gate so the count matches what the user
      // would actually see in search results.
      let queryProbe: {
        q: string;
        matchedTotal: number;
        matchedByType: Record<string, number>;
      } | null = null;
      if (q && q.trim().length > 0) {
        const probeWhere: prismaPkg.Prisma.EvidenceSearchDocumentWhereInput = {
          teamId,
          ...(actor.isReviewerCapable ? {} : { reviewerRestricted: false }),
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { subtitle: { contains: q, mode: "insensitive" } },
            { summary: { contains: q, mode: "insensitive" } },
            { searchableText: { contains: q, mode: "insensitive" } },
          ],
        };
        const matchRows = await prisma.evidenceSearchDocument.findMany({
          where: probeWhere,
          select: { documentType: true },
        });
        const matchedByType: Record<string, number> = {};
        for (const r of matchRows) {
          matchedByType[r.documentType] =
            (matchedByType[r.documentType] ?? 0) + 1;
        }
        queryProbe = {
          q,
          matchedTotal: matchRows.length,
          matchedByType,
        };
      }

      // Health classification — the single signal the frontend uses
      // to pick which empty-state copy to render.
      //   "healthy"        — every EVIDENCE row is indexed AND the
      //                      index has at least one row.
      //   "partial_index"  — index has at least one row for the
      //                      workspace but evidenceIndexed <
      //                      evidenceTotal. Covers both "backfill
      //                      running" AND "reports/packages indexed
      //                      but evidence-specific indexer broken"
      //                      — both are partial coverage from the
      //                      Personal/SMB user's perspective.
      //   "empty_index"    — workspace has source records but the
      //                      ENTIRE index is empty across all
      //                      document types (lifecycle hook never
      //                      ran / backfill not started). Previously
      //                      this branch fired on
      //                      `indexedEvidence === 0` even when
      //                      reports/packages WERE indexed, causing
      //                      the chip to read "Search index
      //                      preparing (0/N)" while the result list
      //                      visibly showed REPORT rows. The fix
      //                      requires the WHOLE index to be empty.
      //   "empty_workspace"— workspace has no source evidence rows.
      const health: "healthy" | "partial_index" | "empty_index" | "empty_workspace" =
        evidenceTotal === 0
          ? "empty_workspace"
          : indexedTotal === 0
            ? "empty_index"
            : indexedEvidence < evidenceTotal
              ? "partial_index"
              : "healthy";

      const server = dbServer[0] ?? null;

      return reply.code(200).send({
        workspace: {
          id: teamId,
          name: team?.name ?? null,
          isPersonal: team?.isPersonal ?? null,
        },
        evidence: { total: evidenceTotal },
        index: {
          total: indexedTotal,
          byType: indexedByType,
          evidenceIndexed: indexedEvidence,
          evidenceTotal,
          coverage:
            evidenceTotal === 0
              ? null
              : Math.round((indexedEvidence / evidenceTotal) * 1000) / 10,
        },
        health,
        queryProbe,
        runtime: {
          dbServerIp: server?.server_ip ?? null,
          dbServerPort: server?.server_port ?? null,
          dbName: server?.db ?? null,
          nodeEnv: process.env.NODE_ENV ?? null,
        },
      });
    },
  );

  // Reference SEARCH_DOCUMENT_TYPES / SEARCH_SORT_MODES to keep them
  // surfaced for OpenAPI tooling (avoids unused-import lint noise).
  void SEARCH_DOCUMENT_TYPES;
  void SEARCH_SORT_MODES;
}