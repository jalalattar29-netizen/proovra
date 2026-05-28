/**
 * Phase P2.0 — AWS Secrets Manager health route.
 *
 *   GET /v1/runtime/secrets-health
 *
 * Returns the operator-safe health snapshot:
 *
 *   * `awsEnabled` / `awsConnected` / `cacheLoaded` / `degraded`
 *   * `fallbackMode`: "aws_primary" | "env_only" | "env_fallback_after_failure"
 *   * `lastRefreshAtUtc` / `lastErrorCode`
 *   * `cachedKeyCount` (NEVER key names, NEVER values)
 *   * Per-migrated-secret presence audit: name + source + present.
 *     Source is one of "aws" | "env" | "missing". NO values.
 *
 * Hard rules:
 *   * Auth required. Same gate as other `/v1/ops/*` (active member,
 *     identity.member.read permission). The route refuses to surface
 *     ANY state to anonymous callers.
 *   * NO secret values returned.
 *   * NO AWS error stacks returned. The bounded `lastErrorCode`
 *     enum is the only error surface.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { getSecretsHealth } from "../config/secrets-manager.js";
import { getMigratedSecretsAudit } from "../config/runtime-secrets.js";
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

export async function runtimeSecretsHealthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/runtime/secrets-health",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ctx = await requireOpsReader(req, reply, q.teamId);
      if (!ctx) return;

      const health = getSecretsHealth();
      const audit = getMigratedSecretsAudit();
      // Phase P2.0B — include OTEL status snapshot. Operator-safe:
      // service name + namespace + environment + a boolean
      // `endpointConfigured`. The endpoint URL and headers (Grafana
      // token) are NEVER returned.
      const otel = getOtelStatus();
      return reply.code(200).send({
        health,
        migrated: audit,
        otel,
      });
    },
  );
}
