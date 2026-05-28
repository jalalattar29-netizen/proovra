/**
 * Phase O1.1 — OTEL runtime health route.
 *
 *   GET /v1/runtime/otel-health
 *
 * Returns the bounded operator-safe snapshot from `getOtelStatus()`:
 *
 *   * `enabled` / `started` / `degraded`
 *   * `serviceName` / `serviceNamespace` / `environment` / `protocol`
 *   * `endpointConfigured` (boolean — NEVER the URL)
 *   * `lastBootstrapAtUtc` / `lastBootstrapOutcome` /
 *     `lastBootstrapFailureCode`
 *   * `lastExportErrorCode`
 *   * `spansCreatedCount`
 *   * `resourceAttributes` — bounded `service.name` / `service.namespace`
 *     / `deployment.environment` only.
 *
 * Hard rules:
 *   * Auth required. Same gate as `/v1/runtime/secrets-health`
 *     (active workspace member, `identity.member.read`).
 *   * NEVER returns the OTLP endpoint URL.
 *   * NEVER returns headers / Grafana token / any Authorization
 *     material.
 *   * NEVER returns process env values.
 *   * Bounded enums on every state.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { getOtelStatus } from "../observability/otel.js";

async function requireOpsReader(
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

export async function runtimeOtelHealthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/runtime/otel-health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;
      const otel = getOtelStatus();
      return reply.code(200).send({ otel });
    },
  );
}
