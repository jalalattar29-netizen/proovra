/**
 * Wave 1 Phase 5 — Investigation Diagnostics HTTP surface.
 *
 *   GET /v1/investigation/diagnostics?teamId=…
 *     → returns the InvestigationDiagnostics envelope (workspace
 *       counts + queue health + producer modes + last errors +
 *       warnings).
 *
 * Permission gate: `identity.member.read` (workspace admin) OR
 * `evidence.update_metadata` (reviewer admin / ops admin). Mirrors
 * `requireOpsActor` in ops.routes.ts. Anti-enumeration: non-members
 * receive 404 rather than 403 so the existence of a workspace is
 * never disclosed to an unauthenticated probe.
 *
 * Hard contracts:
 *   * Read-only — never mutates state.
 *   * NEVER projects evidence content, OCR text, transcript text,
 *     GPS, storage keys, reviewer-private notes, audit-payload
 *     metadata. Counts + bounded queue health only.
 *   * NEVER returns 5xx for sub-aggregator failure — the service
 *     aggregator itself never throws; failures collapse to 0 /
 *     null / [] + a warning string.
 *
 * Composition contract (no duplication):
 *   * Compose existing thin helpers:
 *       - Workspace counts:    Prisma `count()` per domain.
 *       - Queue inventory:     `getQueueInventory` (Phase P2.3).
 *       - Producer modes:      `resolveProducerModeStatuses`
 *                              (Wave 1 Phase 3).
 *       - Last errors:         `media_intelligence_runs` failures.
 *   * NEVER re-aggregate or re-implement these.
 *   * NEVER read raw env vars for producer-mode decisions.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { buildInvestigationDiagnostics } from "../services/investigation-diagnostics.service.js";

const TeamQuery = z.object({
  teamId: z.string().uuid(),
});

export async function investigationDiagnosticsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/investigation/diagnostics",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await requireDiagnosticsOpsActor(req, reply, teamId);
      if (!actor) return;

      const diagnostics = await buildInvestigationDiagnostics({
        teamId,
        prisma,
      });

      return reply.code(200).send(diagnostics);
    },
  );
}

// =============================================================================
// Wave 1 — ops-actor gate.
//
// Mirrors `requireOpsActor` in ops.routes.ts / operations-queues.routes.ts
// and the `requireGraphAdminActor` shape in graph.routes.ts. Anti-enumeration:
// non-members receive a 404 (not 403). External reviewers and read-only
// non-admin members are denied. Either `identity.member.read` (workspace
// admin / ops admin) or `evidence.update_metadata` (reviewer admin)
// satisfies the gate — both are sufficient for diagnostics inspection.
// =============================================================================

async function requireDiagnosticsOpsActor(
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
  const [opsDecision, reviewerDecision] = await Promise.all([
    evaluateMemberAccess({
      teamId,
      userId,
      permission: "identity.member.read",
    }),
    evaluateMemberAccess({
      teamId,
      userId,
      permission: "evidence.update_metadata",
    }),
  ]);
  if (!opsDecision.allowed && !reviewerDecision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: opsDecision.reason ?? reviewerDecision.reason ?? "denied",
      },
    });
    return null;
  }
  return { userId };
}
