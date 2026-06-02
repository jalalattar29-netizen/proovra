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
  //
  // Phase O — Sentry NODE-1Q (chain_transfers.updated_at) + NODE-1J
  // (subprocessors.{category,country,description}). The repair
  // migration 20270802000000_phase_sentry_batch_schema_drift_repair
  // adds the missing columns; until it is applied everywhere, any
  // sibling probe that transitively touches a drifted table MUST
  // NOT crash the whole readiness endpoint.
  //
  // `runReadinessCheck` already wraps every per-subsystem probe in
  // a try/catch that returns a typed UNKNOWN/DEGRADED/CRITICAL
  // status — that is the per-probe degradation contract documented
  // at the top of runtime-readiness.ts ("Never throws. Every error
  // path produces a `DEGRADED` or `CRITICAL` status with an
  // operator-safe reason.").
  //
  // The OUTER wrap below is belt-and-braces: if a future probe is
  // added that forgets the per-probe catch — or if Prisma raises a
  // P2022 from a connection-level path before the per-probe code
  // runs — the endpoint still returns a bounded SCHEMA_NOT_READY
  // payload instead of a 500. The payload preserves the canonical
  // shape (status / ranAtUtc / subsystems) so consumers don't
  // crash on the degraded branch.
  // ---------------------------------------------------------------------------
  app.get(
    "/admin/runtime/readiness",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireReadinessActor(req, reply, q.teamId);
      if (!actor) return;
      bump("runtime_readiness_check_total");
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        if (report.status === "DEGRADED") bump("runtime_readiness_degraded_total");
        if (report.status === "CRITICAL") bump("runtime_readiness_critical_total");
        return reply.code(200).send(report);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          bump("runtime_readiness_degraded_total");
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            durationMs: 0,
            requestId: req.id ?? null,
            subsystems: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
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
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        const queues = report.subsystems.find((s) => s.id === "queues");
        const redis = report.subsystems.find((s) => s.id === "redis");
        return reply.code(200).send({
          status: queues?.status ?? "UNKNOWN",
          ranAtUtc: report.ranAtUtc,
          queues,
          redis,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            queues: null,
            redis: null,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
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
      try {
        const report = await runReadinessCheck(prisma, req.id ?? null);
        const workers = report.subsystems.find((s) => s.id === "workers");
        const cronSecrets = report.subsystems.find((s) => s.id === "cron_secrets");
        return reply.code(200).send({
          status: workers?.status ?? "UNKNOWN",
          ranAtUtc: report.ranAtUtc,
          workers,
          cronSecrets,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            status: "DEGRADED",
            ranAtUtc: new Date().toISOString(),
            workers: null,
            cronSecrets: null,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
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
      try {
        const report = await runMigrationDriftCheck(prisma);
        if (report.drift.length > 0) {
          bump("runtime_migration_drift_detected_total");
        }
        return reply.code(200).send(report);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            drift: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );
}
