/**
 * PHASE 12B C6 — SCIM ADMINISTRATION (operator session, NOT the IdP).
 *
 * These legs complete the SCIM administration workflow that the SCIM v2
 * protocol surface cannot serve: an operator needs to SEE which memberships the
 * directory owns, and to rotate a provisioning credential.
 *
 * WHY THIS IS A SEPARATE FILE FROM `scim.routes.ts`:
 *   `scim.routes.ts` is the RFC 7644 protocol surface and is bearer-token-only
 *   by contract — an IdP presents a hashed SCIM token, never a session cookie.
 *   That invariant is machine-guarded ("SCIM routes NEVER use requireAuth" in
 *   phase26-identity-governance.test.ts), and the guard is load-bearing: if a
 *   session-authenticated route lives in the same file, the next `/v2/scim/*`
 *   route added by copy-paste can silently inherit `preHandler: requireAuth`
 *   and become reachable with a customer's browser session. Keeping the two
 *   authentication models in separate files preserves the guard as an absolute
 *   file-level assertion rather than weakening it to a per-route scan.
 *
 * Every route here composes the full mandated chain:
 *   requireAuth → authorizeOrFail (ACTIVE membership + Organization lifecycle +
 *   capability + audit + anti-enumeration, with the request's teamId treated as
 *   a CANDIDATE that can only ever produce a denial) → enterprise entitlement →
 *   target-bound step-up (mutations) → transactional write → canonical audit.
 *
 *   GET  /v1/admin/identity/scim/managed-membership  — ownership visibility
 *   POST /v1/admin/identity/scim/tokens/:id/rotate   — atomic rotation
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  projectScimManagedMembership,
  rotateScimToken,
} from "../services/access-control/scim.service.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { resolveTeamEnterpriseFeatureGate } from "../services/enterprise-gate-resolvers.service.js";

const ParamsTokenId = z.object({ id: z.string().uuid() });

export async function scimAdminRoutes(app: FastifyInstance) {
  /**
   * The workspace scope is taken from the request ONLY as a candidate; it is
   * `authorizeOrFail` that binds the actor's ACTIVE membership + Organization
   * lifecycle to it. A value the caller does not actually hold membership in
   * can therefore only ever produce a denial, never authority.
   */
  async function requireScimAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
    candidateTeamId: string,
    resourceId: string | null,
    stepUp: boolean,
  ): Promise<{ actorUserId: string; teamId: string } | null> {
    const actor = await authorizeOrFail(req, reply, {
      teamId: candidateTeamId,
      permission: stepUp
        ? "identity.external_mapping.manage"
        : "identity.external_mapping.read",
      resourceKind: "scim_provisioning_token",
      ...(resourceId ? { resourceId } : {}),
      antiEnumeration: true,
    });
    if (!actor) return null;

    // SCIM administration is an Enterprise entitlement — same resolver the
    // protocol surface uses, so the console can never manage a directory the
    // plan does not include.
    const gate = await resolveTeamEnterpriseFeatureGate(actor.teamId, "ssoScim");
    if (!gate.ok) {
      reply
        .code(402)
        .send({ error: { code: "enterprise_feature_required", feature: "ssoScim" } });
      return null;
    }

    if (stepUp) {
      const stepUpGate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: actor.teamId,
        userId: actor.actorUserId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "scim_provisioning_token",
        resourceId,
      });
      if (stepUpGate.sent) return null;
    }
    return actor;
  }

  app.get(
    "/v1/admin/identity/scim/managed-membership",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .safeParse(req.query ?? {});
      if (!q.success) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", detail: q.error.flatten() } });
      }
      const actor = await requireScimAdmin(req, reply, q.data.teamId, null, false);
      if (!actor) return;
      const projection = await projectScimManagedMembership({
        teamId: actor.teamId,
        ...(q.data.limit !== undefined ? { limit: q.data.limit } : {}),
      });
      return reply.code(200).send({ projection });
    },
  );

  app.post(
    "/v1/admin/identity/scim/tokens/:id/rotate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = ParamsTokenId.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: { code: "validation_error" } });
      }
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().trim().min(1).max(180).optional(),
          reason: z.string().trim().max(400).optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: body.error.flatten() },
        });
      }
      const actor = await requireScimAdmin(
        req,
        reply,
        body.data.teamId,
        params.data.id,
        true,
      );
      if (!actor) return;

      const result = await rotateScimToken({
        teamId: actor.teamId,
        id: params.data.id,
        actorUserId: actor.actorUserId,
        name: body.data.name ?? null,
        reason: body.data.reason ?? null,
      });
      if (!result.ok) {
        // Anti-enumeration: a token belonging to another workspace is
        // indistinguishable from one that does not exist.
        if (result.reason === "not_found") {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply
          .code(409)
          .send({ error: { code: "scim_token_already_revoked" } });
      }
      // `tokenOnce` is the ONLY place the raw replacement token appears.
      return reply.code(201).send({
        revoked: result.revoked,
        projection: result.projection,
        tokenOnce: result.tokenOnce,
      });
    },
  );
}
