/**
 * Phase P6 — Reviewer Criteria Catalog API.
 *   GET  /v1/reviewer-criteria?teamId          — list sets (member)
 *   POST /v1/reviewer-criteria                 — create DRAFT set+v1 (OWNER/ADMIN)
 *   POST /v1/reviewer-criteria/:setId/publish  — publish current draft (OWNER/ADMIN)
 *   GET  /v1/reviewer-criteria/:setId          — set + published versions (member)
 *
 * Criteria are HUMAN-authored + immutable after publish. AI never writes here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical review-criteria gate.
 * Routes through authorizeOrFail (ACTIVE membership + org lifecycle +
 * `review.queue.read` capability + fail-closed + anti-enumeration 404). Reads
 * use the returned userId; the mutation handlers additionally enforce their
 * existing OWNER/ADMIN-only restriction using the informational `role`.
 */
async function requireMember(req: FastifyRequest, reply: FastifyReply, teamId: string) {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "review.queue.read",
    antiEnumeration: true,
  });
  if (!outcome) return null;
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: outcome.actorUserId } },
    select: { role: true },
  });
  return { userId: outcome.actorUserId, role: m?.role ?? "VIEWER" };
}

const CriterionInput = z.object({
  key: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  required: z.boolean().default(false),
  order: z.number().int().min(0).max(999).default(0),
  reviewGuidance: z.string().max(600).optional(),
  escalationGuidance: z.string().max(600).optional(),
});

