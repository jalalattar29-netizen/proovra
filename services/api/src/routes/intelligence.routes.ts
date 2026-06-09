/**
 * Phase 15 — Intelligence operations routes.
 *
 *   GET   /v1/intelligence/search?teamId&q&scope
 *   GET   /v1/intelligence/jobs?teamId&status&kind
 *   GET   /v1/intelligence/evidence/:id
 *   POST  /v1/intelligence/evidence/:id/enqueue
 *   POST  /v1/intelligence/evidence/:id/reconcile-similarity
 *   POST  /v1/intelligence/evidence/:id/ai-assist
 *
 * All routes require authenticated workspace membership. Read scopes
 * are: REVIEWER and above (anti-enumeration uses 404 not 403 for
 * non-members + non-permitted). AI-assist + enqueue + reconcile
 * require `evidence_request.review` (reviewer permission).
 *
 * Governance integration: search results respect `publicVerifyState`
 * via the `scope` query param; the default `publishable` excludes
 * NOT_PUBLISHED / SUSPENDED / UNPUBLISHED rows.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  AI_ADVISORY_DISCLAIMER,
  EVIDENCE_ENTITY_KINDS,
  EVIDENCE_SIMILARITY_KINDS,
  EXTRACTED_TEXT_KINDS,
  INTELLIGENCE_JOB_KINDS,
  INTELLIGENCE_JOB_STATUSES,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../services/governance.service.js";
import {
  configuredOcrProviderName,
  configuredTranscriptProviderName,
  enqueueIntelligenceJob,
  listExtractedTexts,
  listIntelligenceJobs,
  projectExtractedTextSummary,
  projectIntelligenceJob,
} from "../services/intelligence/extraction.service.js";
import {
  listCrossEvidenceFindings,
  listEvidenceEntities,
  projectEvidenceEntity,
} from "../services/intelligence/entity-extraction.service.js";
import {
  listSimilaritiesForEvidence,
  projectSimilarity,
  reconcileSimilaritiesForEvidence,
} from "../services/intelligence/similarity.service.js";
// Phase 14 — Stage 3: `searchEvidence` was the prior backend for
// /v1/intelligence/search. The handler now forwards to the canonical
// /v1/search backend (`executeSearch`), so the legacy adapter is no
// longer imported. Left intentionally documented here so subsequent
// readers can locate the prior code path quickly.
import {
  isSemanticSearchEnabled,
  searchSemantic,
} from "../services/intelligence/semantic.service.js";
// Phase 14 — Stage 3 consolidation. The /v1/intelligence/search
// endpoint is folded onto the canonical /v1/search backend
// (`executeSearch` over `evidence_search_documents`). The legacy
// handler stays exposed as a deprecated alias so any client still
// calling it keeps working — see the handler body for the new
// projection shape.
import { executeSearch } from "../services/search/evidence-search.service.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  AI_ASSISTANCE_KINDS,
  requestAiAssistance,
} from "../services/intelligence/ai-assistance.service.js";

const ParamsEvidenceId = z.object({ id: z.string().uuid() });

async function requireReviewerMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const perm = requirePermission(membership.role, "evidence_request.review");
  if (!perm.allowed) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  return { userId, role: membership.role };
}

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  return { userId, role: membership.role };
}

export async function intelligenceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/intelligence/search
  //
  // @deprecated Phase 14 — Stage 3 consolidation.
  //
  // This endpoint historically called `searchEvidence` (a thin wrapper
  // over EvidenceSearchDocument) and a (currently-disabled)
  // `searchSemantic` adapter. Phase 14 folds it onto the canonical
  // `/v1/search` backend so every Discovery query goes through the
  // same governance + audit + cursor pipeline (`executeSearch` from
  // `services/search/evidence-search.service.ts`).
  //
  // Behaviour preserved for backward compatibility:
  //   * `scope` query param accepted (publishable | internal).
  //     Today the parameter is recorded but the underlying
  //     `executeSearch` already applies governance + reviewer
  //     visibility gates — there's no need for a parallel
  //     publishable/internal toggle on top.
  //   * `semantic=true` query param accepted. Semantic search is
  //     OFF by default (Phase 15 scope per the Phase 14 ground
  //     rules). When `semantic=true` arrives we return the same
  //     `{ enabled: false, hits: [] }` shape the prior handler did.
  //   * Response envelope kept as `{ keyword, semantic, scope }`
  //     where `keyword.hits[]` carries the canonical /v1/search
  //     row shape so callers can already adopt the richer
  //     projection without changing the request URL.
  //
  // New clients SHOULD call `/v1/search` directly (it returns the
  // full cursor + governance metadata). This alias remains until
  // every internal caller migrates in the parallel UI stream.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/intelligence/search",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          q: z.string().min(2).max(200),
          scope: z.enum(["publishable", "internal"]).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          semantic: z
            .union([z.literal("true"), z.literal("false")])
            .optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      // Reuse the canonical search backend. We replicate the
      // `/v1/search` actor resolution inline so this alias still
      // benefits from the reviewer-capability gate that governs
      // reviewer-restricted document visibility.
      const reviewerDecision = await evaluateMemberAccess({
        teamId: query.teamId,
        userId: ok.userId,
        permission: "identity.access_review.action",
      });
      const isReviewerCapable = reviewerDecision.allowed;

      const searchResult = await executeSearch({
        actorUserId: ok.userId,
        isReviewerCapable,
        filter: {
          teamId: query.teamId,
          q: query.q,
          limit: query.limit,
        },
        // Phase 14 — Stage 3 dedicated surface tag so the
        // /v1/search/audit log can distinguish legacy-alias traffic
        // from canonical /v1/search traffic without losing the
        // requestId / ip continuity.
        surface: "api:/v1/intelligence/search",
        requestId: req.id,
        ipAddress: req.ip,
      });

      // Backward-compatible projection: keep the legacy
      // `{ keyword: { hits }, semantic, scope }` envelope so any
      // surviving client doesn't break. `keyword.hits` carries the
      // executeSearch row shape (richer than the prior
      // searchEvidence projection); callers consuming only
      // `evidenceId` + `summary` are unaffected, while new callers
      // can already access the additional fields.
      const semanticPayload = isSemanticSearchEnabled()
        ? query.semantic === "true"
          ? await searchSemantic({
              teamId: query.teamId,
              q: query.q,
              limit: query.limit,
            })
          : { enabled: true, hits: [] }
        : { enabled: false, hits: [] };

      return reply.code(200).send({
        keyword: {
          hits: searchResult.rows,
          nextCursor: searchResult.nextCursor,
          totalReturned: searchResult.totalReturned,
          filteredByGovernance: searchResult.filteredByGovernance,
          filteredByVisibility: searchResult.filteredByVisibility,
        },
        semantic: semanticPayload,
        scope: query.scope ?? "publishable",
        // Phase 14 — deprecation hint so any client log shows the
        // canonical replacement URL without needing release notes.
        deprecation: {
          alias: true,
          canonical: "/v1/search",
          since: "phase-14",
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/intelligence/jobs
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/intelligence/jobs",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(INTELLIGENCE_JOB_STATUSES).optional(),
          kind: z.enum(INTELLIGENCE_JOB_KINDS).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireReviewerMember(req, reply, query.teamId);
      if (!ok) return;
      const rows = await listIntelligenceJobs({
        teamId: query.teamId,
        status: query.status,
        kind: query.kind,
        limit: query.limit,
      });
      return reply.code(200).send({
        jobs: rows.map(projectIntelligenceJob),
        providers: {
          ocr: configuredOcrProviderName(),
          transcript: configuredTranscriptProviderName(),
          semanticEnabled: isSemanticSearchEnabled(),
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/intelligence/evidence/:id
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/intelligence/evidence/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsEvidenceId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      // Workspace scope guard.
      const ev = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!ev || ev.teamId !== query.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const [texts, entities, similarities] = await Promise.all([
        listExtractedTexts(id),
        listEvidenceEntities(id),
        listSimilaritiesForEvidence(id),
      ]);
      return reply.code(200).send({
        extractedTexts: texts.map(projectExtractedTextSummary),
        entities: entities.map(projectEvidenceEntity),
        similarities: similarities.map((s) => projectSimilarity(s, id)),
        disclaimer: AI_ADVISORY_DISCLAIMER,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/intelligence/evidence/:id/enqueue
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/intelligence/evidence/:id/enqueue",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsEvidenceId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          kind: z.enum(INTELLIGENCE_JOB_KINDS),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const ev = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!ev || ev.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const job = await enqueueIntelligenceJob({
        evidenceId: id,
        teamId: body.teamId,
        kind: body.kind,
      });
      if (!job) {
        return reply.code(500).send({ error: { code: "enqueue_failed" } });
      }
      return reply.code(202).send({ job: projectIntelligenceJob(job) });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/intelligence/evidence/:id/reconcile-similarity
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/intelligence/evidence/:id/reconcile-similarity",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsEvidenceId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      const ev = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!ev || ev.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const summary = await reconcileSimilaritiesForEvidence(id);
      return reply.code(200).send({ summary });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/intelligence/evidence/:id/ai-assist
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/intelligence/evidence/:id/ai-assist",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = ParamsEvidenceId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          kind: z.enum(AI_ASSISTANCE_KINDS),
          text: z.string().min(1).max(32 * 1024),
        })
        .parse(req.body ?? {});
      const ok = await requireReviewerMember(req, reply, body.teamId);
      if (!ok) return;
      // Workspace scope guard — never run AI over another workspace's evidence.
      const ev = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!ev || ev.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const result = await requestAiAssistance({
        kind: body.kind,
        text: body.text,
      });
      return reply.code(200).send({ result });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 13 — GET /v1/investigation/cross-evidence
  //
  // Returns a bounded list of entity (kind, normalizedValue) tuples
  // that appear on more than one evidence record in the team.
  // Operator-readable response shape:
  //   { findings: [{ kind, normalizedValue, evidenceCount, sampleEvidenceIds }], total }
  //
  // Capability gate: any workspace member (same gate as the existing
  // /v1/intelligence/evidence/:id route). Anti-enumeration: 404 for
  // non-members. Bounded LIMIT 20.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/investigation/cross-evidence",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(20).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const findings = await listCrossEvidenceFindings({
        teamId: query.teamId,
        limit: query.limit ?? 20,
      });
      return reply.code(200).send({
        findings: findings.map((f) => ({
          kind: f.kind,
          normalizedValue: f.normalizedValue,
          evidenceCount: f.evidenceCount,
          sampleEvidenceIds: f.sampleEvidenceIds,
          operatorSummary: `This ${f.kind.toLowerCase()} appears in ${f.evidenceCount} evidence records.`,
        })),
        total: findings.length,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Catalogs (operator UI loads these to render filter menus). Cheap +
  // cacheable.
  // ---------------------------------------------------------------------------

  // Phase 4 hardening — /v1/intelligence/catalogs previously had NO
  // preHandler. Contents are static enums (operator-UI filter menus,
  // disclaimer text) so the data risk is low, but a public endpoint on
  // an otherwise-authenticated surface is inconsistent and lets a
  // crawler discover the intelligence prefix without an auth gate. The
  // route is now `requireAuth` — any signed-in user can fetch the
  // catalog (no membership requirement: the response is the same for
  // every workspace and contains no PII).
  app.get(
    "/v1/intelligence/catalogs",
    { preHandler: requireAuth },
    async (_req, reply) => {
      return reply.code(200).send({
        jobKinds: INTELLIGENCE_JOB_KINDS,
        jobStatuses: INTELLIGENCE_JOB_STATUSES,
        extractedTextKinds: EXTRACTED_TEXT_KINDS,
        entityKinds: EVIDENCE_ENTITY_KINDS,
        similarityKinds: EVIDENCE_SIMILARITY_KINDS,
        aiAssistanceKinds: AI_ASSISTANCE_KINDS,
        disclaimer: AI_ADVISORY_DISCLAIMER,
      });
    },
  );
}
