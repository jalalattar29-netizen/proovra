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
  listEvidenceEntities,
  projectEvidenceEntity,
} from "../services/intelligence/entity-extraction.service.js";
import {
  listSimilaritiesForEvidence,
  projectSimilarity,
  reconcileSimilaritiesForEvidence,
} from "../services/intelligence/similarity.service.js";
import { searchEvidence } from "../services/intelligence/search.service.js";
import {
  isSemanticSearchEnabled,
  searchSemantic,
} from "../services/intelligence/semantic.service.js";
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

      const [keywordHits, semantic] = await Promise.all([
        searchEvidence({
          teamId: query.teamId,
          q: query.q,
          scope: query.scope,
          limit: query.limit,
        }),
        query.semantic === "true"
          ? searchSemantic({
              teamId: query.teamId,
              q: query.q,
              limit: query.limit,
            })
          : Promise.resolve({ enabled: isSemanticSearchEnabled(), hits: [] }),
      ]);
      return reply.code(200).send({
        keyword: keywordHits,
        semantic,
        scope: query.scope ?? "publishable",
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
  // Catalogs (operator UI loads these to render filter menus). Cheap +
  // cacheable.
  // ---------------------------------------------------------------------------

  app.get("/v1/intelligence/catalogs", async (_req, reply) => {
    return reply.code(200).send({
      jobKinds: INTELLIGENCE_JOB_KINDS,
      jobStatuses: INTELLIGENCE_JOB_STATUSES,
      extractedTextKinds: EXTRACTED_TEXT_KINDS,
      entityKinds: EVIDENCE_ENTITY_KINDS,
      similarityKinds: EVIDENCE_SIMILARITY_KINDS,
      aiAssistanceKinds: AI_ASSISTANCE_KINDS,
      disclaimer: AI_ADVISORY_DISCLAIMER,
    });
  });
}