export async function reviewerCriteriaRoutes(app: FastifyInstance) {
  app.get("/v1/reviewer-criteria", { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
    const ok = await requireMember(req, reply, q.teamId);
    if (!ok) return;
    const sets = await prisma.reviewerCriteriaSet.findMany({
      where: { workspaceId: q.teamId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, publishedAt: true, title: true } } },
    });
    return reply.code(200).send({ sets });
  });

  app.post("/v1/reviewer-criteria", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({
      teamId: z.string().uuid(),
      name: z.string().min(1).max(160),
      description: z.string().max(600).optional(),
      title: z.string().min(1).max(160),
      instructions: z.string().max(2000).optional(),
      criteria: z.array(CriterionInput).min(1).max(50),
    }).parse(req.body ?? {});
    const ok = await requireMember(req, reply, body.teamId);
    if (!ok) return;
    if (ok.role !== "OWNER" && ok.role !== "ADMIN") {
      return reply.code(403).send({ error: { code: "permission_denied", reason: "Only owners/admins author reviewer criteria." } });
    }
    const set = await prisma.reviewerCriteriaSet.create({
      data: {
        workspaceId: body.teamId, name: body.name, description: body.description ?? null,
        status: "DRAFT", createdByUserId: ok.userId,
        versions: {
          create: {
            version: 1, title: body.title, instructions: body.instructions ?? null,
            createdByUserId: ok.userId,
            criteria: { create: body.criteria.map((c) => ({ ...c, description: c.description ?? null, reviewGuidance: c.reviewGuidance ?? null, escalationGuidance: c.escalationGuidance ?? null })) },
          },
        },
      },
      include: { versions: true },
    });
    await emitTenantAudit({
      action: "reviewer_criteria.created",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ok.userId,
      workspaceId: body.teamId,
      resourceType: "reviewer_criteria_set",
      resourceId: set.id,
      metadata: { name: body.name, criteriaCount: body.criteria.length },
    });
    return reply.code(201).send({ set });
  });

  app.post("/v1/reviewer-criteria/:setId/publish", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
    const ok = await requireMember(req, reply, body.teamId);
    if (!ok) return;
    if (ok.role !== "OWNER" && ok.role !== "ADMIN") {
      return reply.code(403).send({ error: { code: "permission_denied" } });
    }
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: setId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!set || set.workspaceId !== body.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    const latest = set.versions[0];
    if (!latest) return reply.code(400).send({ error: { code: "no_version" } });
    if (latest.publishedAt) return reply.code(409).send({ error: { code: "already_published" } });
    const published = await prisma.$transaction([
      prisma.reviewerCriteriaVersion.update({
        where: { id: latest.id },
        data: { publishedAt: new Date(), publishedByUserId: ok.userId },
      }),
      prisma.reviewerCriteriaSet.update({
        where: { id: setId },
        data: { status: "PUBLISHED", currentVersionId: latest.id },
      }),
    ]);
    await emitTenantAudit({
      action: "reviewer_criteria.published",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ok.userId,
      workspaceId: body.teamId,
      resourceType: "reviewer_criteria_set",
      resourceId: setId,
      metadata: { version: latest.version },
    });
    return reply.code(200).send({ version: published[0] });
  });

  // Phase P2-lifecycle — edit the latest DRAFT version (published = immutable).
  // Phase F-4 — OPTIMISTIC CONCURRENCY: the client sends the set's updatedAt
  // it loaded (expectedUpdatedAt); a mismatch means another admin changed the
  // set since — the edit is rejected 409 draft_conflict instead of silently
  // overwriting. Every draft save touches the set row so the token advances.
  app.patch("/v1/reviewer-criteria/:setId/draft", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const body = z.object({
      teamId: z.string().uuid(),
      title: z.string().min(1).max(160).optional(),
      instructions: z.string().max(2000).optional(),
      expectedUpdatedAt: z.string().datetime().optional(),
      criteria: z.array(CriterionInput).min(1).max(50),
    }).parse(req.body ?? {});
    const ok = await requireMember(req, reply, body.teamId);
    if (!ok) return;
    if (ok.role !== "OWNER" && ok.role !== "ADMIN") return reply.code(403).send({ error: { code: "permission_denied" } });
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: setId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!set || set.workspaceId !== body.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    const latest = set.versions[0];
    if (!latest) return reply.code(400).send({ error: { code: "no_version" } });
    if (latest.publishedAt) return reply.code(409).send({ error: { code: "published_immutable", reason: "Published versions are immutable. Duplicate as a new version instead." } });
    if (
      body.expectedUpdatedAt &&
      new Date(body.expectedUpdatedAt).getTime() !== new Date(set.updatedAt).getTime()
    ) {
      return reply.code(409).send({
        error: {
          code: "draft_conflict",
          reason: "This draft was changed by someone else since you loaded it.",
          currentUpdatedAt: set.updatedAt,
        },
      });
    }
    await prisma.$transaction([
      prisma.reviewerCriterion.deleteMany({ where: { criteriaVersionId: latest.id } }),
      prisma.reviewerCriteriaVersion.update({
        where: { id: latest.id },
        data: {
          ...(body.title ? { title: body.title } : {}),
          ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
          criteria: { create: body.criteria.map((c) => ({ ...c, description: c.description ?? null, reviewGuidance: c.reviewGuidance ?? null, escalationGuidance: c.escalationGuidance ?? null })) },
        },
      }),
      // Touch the set row so its @updatedAt advances — the concurrency token.
      prisma.reviewerCriteriaSet.update({ where: { id: setId }, data: { status: set.status } }),
    ]);
    await emitTenantAudit({
      action: "reviewer_criteria.draft_updated",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ok.userId,
      workspaceId: body.teamId,
      resourceType: "reviewer_criteria_set",
      resourceId: setId,
      metadata: { version: latest.version, criteriaCount: body.criteria.length },
    });
    return reply.code(200).send({ ok: true, version: latest.version });
  });

  // Phase F-4 — per-version usage statistics, derived from the EXISTING
  // AiCopilotRun defensibility records (no new storage): how often each
  // published version was used by the Reviewer Copilot, across how many
  // reviews and reviewers, and when last. Review-type linkage is not part
  // of the current data model and is intentionally not fabricated.
  app.get("/v1/reviewer-criteria/:setId/usage", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
    const ok = await requireMember(req, reply, q.teamId);
    if (!ok) return;
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: setId },
      include: { versions: { orderBy: { version: "desc" }, select: { version: true } } },
    });
    if (!set || set.workspaceId !== q.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    try {
      const usage = await Promise.all(
        set.versions.map(async ({ version }) => {
          const label = `${set.name} v${version}`;
          const runs = await prisma.aiCopilotRun.findMany({
            where: { workspaceId: q.teamId, criteriaVersion: label },
            select: { reviewId: true, userId: true, generatedAt: true },
            orderBy: { generatedAt: "desc" },
            take: 500,
          });
          return {
            version,
            runCount: runs.length,
            reviewCount: new Set(runs.map((r) => r.reviewId).filter(Boolean)).size,
            reviewerCount: new Set(runs.map((r) => r.userId)).size,
            lastUsedAt: runs[0]?.generatedAt ?? null,
          };
        }),
      );
      return reply.code(200).send({ usageAvailable: true, usage });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2021" || code === "P2022") {
        return reply.code(200).send({ usageAvailable: false, usage: [] });
      }
      throw err;
    }
  });

  // Phase P2-lifecycle — duplicate the latest version as a new DRAFT version.
  app.post("/v1/reviewer-criteria/:setId/duplicate", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
    const ok = await requireMember(req, reply, body.teamId);
    if (!ok) return;
    if (ok.role !== "OWNER" && ok.role !== "ADMIN") return reply.code(403).send({ error: { code: "permission_denied" } });
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: setId },
      include: { versions: { orderBy: { version: "desc" }, take: 1, include: { criteria: true } } },
    });
    if (!set || set.workspaceId !== body.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    const latest = set.versions[0];
    if (!latest) return reply.code(400).send({ error: { code: "no_version" } });
    if (!latest.publishedAt) return reply.code(409).send({ error: { code: "draft_exists", reason: "The latest version is still a draft — edit it instead." } });
    const created = await prisma.reviewerCriteriaVersion.create({
      data: {
        criteriaSetId: setId,
        version: latest.version + 1,
        title: latest.title,
        instructions: latest.instructions,
        createdByUserId: ok.userId,
        criteria: {
          create: latest.criteria.map((c) => ({
            key: c.key, title: c.title, description: c.description, required: c.required,
            order: c.order, reviewGuidance: c.reviewGuidance, escalationGuidance: c.escalationGuidance,
          })),
        },
      },
    });
    await prisma.reviewerCriteriaSet.update({ where: { id: setId }, data: { status: "DRAFT" } });
    await emitTenantAudit({
      action: "reviewer_criteria.duplicated",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ok.userId,
      workspaceId: body.teamId,
      resourceType: "reviewer_criteria_set",
      resourceId: setId,
      metadata: { newVersion: created.version },
    });
    return reply.code(201).send({ version: created.version });
  });

  // Phase P2-lifecycle — retire a set (existing reviews keep their version).
  app.post("/v1/reviewer-criteria/:setId/retire", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
    const ok = await requireMember(req, reply, body.teamId);
    if (!ok) return;
    if (ok.role !== "OWNER" && ok.role !== "ADMIN") return reply.code(403).send({ error: { code: "permission_denied" } });
    const set = await prisma.reviewerCriteriaSet.findUnique({ where: { id: setId } });
    if (!set || set.workspaceId !== body.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    await prisma.$transaction([
      prisma.reviewerCriteriaSet.update({ where: { id: setId }, data: { status: "RETIRED" } }),
      prisma.reviewerCriteriaVersion.updateMany({
        where: { criteriaSetId: setId, retiredAt: null, publishedAt: { not: null } },
        data: { retiredAt: new Date() },
      }),
    ]);
    await emitTenantAudit({
      action: "reviewer_criteria.retired",
      outcome: "success",
      sourceApp: "API",
      actorUserId: ok.userId,
      workspaceId: body.teamId,
      resourceType: "reviewer_criteria_set",
      resourceId: setId,
      metadata: {},
    });
    return reply.code(200).send({ ok: true });
  });

  app.get("/v1/reviewer-criteria/:setId", { preHandler: requireAuth }, async (req, reply) => {
    const setId = z.string().uuid().parse((req.params as { setId: string }).setId);
    const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
    const ok = await requireMember(req, reply, q.teamId);
    if (!ok) return;
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: setId },
      include: { versions: { orderBy: { version: "desc" }, include: { criteria: { orderBy: { order: "asc" } } } } },
    });
    if (!set || set.workspaceId !== q.teamId) return reply.code(404).send({ error: { code: "not_found" } });
    return reply.code(200).send({ set });
  });
}

