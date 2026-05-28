/**
 * Phase M2.1 — C2PA operations routes.
 *
 *   GET  /v1/operations/c2pa                           — overview
 *   POST /v1/operations/c2pa/backfill/preview          — preview
 *   POST /v1/operations/c2pa/backfill/start            — start (step-up)
 *   GET  /v1/operations/c2pa/backfill                  — list runs
 *   GET  /v1/operations/c2pa/backfill/:id              — get one run
 *   POST /v1/operations/c2pa/backfill/:id/cancel       — cancel
 *   POST /v1/operations/c2pa/backfill/:id/tick         — drive a batch
 *   GET  /v1/operations/c2pa/generation/readiness      — bounded readiness
 *
 * Auth-gated through the same `requireOpsActor` helper used by the
 * recovery routes. Org-wide backfill start requires step-up.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import {
  BACKFILL_TARGET_FILTERS,
  cancelC2paBackfillRun,
  getC2paBackfillRun,
  listC2paBackfillRuns,
  previewC2paBackfill,
  startC2paBackfill,
  tickC2paBackfillRun,
} from "../services/c2pa/c2pa-backfill.service.js";
import { probeC2paGenerationReadiness } from "../services/c2pa/c2pa-generation-readiness.service.js";

async function requireOpsActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  return { userId };
}

function envFlags() {
  return {
    C2PA_ENABLED: process.env.C2PA_ENABLED ?? "false",
    C2PA_PROVIDER_MODE: process.env.C2PA_PROVIDER_MODE ?? "detect_only",
    C2PA_RAW_MANIFEST_EXPORT_ENABLED:
      process.env.C2PA_RAW_MANIFEST_EXPORT_ENABLED ?? "false",
  };
}

export async function operationsC2paRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/c2pa",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const env = envFlags();
      const generationReadiness = await probeC2paGenerationReadiness();
      const recentRuns = listC2paBackfillRuns(q.teamId).slice(0, 20);
      return reply.code(200).send({
        teamId: q.teamId,
        providerStatus: {
          enabled: env.C2PA_ENABLED === "true",
          mode: env.C2PA_PROVIDER_MODE,
          rawManifestExportEnabled:
            env.C2PA_RAW_MANIFEST_EXPORT_ENABLED === "true",
        },
        generationReadiness,
        backfillRuns: recentRuns,
        // Bounded standing limitations the UI must always show.
        limitations: [
          "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
          "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
          "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
          "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
          "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
        ] as const,
      });
    },
  );

  // -------------------------------------------------------------------
  // Backfill preview
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/c2pa/backfill/preview",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          filter: z.enum(BACKFILL_TARGET_FILTERS).optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const preview = await previewC2paBackfill(body, envFlags());
      return reply.code(200).send({ preview });
    },
  );

  // -------------------------------------------------------------------
  // Backfill start (step-up gated)
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/c2pa/backfill/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          filter: z.enum(BACKFILL_TARGET_FILTERS).optional(),
          maxBatchSize: z.number().int().min(1).max(500).optional(),
          force: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ctx.userId,
        purpose: "C2PA_BACKFILL_START",
        resourceKind: "c2pa_backfill",
        resourceId: "team",
      });
      if (stepUp.sent) return;
      const run = await startC2paBackfill({
        ...body,
        actorUserId: ctx.userId,
      });
      await appendPlatformAuditLog({
        userId: ctx.userId,
        action: "c2pa_backfill_started",
        category: "operations",
        severity: "info",
        source: "operations_c2pa",
        outcome: "success",
        resourceType: "c2pa_backfill_run",
        resourceId: run.id,
        metadata: {
          teamId: body.teamId,
          filter: run.filter,
          candidateCount: run.candidateCount,
        },
      }).catch(() => {});
      return reply.code(200).send({ run });
    },
  );

  // -------------------------------------------------------------------
  // List runs
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/c2pa/backfill",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const runs = listC2paBackfillRuns(q.teamId);
      return reply.code(200).send({ runs });
    },
  );

  // -------------------------------------------------------------------
  // Get one run
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/c2pa/backfill/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const run = getC2paBackfillRun(params.id);
      if (!run || run.teamId !== q.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ run });
    },
  );

  // -------------------------------------------------------------------
  // Cancel a run
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/c2pa/backfill/:id/cancel",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requireOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const existing = getC2paBackfillRun(params.id);
      if (!existing || existing.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const run = cancelC2paBackfillRun(params.id);
      if (run) {
        await appendPlatformAuditLog({
          userId: ctx.userId,
          action: "c2pa_backfill_cancelled",
          category: "operations",
          severity: "info",
          source: "operations_c2pa",
          outcome: "success",
          resourceType: "c2pa_backfill_run",
          resourceId: run.id,
          metadata: { teamId: body.teamId },
        }).catch(() => {});
      }
      return reply.code(200).send({ run });
    },
  );

  // -------------------------------------------------------------------
  // Tick — drive a bounded batch synchronously. Used by both the UI
  // (for short progress steps) and an external scheduler.
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/c2pa/backfill/:id/tick",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          maxBatchSize: z.number().int().min(1).max(500).optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const existing = getC2paBackfillRun(params.id);
      if (!existing || existing.teamId !== body.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const outcome = await tickC2paBackfillRun({
        runId: params.id,
        maxBatchSize: body.maxBatchSize,
      });
      if (outcome.run.status === "completed") {
        await appendPlatformAuditLog({
          userId: ctx.userId,
          action: "c2pa_backfill_completed",
          category: "operations",
          severity: "info",
          source: "operations_c2pa",
          outcome: "success",
          resourceType: "c2pa_backfill_run",
          resourceId: outcome.run.id,
          metadata: {
            teamId: body.teamId,
            processedCount: outcome.run.processedCount,
            failedCount: outcome.run.failedCount,
          },
        }).catch(() => {});
      }
      return reply.code(200).send(outcome);
    },
  );

  // -------------------------------------------------------------------
  // Generation readiness
  // -------------------------------------------------------------------
  app.get(
    "/v1/operations/c2pa/generation/readiness",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsActor(req, reply, q.teamId);
      if (!ctx) return;
      const readiness = await probeC2paGenerationReadiness();
      return reply.code(200).send({ readiness });
    },
  );

  // -------------------------------------------------------------------
  // Generation execute — honest "not implemented yet" until readiness
  // path is wired to a signing pipeline. We refuse explicitly so the
  // UI never thinks the button works.
  // -------------------------------------------------------------------
  app.post(
    "/v1/operations/c2pa/generate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          targetKind: z
            .enum(["derived_exports", "report_pdfs", "verification_packages"])
            .optional(),
        })
        .parse(req.body ?? {});
      const ctx = await requireOpsActor(req, reply, body.teamId);
      if (!ctx) return;
      const readiness = await probeC2paGenerationReadiness();
      if (!readiness.canAttempt) {
        return reply.code(409).send({
          error: {
            code: "generation_unavailable",
            state: readiness.state,
            reason: readiness.reason,
          },
        });
      }
      // Readiness reports `ready` but a signed-generation pipeline
      // is not yet wired in this phase. Return an honest 409 so the
      // operator UI does not falsely report success.
      return reply.code(409).send({
        error: {
          code: "generation_pipeline_not_wired",
          state: "ready",
          reason:
            "Readiness checks passed, but the C2PA generation pipeline has not been wired in this deployment. Refusing to generate.",
        },
      });
    },
  );
}
