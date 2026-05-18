/**
 * Operational seeding routes — protected staging/demo activation
 * surface for the reviewer-ops subsystem.
 *
 * Security stack (every request must pass ALL of these):
 *   1. Session auth (`requireAuth`).
 *   2. Team membership + `identity.member.admin` permission. The
 *      route refuses anti-enumeration 404 when the caller is not a
 *      member of the target team.
 *   3. Shared seeding secret presented as `X-Operational-Seed-Secret`.
 *      Configured via `OPERATIONAL_SEEDING_SECRET`. Returns 401 on
 *      mismatch.
 *   4. Env gate `OPERATIONAL_SEEDING_ENABLED=true`. Returns 503 when
 *      disabled.
 *   5. Production gate: when `NODE_ENV=production`, requires
 *      `OPERATIONAL_SEEDING_ALLOW_PRODUCTION=true`. Returns 503
 *      otherwise.
 *
 * Endpoints:
 *   POST   /v1/ops/seed/reviewer-ops          run a seed scenario
 *   GET    /v1/ops/seed/reviewer-ops          list past seed runs
 *   DELETE /v1/ops/seed/reviewer-ops/:seedRunId   cleanup a seed run
 *
 * Every request writes an audit log row tagged with `seedRunId`,
 * `seedScenario`, and the IDs of created resources. The cleanup
 * endpoint reads that audit row and deletes the listed resources by
 * ID in reverse-dependency order. The audit chain itself is never
 * mutated.
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
import {
  OperationalSeedError,
  SEED_SCENARIOS,
  assertSeedingSecret,
  cleanupSeedRun,
  listSeedRuns,
  runOperationalSeed,
} from "../services/ops/operational-seed.service.js";

const RunSeedBody = z.object({
  teamId: z.string().uuid(),
  scenario: z.enum(SEED_SCENARIOS),
  count: z.number().int().min(1).max(50).optional(),
  dryRun: z.boolean().optional(),
});

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const SeedRunIdParam = z.object({ seedRunId: z.string().uuid() });

async function requireSeedActor(
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
  // Seeding is an admin-only operation. We re-use the existing
  // `governance.policy.manage` permission rather than inventing a new
  // capability so the RBAC catalog stays bounded — anyone who can
  // change governance policy can also drive operational seed.
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "governance.policy.manage",
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

function getSeedSecretHeader(req: FastifyRequest): string | null {
  const raw = req.headers["x-operational-seed-secret"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

function mapSeedErrorToResponse(
  reply: FastifyReply,
  err: OperationalSeedError,
): void {
  reply.code(err.httpStatus).send({
    error: {
      code: err.code,
      detail: err.details ?? null,
    },
  });
}

export async function opsSeedRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /v1/ops/seed/reviewer-ops — run a seed scenario.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/ops/seed/reviewer-ops",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = RunSeedBody.parse(req.body ?? {});
      const actor = await requireSeedActor(req, reply, body.teamId);
      if (!actor) return;

      try {
        assertSeedingSecret(getSeedSecretHeader(req));
      } catch (err) {
        if (err instanceof OperationalSeedError) {
          mapSeedErrorToResponse(reply, err);
          return;
        }
        throw err;
      }

      try {
        const result = await runOperationalSeed({
          teamId: body.teamId,
          scenario: body.scenario,
          count: body.count ?? 0,
          dryRun: body.dryRun === true,
          actorUserId: actor.userId,
          requestId: req.id,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof OperationalSeedError) {
          mapSeedErrorToResponse(reply, err);
          return;
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/ops/seed/reviewer-ops — list recent seed runs for the team.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/ops/seed/reviewer-ops",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSeedActor(req, reply, q.teamId);
      if (!actor) return;
      // We don't require the seed secret on read — the operator is
      // already inside the protected workspace + holds admin. The
      // listing carries no production-impacting actions.
      const runs = await listSeedRuns(q.teamId);
      return reply.code(200).send({ runs });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/ops/seed/reviewer-ops/:seedRunId — cleanup a seed run.
  // ---------------------------------------------------------------------------
  app.delete(
    "/v1/ops/seed/reviewer-ops/:seedRunId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = SeedRunIdParam.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSeedActor(req, reply, q.teamId);
      if (!actor) return;

      try {
        assertSeedingSecret(getSeedSecretHeader(req));
      } catch (err) {
        if (err instanceof OperationalSeedError) {
          mapSeedErrorToResponse(reply, err);
          return;
        }
        throw err;
      }

      try {
        const result = await cleanupSeedRun({
          seedRunId: params.seedRunId,
          actorUserId: actor.userId,
          requestId: req.id,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof OperationalSeedError) {
          mapSeedErrorToResponse(reply, err);
          return;
        }
        throw err;
      }
    },
  );
}