/**
 * Phase P6 — server-side criteria resolution for the Reviewer Copilot.
 * The client supplies IDs only; the PUBLISHED version is loaded from DB.
 * Forged/unpublished/cross-tenant versions are rejected. Returns null when
 * the catalog tables are not migrated (legacy env) — caller falls back to a
 * nominal version label.
 */
export async function loadPublishedCriteria(input: {
  teamId: string;
  criteriaSetId?: string | null;
  criteriaVersionId?: string | null;
}): Promise<
  | { ok: true; setId: string; versionId: string; versionLabel: string; criteria: Array<{ key: string; title: string; required: boolean; reviewGuidance: string | null }> }
  | { ok: false; code: "NOT_FOUND" | "NOT_PUBLISHED" | "CROSS_TENANT" }
  | null
> {
  if (!input.criteriaSetId) return null;
  try {
    const set = await prisma.reviewerCriteriaSet.findUnique({
      where: { id: input.criteriaSetId },
      include: {
        versions: {
          where: input.criteriaVersionId ? { id: input.criteriaVersionId } : { publishedAt: { not: null } },
          orderBy: { version: "desc" },
          take: 1,
          include: { criteria: { orderBy: { order: "asc" } } },
        },
      },
    });
    if (!set) return { ok: false, code: "NOT_FOUND" };
    if (set.workspaceId !== input.teamId) return { ok: false, code: "CROSS_TENANT" };
    const v = set.versions[0];
    if (!v || !v.publishedAt) return { ok: false, code: "NOT_PUBLISHED" };
    return {
      ok: true,
      setId: set.id,
      versionId: v.id,
      versionLabel: `${set.name} v${v.version}`,
      criteria: v.criteria.map((c) => ({ key: c.key, title: c.title, required: c.required, reviewGuidance: c.reviewGuidance })),
    };
  } catch {
    return null; // tables not migrated
  }
}
