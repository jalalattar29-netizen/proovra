/**
 * Phase 32.8E — Enterprise aggregator routes.
 *
 *   GET /v1/teams/workspace-admin?teamId=<uuid>
 *   GET /v1/governance/control-plane?teamId=<uuid>
 *
 * Each endpoint is read-only, workspace-scoped, partial-failure
 * tolerant, and emits NO audit events. Used by the enterprise /teams
 * and /governance surfaces.
 *
 * Phase 12 Point 4 — the third endpoint (`GET /v1/reviewer-ops/command`)
 * was removed; the canonical reviewer aggregator is
 * `GET /v1/reviewer-ops/console` in `reviewer-console.routes.ts`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { authorizeWorkspaceOrFail } from "../middleware/authorize.js";

import { buildWorkspaceAdmin } from "../services/workspace-admin/workspace-admin.service.js";
import { buildGovernanceControlPlane } from "../services/governance/governance-control-plane.service.js";

const Query = z.object({ teamId: z.string().uuid() });

/**
 * Both reads answer to the canonical engine and a named permission (AUTHZ-003).
 * The local gate tested `status` only, so access expiry and organization
 * lifecycle did not count here. `workspaceRole` is the canonical role; the
 * envelope's `role` label stays the stored one the clients render.
 */
const STORED_ROLE_LABEL: Record<string, string> = { REVIEWER: "MEMBER" };
const roleLabel = (canonical: string): string => STORED_ROLE_LABEL[canonical] ?? canonical;

export async function enterpriseAggregatorsRoutes(app: FastifyInstance) {
  // ----------- Workspace administration (Teams) -----------
  app.get(
    "/v1/teams/workspace-admin",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = Query.parse(req.query ?? {});
      const ctx = await authorizeWorkspaceOrFail(req, reply, {
        workspaceId: query.teamId,
        permission: "identity.member.read",
      });
      if (!ctx) return;
      const envelope = await buildWorkspaceAdmin({
        teamId: query.teamId,
        userId: ctx.userId,
        role: roleLabel(ctx.workspaceRole),
        // The rule `GET /v1/teams/:id/members` applies (AZ-R07, AUTHZ-004).
        canSeeContact: ctx.workspaceRole === "OWNER" || ctx.workspaceRole === "ADMIN",
      });
      if ("notFound" in envelope) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send(envelope);
    },
  );

  // ----------- Governance control plane -----------
  app.get(
    "/v1/governance/control-plane",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = Query.parse(req.query ?? {});
      const ctx = await authorizeWorkspaceOrFail(req, reply, {
        workspaceId: query.teamId,
        permission: "governance.policy.read",
      });
      if (!ctx) return;
      const envelope = await buildGovernanceControlPlane({
        teamId: query.teamId,
        userId: ctx.userId,
        role: roleLabel(ctx.workspaceRole),
      });
      return reply.code(200).send(envelope);
    },
  );

  // Phase 12 Point 4 — `GET /v1/reviewer-ops/command` REMOVED. It was a
  // second read-only reviewer aggregator over the same reviewer-ops
  // services as the canonical `GET /v1/reviewer-ops/console`
  // (reviewer-console.routes.ts), reachable only from the unmounted
  // ReviewerCommandConsole, and it authorized through a local
  // membership lookup rather than the canonical
  // `evaluateMemberAccess` path the console aggregator uses. Two
  // aggregators with two authorization paths over one domain is a
  // duplicate authority; the console aggregator is the survivor.
}
