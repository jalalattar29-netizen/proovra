/**
 * Advanced Search Routes
 * Full-text search, filtering, and pagination for evidence
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";
import { z } from "zod";

// Search index eligibility + readiness — the ONE authority. The counting
// queries below emit their eligibility clause from it so the numerator and
// the denominator can never measure different populations.
import {
  projectSearchReadiness,
  searchIndexableLifecycleSql,
} from "@proovra/shared";
// The ONE durable reconciliation-run authority. Readiness reads the run row;
// the reconcile endpoint starts runs through the same wrapper the worker's
// scheduler uses, so the two cannot work one workspace at the same time.
import {
  latestSearchRun,
  reconcileSearchIndex,
} from "@proovra/shared-runtime";

import {
  collectWorkspaceSearchHealthFacts,
  resolveWorkspaceSearchReadiness,
} from "../services/search/search-health.service.js";
import {
  SAVED_VIEW_VISIBILITIES,
  SearchFilterSchema,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_SORT_MODES,
  type SavedViewVisibility,
  type SearchFilterInput,
} from "@proovra/shared";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
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
import {
  evaluateWorkspaceAiPolicy,
  resolveWorkspaceAiPolicy,
} from "../services/ai/workspace-ai-policy.service.js";
import { getSemanticUsageSummary } from "../services/search/semantic-budget.service.js";
import {
  isSemanticReadyAtRuntime,
  resolveEmbeddingProviderFromEnv,
} from "../services/search/embedding-provider.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
// The canonical limiter. Shares its store, window semantics and test-reset
// path with every other rate-limited route, so a workspace rebuild cannot be
// throttled by a second, differently-behaved implementation.
import { enforceRateLimit } from "../services/rate-limit.js";

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
    /** The authoritative Workspace (teamId) this search ran under, when the
     * route is team-scoped and the value has already been membership-checked
     * (e.g. via `requireSearchActor`). The legacy ownerUserId-scoped search
     * endpoints have no workspace concept and pass null. */
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const outcome =
    params.outcome === "blocked"
      ? "denied"
      : params.outcome === "failure"
        ? "error"
        : "success";

  const denialReason =
    outcome !== "success"
      ? (typeof params.metadata?.reason === "string" ? params.metadata.reason : params.action)
      : null;

  void emitTenantAudit({
    action: params.action,
    outcome,
    denialReason,
    sourceApp: "API",
    actorUserId: params.userId,
    workspaceId: params.workspaceId ?? null,
    resourceType: params.resourceType ?? "search",
    resourceId: params.resourceId ?? null,
    correlationId: req.id ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
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
  // PHASE 12B (Evidence Operations, 2026-07-29) — the owner-scoped
  // GET /v1/search/evidence and GET /v1/search/cases primitives were
  // DELETED. They were a SECOND public search authority over the same
  // Evidence / Case data as the canonical unified GET /v1/search, and
  // strictly weaker: they scoped by `ownerUserId` alone (no workspace
  // anchoring, no ACTIVE-membership re-check, no reviewer-restriction
  // gate, no governance/visibility fail-closed filtering) and matched
  // only `id`/`mimeType` (evidence) or `name` (case).
  //
  // Parity was CLOSED before deletion, not assumed:
  //   * caseId scoping        → `caseId` filter on SearchFilterSchema,
  //                             applied against the indexed
  //                             evidence_search_documents.case_id column.
  //   * evidence type filter  → `evidenceTypes` is now actually APPLIED
  //                             by executeSearch (it was previously
  //                             accepted and silently ignored).
  //   * date range            → updatedSinceUtc / updatedUntilUtc.
  //   * owner scoping         → contributorScoped, which is the
  //                             workspace-safe equivalent.
  //   * pagination + sort     → cursor + SEARCH_SORT_MODES.
  // The canonical authority is GET /v1/search below, consumed by
  // apps/web/app/(app)/search/page.tsx.


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
        // PHASE 12B — case scoping absorbed from the deleted
        // GET /v1/search/evidence primitive.
        caseId: typeof raw.caseId === "string" ? raw.caseId : undefined,
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
      // Phase A2 — workspace AI policy gate. A workspace that has disabled
      // semantic search must not have embeddings computed/sent, even when a
      // platform admin triggers a backfill for it.
      const semPolicy = await evaluateWorkspaceAiPolicy({
        teamId: body.workspaceId,
        feature: "SEMANTIC_SEARCH",
        dataClass: "DERIVED_CONTENT",
      });
      if (!semPolicy.allowed) {
        return reply.code(403).send({
          code: "AI_WORKSPACE_POLICY_DENIED",
          message: semPolicy.reason,
          decision: semPolicy.decision,
        });
      }
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
          workspaceId: q.teamId,
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
          workspaceId: q.teamId,
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
      const parsed = z
        .object({
          teamId: z.string().uuid(),
          // Hard ceiling: never process more than 1k rows per
          // request; large workspaces can call repeatedly.
          batch: z.coerce.number().int().min(1).max(1000).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: parsed.error.flatten() },
        });
      }
      const body = parsed.data;
      // OPERATOR gate, not the actor gate.
      //
      // This endpoint rebuilds a whole workspace's index. It previously ran
      // `requireSearchActor` (identity.member.read), so ANY member could
      // trigger it — while the UI hid the control behind `canRecover`, which
      // is projected from `isReviewerCapable`. A control hidden in the client
      // and open on the wire is not authorized; it is merely inconvenient to
      // find. The two now resolve through the same capability.
      //
      // `requireSearchOperator` also answers 404 for a non-member before it
      // answers 403 for an unauthorized one, so the endpoint cannot be used to
      // discover which workspace ids exist.
      const operator = await requireSearchOperator(req, reply, body.teamId);
      if (!operator) return;
      const limit = body.batch ?? 500;

      // ABUSE PROTECTION, after authorization and before any tenant work.
      //
      // A full workspace rebuild is the most expensive thing this service
      // will do on request. The limiter is keyed by (workspace, actor) rather
      // than by actor alone: one operator holding two workspaces must not have
      // one of them starve the other, and one workspace must not be rebuildable
      // in a loop by rotating operators. The canonical helper is used so this
      // shares the store, the window semantics and the test reset path with
      // every other limited route.
      const rate = await enforceRateLimit({
        key: `ratelimit:search:reconcile:${body.teamId}:${operator.userId}`,
        max: 6,
        windowSec: 60,
      });
      if (!rate.allowed) {
        // No lock key, no run id, no counts — a refusal reveals nothing about
        // the workspace beyond the fact that this actor asked too often.
        return reply.code(429).send({
          error: { code: "rate_limited", retryAfterMs: Math.max(0, rate.resetAtMs - Date.now()) },
        });
      }

      // EVERY production caller of Search reconciliation resolves through
      // `reconcileSearchIndex`, which claims the same per-workspace slot in
      // `governance_reconciliation_runs` that the worker's scheduler and the
      // CLI claim. Before this, the endpoint executed the scan/index loops
      // directly, so a cron tick landing mid-request worked the same workspace
      // at the same time and neither knew about the other.
      //
      // Contention is ACCEPTED, not an error: the work is already in hand.
      let detail: Record<string, unknown> | null = null;
      const outcome = await reconcileSearchIndex(prisma, {
        teamId: body.teamId,
        trigger: "api",
        triggeredByUserId: operator.userId,
        log: {
          info: (o, m) => req.log.info(o as object, m ?? ""),
          warn: (o, m) => req.log.warn(o as object, m ?? ""),
          error: (o, m) => req.log.error(o as object, m ?? ""),
        },
        body: async () => {
          /*
           * ONE REINDEX, NOT TWO.
           *
           * This endpoint used to carry its own copy of the orphan queries
           * and its own indexing loops — a second implementation of the job
           * `reindex.service.ts` already does. They drifted, as duplicated
           * work does: when the reindex learned to refresh documents written
           * by an older build of the projection, this route did not, so the
           * one entry point an operator actually reaches kept reporting
           * "0 orphans, complete" over an index full of stale documents.
           *
           * The lock is still taken HERE, because this route needs the run
           * row to answer 202 while another run is under way. So it calls the
           * body directly rather than the locked entry point, which would
           * deadlock against the slot this request is already holding.
           */
          const { runWorkspaceReindexBodyUnderLock } = await import(
            "../services/search/reindex.service.js"
          );
          const result = await runWorkspaceReindexBodyUnderLock({
            teamId: body.teamId,
            includeCases: true,
            log: {
              info: (o, m) => req.log.info(o as object, m ?? ""),
              warn: (o, m) => req.log.warn(o as object, m ?? ""),
              error: (o, m) => req.log.error(o as object, m ?? ""),
            },
          });

          detail = {
            teamId: body.teamId,
            evidence: result.evidence,
            cases: result.cases,
            reports: result.reports,
            packages: result.packages,
            notes: result.notes,
          };

          const buckets = [
            result.evidence,
            result.cases,
            result.reports,
            result.packages,
            result.notes,
          ];
          const sum = (pick: (b: (typeof buckets)[number]) => number) =>
            buckets.reduce((n, b) => n + pick(b), 0);

          return {
            // "Scanned" is every document this run had to touch: the records
            // with no document AND the documents an older projection wrote.
            scanned: sum((b) => b.orphans) + sum((b) => b.stale),
            indexed: sum((b) => b.indexed),
            // The endpoint reconciles missing and stale documents; removing
            // ineligible ones is the worker sweep's responsibility.
            removed: 0,
            failed: sum((b) => b.failed),
          };
        },
      });

      if (outcome.kind === "already_running") {
        // 202 ACCEPTED — the request was taken and a run is under way. A 200
        // with counts would claim a rebuild this request did not perform, and
        // an error would claim nothing is happening when something is.
        //
        // The EXISTING run's state is reported, not this request's: a duplicate
        // click, a cron tick landing mid-request and a second operator all get
        // the same truthful answer about the same run. Only the safe
        // projection — status and start time. No run id, no lock key, no
        // trigger user: the first two are internal, the third is another
        // person's action.
        const active = await latestSearchRun(prisma, body.teamId);
        return reply.code(202).send({
          teamId: body.teamId,
          accepted: true,
          status: active?.status ?? "RUNNING",
          runStartedAtUtc: active?.startedAtUtc ?? null,
          alreadyRunning: true,
        });
      }
      if (outcome.kind === "failed") {
        // A bounded category. Never a stack, never SQL, never a lock key, and
        // never a row id — `safeFailureCategory` reduces whatever was thrown to
        // one of a small closed set, so a Postgres error string cannot reach a
        // browser through this path.
        return reply.code(500).send({
          error: { code: "reconcile_failed", reason: outcome.reason },
        });
      }

      // 200 only here: this request held the slot and its body ran to
      // completion. A completed run that found nothing to do is still a
      // completed run, and reports zero counts rather than pretending it is
      // still working.
      return reply.code(200).send({
        ...(detail ?? { teamId: body.teamId }),
        accepted: true,
        status: "COMPLETED",
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

      // Search-runtime-diagnostics — evidence breakdown by state.
      //
      // The chip's numerator counts EVIDENCE rows in
      // `evidence_search_documents`. The indexer (search-projection)
      // EXCLUDES only lifecycle DESTROYED + PENDING_DESTRUCTION
      // rows from the index — every other state is indexable,
      // INCLUDING soft-deleted (trash) records, which surface in
      // results with an "in_trash" badge so the user can restore
      // them. Hard-deleted rows are physically absent from
      // `evidence` and so cannot be counted here at all.
      //
      // The correct denominator is `evidenceIndexable` (the
      // population the indexer is supposed to write). Per-state
      // counts break the indexable population into
      // active / archived / locked / trashed and the excluded
      // population into destroyed / pendingDestruction.
      // THE FACTS COME FROM ONE PLACE NOW.
      //
      // The eligible-population breakdown, the index counts, the removal
      // backlog, the durable run row and the queue probe used to be gathered
      // INLINE here — which is why nothing else in the product could ask
      // whether a workspace's index was healthy without either calling this
      // endpoint or inventing a proxy. `search.indexing_failure` invented one,
      // and it was a reconciliation run's exit status, which closes SUCCEEDED
      // while the index is still empty.
      //
      // They live in `search-health.service` now, and this endpoint consumes
      // them, so the page an operator reads and the condition that opens in
      // their queue cannot disagree about one workspace's index.
      const [team, healthFacts, dbServer] = await Promise.all([
        prisma.team.findUnique({
          where: { id: teamId },
          select: { id: true, name: true, isPersonal: true },
        }),
        collectWorkspaceSearchHealthFacts({ teamId }, prisma),
        prisma.$queryRaw<Array<{ server_ip: string | null; server_port: number | null; db: string }>>`
          SELECT inet_server_addr()::text AS server_ip,
                 inet_server_port() AS server_port,
                 current_database() AS db`,
      ]);
      // Unpacked from the shared facts. Every name below means exactly what it
      // meant when these lines computed it themselves; what changed is that
      // one module computes it and two callers read it.
      const {
        activeIncluded,
        archivedIncluded,
        lockedIncluded,
        trashedIncluded,
        destroyedExcluded,
        pendingDestructionExcluded,
      } = healthFacts.breakdown;
      // Indexable evidence — every row the projection writes, i.e. active +
      // archived + locked + trash. The denominator the chip and the health
      // classifier compare against.
      const evidenceIndexable = healthFacts.eligibleCount;
      // Back-compat field for older clients still reading `evidence.total`.
      // Hard-deleted rows are physically absent and cannot be counted here;
      // that count is reported as `null` below.
      const evidenceTotal = healthFacts.evidenceTotal;
      const indexedByType = healthFacts.indexedByType;
      const indexedTotal = healthFacts.indexedTotal;
      const indexedEvidence = healthFacts.indexedEvidenceCount;

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

      // Health classification — compared against `evidenceIndexable`,
      // the population the indexer is supposed to write. NOT against
      // raw `evidence.count` — that overcounts by lifecycle terminal
      // states and creates a sticky "N-2/N" reading on healthy
      // workspaces.
      //
      //   "empty_workspace"— no indexable evidence rows at all.
      //   "empty_index"    — workspace has indexable evidence but
      //                      ALL document types in the index are
      //                      empty (lifecycle hook never ran /
      //                      backfill not started).
      //   "partial_index"  — index has at least one row but
      //                      indexedEvidence < evidenceIndexable
      //                      (backfill running, OR the EVIDENCE
      //                      projection is failing while REPORT /
      //                      PACKAGE projections succeed).
      //   "healthy"        — indexedEvidence === evidenceIndexable
      //                      (every indexable evidence is in the
      //                      index).
      const health: "healthy" | "partial_index" | "empty_index" | "empty_workspace" =
        evidenceIndexable === 0
          ? "empty_workspace"
          : indexedTotal === 0
            ? "empty_index"
            : indexedEvidence < evidenceIndexable
              ? "partial_index"
              : "healthy";

      // SECONDARY CAPABILITIES this workspace has TURNED ON and which are not
      // currently answering.
      //
      // "Configured and broken" is the only thing DEGRADED may mean. A
      // workspace that never enabled semantic search is running the product it
      // chose, not a degraded one — so workspace INTENT (the persisted policy)
      // and runtime AVAILABILITY (the provider) are read separately. Asking the
      // combined policy gate instead would answer `allowed: false` for both
      // cases and make "switched off" indistinguishable from "broken".
      //
      // Deterministic search is unaffected either way, which is why this can
      // only ever qualify a converged index and never mask an unconverged one.
      const degradedCapabilities: string[] = [];
      {
        const aiPolicy = await resolveWorkspaceAiPolicy(teamId);
        if (aiPolicy.aiEnabled && aiPolicy.semanticSearchEnabled) {
          const provider = resolveEmbeddingProviderFromEnv();
          if (!isSemanticReadyAtRuntime() || provider.name === "disabled") {
            degradedCapabilities.push("semantic_search");
          }
        }
      }

      // CANONICAL READINESS — derived from persisted facts only: the eligible
      // population, what the index holds, what is awaiting removal, the
      // durable run row with its lease evaluated, and the queue's own job
      // state for the outstanding records.
      //
      // The legacy `health` field above is retained for older clients, but it
      // cannot express the distinction that matters: `partial_index` covered
      // both "a backfill is running" and "nothing has run for months", and the
      // UI could only guess, so it guessed the reassuring one.
      //
      // The FACTS were gathered once, above. The RULE lives in
      // `@proovra/shared` and is called, never reimplemented — here or in the
      // operational probe that now consumes the same module.
      //
      // Reaching this line means the actor already passed `requireSearchActor`,
      // so authorization is settled; an unauthorized actor never sees a count.
      const runSnapshot = healthFacts.run;
      const readiness = await resolveWorkspaceSearchReadiness(
        { teamId, degradedCapabilities, facts: healthFacts },
        prisma,
      );

      const server = dbServer[0] ?? null;

      return reply.code(200).send({
        workspace: {
          id: teamId,
          name: team?.name ?? null,
          isPersonal: team?.isPersonal ?? null,
        },
        // THE canonical projection, assembled by the SHARED projector rather
        // than by hand here. The console imports the same type; a field added
        // on one side and missed on the other is what makes a readiness
        // console silently fall back to inventing a state.
        readiness: projectSearchReadiness(readiness, {
          runStartedAtUtc: runSnapshot?.startedAtUtc ?? null,
          runFinishedAtUtc: runSnapshot?.finishedAtUtc ?? null,
          // Whether THIS actor may start a rebuild. Reindex is an operator
          // action and  enforces the SAME
          // capability, so a viewer is told the truth about the state without
          // being offered a control the wire would refuse.
          canRecover: actor.isReviewerCapable === true,
        }),
        // Pre-existing top-level fields — kept for client
        // back-compat. NEW callers should prefer the per-state
        // breakdown under `index.breakdown` so they don't conflate
        // "indexable evidence" with "raw evidence rows".
        evidence: { total: evidenceTotal },
        index: {
          total: indexedTotal,
          byType: indexedByType,
          evidenceIndexed: indexedEvidence,
          // CHANGED: was `evidenceTotal` (raw count). Now mirrors
          // `evidenceIndexable` so the chip's numerator/denominator
          // are drawn from the same population and "healthy" can
          // legitimately be reached.
          evidenceTotal: evidenceIndexable,
          coverage:
            evidenceIndexable === 0
              ? null
              : Math.round((indexedEvidence / evidenceIndexable) * 1000) / 10,
          // Per-state breakdown — every count is a mutually
          // exclusive partition of the workspace's `evidence`
          // table. Sum of the six fields below === evidenceTotal
          // above. `hardDeletedAbsent` is reported as `null` and
          // not summed in — the source row is physically gone,
          // there is no way to count it from the DB.
          //
          //   activeIncluded                — alive, no archive/lock/trash
          //   archivedIncluded              — alive, archivedAt set
          //   lockedIncluded                — alive, lockedAt set
          //   trashedIncluded               — soft-deleted (deletedAt set,
          //                                   restorable, INDEXED with
          //                                   "in_trash" badge)
          //   destroyedExcluded             — lifecycle DESTROYED
          //   pendingDestructionExcluded    — lifecycle PENDING_DESTRUCTION
          //   hardDeletedAbsent             — null (count not knowable;
          //                                   row physically absent)
          //
          // `evidenceIndexable` = activeIncluded + archivedIncluded
          //                    + lockedIncluded + trashedIncluded.
          breakdown: {
            evidenceIndexable,
            activeIncluded,
            archivedIncluded,
            lockedIncluded,
            trashedIncluded,
            destroyedExcluded,
            pendingDestructionExcluded,
            hardDeletedAbsent: null,
          },
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