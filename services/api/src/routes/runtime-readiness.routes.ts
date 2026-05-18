/**
 * Phase 28-F — Runtime readiness routes.
 *
 *   GET /admin/runtime/readiness  — full aggregator
 *   GET /admin/runtime/queues     — queue health subset
 *   GET /admin/runtime/workers    — worker subset
 *   GET /admin/runtime/migrations — migration drift detail
 *
 * (The existing GET /admin/runtime/schema-status from Phase 28-A
 * remains its own endpoint in ops.routes.ts.)
 *
 * All endpoints require session auth + team membership +
 * `audit.read` permission. 404 on non-member (anti-enum).
 * Read-only. Safe to poll.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { bump } from "../services/ops/metrics.service.js";
import { runReadinessCheck } from "../runtime/runtime-readiness.js";
import { runMigrationDriftCheck } from "../runtime/migration-drift.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });

async function requireReadinessActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "audit.read",
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

export async function runtimeReadinessRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /admin/runtime/readiness
  // ---------------------------------------------------------------------------
  app.get(
    "/admin/runtime/readiness",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireReadinessActor(req, reply, q.teamId);
      if (!actor) return;
      bump("runtime_readiness_check_total");
      const report = await runReadinessCheck(prisma, req.id ?? null);
      if (report.status === "DEGRADED") bump("runtime_readiness_degraded_total");
      if (report.status === "CRITICAL") bump("runtime_readiness_critical_total");
      return reply.code(200).send(report);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /admin/runtime/queues — queue subset of readiness.
  // ---------------------------------------------------------------------------
  app.get(
    "/admin/runtime/queues",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireReadinessActor(req, reply, q.teamId);
      if (!actor) return;
      bump("runtime_queue_health_check_total");
      const report = await runReadinessCheck(prisma, req.id ?? null);
      const queues = report.subsystems.find((s) => s.id === "queues");
      const redis = report.subsystems.find((s) => s.id === "redis");
      return reply.code(200).send({
        status: queues?.status ?? "UNKNOWN",
        ranAtUtc: report.ranAtUtc,
        queues,
        redis,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /admin/runtime/workers — worker subset of readiness.
  // ---------------------------------------------------------------------------
  app.get(
    "/admin/runtime/workers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireReadinessActor(req, reply, q.teamId);
      if (!actor) return;
      const report = await runReadinessCheck(prisma, req.id ?? null);
      const workers = report.subsystems.find((s) => s.id === "workers");
      const cronSecrets = report.subsystems.find((s) => s.id === "cron_secrets");
      return reply.code(200).send({
        status: workers?.status ?? "UNKNOWN",
        ranAtUtc: report.ranAtUtc,
        workers,
        cronSecrets,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /admin/runtime/migrations — migration drift detail.
  // ---------------------------------------------------------------------------
  app.get(
    "/admin/runtime/migrations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireReadinessActor(req, reply, q.teamId);
      if (!actor) return;
      const report = await runMigrationDriftCheck(prisma);
      if (report.drift.length > 0) {
        bump("runtime_migration_drift_detected_total");
      }
      return reply.code(200).send(report);
    },
  );
}
