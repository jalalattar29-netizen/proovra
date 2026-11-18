/**
 * Phase 28-D — Governance snapshot + operational timeline routes.
 *
 *   GET /v1/evidence/:id/governance-snapshot?teamId=<uuid>
 *   GET /v1/evidence/:id/operational-timeline?teamId=<uuid>&limit=<n>
 *
 * Both endpoints require session auth + team membership +
 * `audit.read` permission (the canonical "see operator-level state of
 * a record" capability). 404 on non-member to keep tenant boundaries
 * opaque.
 *
 * Both endpoints are read-only and safe to poll from dashboards.
 */

import { installRecordReachGuard } from "../middleware/record-reach-guard.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import {
  GovernanceSnapshotError,
  buildGovernanceSnapshot,
} from "../services/governance-lifecycle/governance-snapshot.service.js";
import { buildOperationalTimeline } from "../services/governance-lifecycle/operational-timeline.service.js";
import { bump } from "../services/ops/metrics.service.js";

const ParamsId = z.object({ id: z.string().uuid() });
const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const TimelineQuery = TeamIdQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * PRO-G2-09 (RG-20) — the canonical authorizer, like the rest of the
 * governance family: ACTIVE membership, expiry, organization lifecycle,
 * support-context guard, capability, anti-enumeration (an outsider and a
 * suspended member both get the concealed 404) and a bounded 503 when the
 * engine cannot decide. The local status-blind membership probe that leaked
 * the engine's reason/detail is gone.
 */
async function requireGovernanceReadActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const authorized = await authorizeOrFail(req, reply, {
    teamId,
    permission: "audit.read",
    antiEnumeration: true,
  });
  if (!authorized) return null;
  return { userId: authorized.actorUserId };
}

export async function governanceSnapshotRoutes(app: FastifyInstance) {
  installRecordReachGuard(app);
  // ---------------------------------------------------------------------------
  // GET /v1/evidence/:id/governance-snapshot
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/evidence/:id/governance-snapshot",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = ParamsId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireGovernanceReadActor(req, reply, q.teamId);
      if (!actor) return;
      try {
        const snapshot = await buildGovernanceSnapshot({
          teamId: q.teamId,
          evidenceId: params.id,
        });

        // Roll up the four bounded counters the brief asks for so the
        // operational alert evaluator + Prometheus scraper see each
        // blocker class without having to inspect snapshot bodies.
        if (!snapshot.export.eligible) {
          bump("export_governance_blocked_total");
          if (snapshot.export.outcome === "BLOCKED_BY_HOLD") {
            bump("legal_hold_export_block_total");
          }
        }
        if (!snapshot.package.eligible) {
          bump("package_governance_blocked_total");
          if (snapshot.package.outcome === "BLOCKED_BY_IMMUTABLE_DRIFT") {
            bump("immutable_drift_block_total");
          }
        }
        if (snapshot.retention.expired && snapshot.destruction.eligible) {
          bump("retention_destruction_candidate_total");
        }

        return reply.code(200).send(snapshot);
      } catch (err) {
        if (
          err instanceof GovernanceSnapshotError &&
          err.code === "EVIDENCE_NOT_FOUND"
        ) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/evidence/:id/operational-timeline
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/evidence/:id/operational-timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = ParamsId.parse(req.params);
      const q = TimelineQuery.parse(req.query ?? {});
      const actor = await requireGovernanceReadActor(req, reply, q.teamId);
      if (!actor) return;
      const timeline = await buildOperationalTimeline({
        teamId: q.teamId,
        evidenceId: params.id,
        limit: q.limit,
      });
      return reply.code(200).send(timeline);
    },
  );
}
