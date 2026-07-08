/**
 * Phase 26 — SCIM v2 endpoints.
 *
 * Token-protected (Bearer scim_pat_*) — NEVER accepts the API session
 * JWT. The token's `teamId` scopes every operation; cross-team access
 * is impossible.
 *
 *   POST   /v2/scim/Users        — create or get (idempotent on externalId)
 *   GET    /v2/scim/Users/:id    — read
 *   GET    /v2/scim/Users        — list (with filter)
 *   PATCH  /v2/scim/Users/:id    — patch op (active replace)
 *   DELETE /v2/scim/Users/:id    — deactivate (soft)
 *
 * Response shape conforms to RFC 7644:
 *   - Resources carry `schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"]`.
 *   - List responses use `ListResponse` schema.
 *   - Errors use the `Error` schema.
 *   - Content-Type: application/scim+json.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  SCIM_USER_SCHEMA_URI,
  ScimGroupPatchOpSchema,
  ScimGroupSchema,
  ScimPatchOpSchema,
  ScimUserSchema,
  interpretScimUserPatch,
  scimError,
  type ScimScope,
} from "@proovra/shared";

import {
  authenticateScimRequest,
  scimCreateUser,
  scimDeactivateUser,
  scimListUsers,
  scimReactivateUser,
  scimReadUser,
  scimUpdateUserAttributes,
} from "../services/access-control/scim.service.js";
import {
  scimCreateGroup,
  scimDeleteGroup,
  scimListGroups,
  scimPatchGroup,
  scimReadGroup,
} from "../services/access-control/scim-groups.service.js";
import { resolveTeamEnterpriseFeatureGate } from "../services/enterprise-gate-resolvers.service.js";

// -----------------------------------------------------------------------------
// Token gate
// -----------------------------------------------------------------------------

type ScimContext = {
  tokenId: string;
  teamId: string;
  scopes: ReadonlyArray<ScimScope>;
  baseUrl: string;
};

async function authenticateScim(
  req: FastifyRequest,
  reply: FastifyReply,
  required: ScimScope,
): Promise<ScimContext | null> {
  const auth = req.headers["authorization"];
  const remoteIp = req.ip ?? null;
  const result = await authenticateScimRequest({
    authorizationHeader: typeof auth === "string" ? auth : undefined,
    remoteIp,
  });
  if (!result.ok) {
    reply
      .header("WWW-Authenticate", "Bearer realm=\"scim\"")
      .type("application/scim+json")
      .code(401)
      .send(scimError(401, result.reason, "invalidCredentials"));
    return null;
  }
  if (!result.token.scopes.includes(required)) {
    reply
      .type("application/scim+json")
      .code(403)
      .send(scimError(403, "scope_not_granted", "scopeDenied"));
    return null;
  }

  // SCIM = Enterprise (shared resolver).
  if (!(await resolveTeamEnterpriseFeatureGate(result.token.teamId, "ssoScim")).ok) {
    reply.type("application/scim+json").code(402).send(scimError(402, "ssoScim", "enterpriseFeatureRequired"));
    return null;
  }

  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] ?? "";
  return {
    tokenId: result.token.id,
    teamId: result.token.teamId,
    scopes: result.token.scopes,
    baseUrl: `${proto}://${host}/v2/scim`,
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const ParamsUserId = z.object({ id: z.string().uuid() });

export async function scimRoutes(app: FastifyInstance) {
  // POST /v2/scim/Users — create
  app.post(
    "/v2/scim/Users",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.write");
      if (!ctx) return;
      const parsed = ScimUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .type("application/scim+json")
          .code(400)
          .send(scimError(400, "invalid_payload", "invalidSyntax"));
      }
      const result = await scimCreateUser(ctx, parsed.data);
      if (!result.ok) {
        return reply
          .type("application/scim+json")
          .code(result.status)
          .send(scimError(result.status, result.detail));
      }
      return reply
        .type("application/scim+json")
        .code(result.alreadyExisted ? 200 : 201)
        .send(result.user);
    },
  );

  // GET /v2/scim/Users/:id — read
  app.get(
    "/v2/scim/Users/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.read");
      if (!ctx) return;
      const { id } = ParamsUserId.parse(req.params);
      const user = await scimReadUser(ctx, id);
      if (!user) {
        return reply
          .type("application/scim+json")
          .code(404)
          .send(scimError(404, "User not found"));
      }
      return reply.type("application/scim+json").code(200).send(user);
    },
  );

  // GET /v2/scim/Users — list
  app.get(
    "/v2/scim/Users",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.read");
      if (!ctx) return;
      const q = z
        .object({
          filter: z.string().max(200).optional(),
          startIndex: z.coerce.number().int().min(1).optional(),
          count: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const result = await scimListUsers(ctx, q);
      return reply.type("application/scim+json").code(200).send(result);
    },
  );

  // PATCH /v2/scim/Users/:id — supported subset:
  //   • replace active            → deactivate (SOFT suspend) / reactivate
  //   • replace/add displayName   → mapping displayName
  //   • replace/add name.formatted→ mapping displayName
  //   • replace/add userType|roles→ TeamMember.role (VIEWER | MEMBER only)
  // Any unsupported path (phoneNumbers, addresses, emails rewrite, …)
  // yields a spec-correct 501/400 — we NEVER report silent success for
  // an attribute the data model cannot persist.
  app.patch(
    "/v2/scim/Users/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.write");
      if (!ctx) return;
      const { id } = ParamsUserId.parse(req.params);
      const parsed = ScimPatchOpSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .type("application/scim+json")
          .code(400)
          .send(scimError(400, "invalid_patch", "invalidSyntax"));
      }

      const plan = interpretScimUserPatch(parsed.data.Operations);

      // Nothing the model can honestly persist → be honest about it.
      if (!plan.hasSupported) {
        return reply
          .type("application/scim+json")
          .code(501)
          .send(
            scimError(
              501,
              `unsupported PATCH path(s): ${plan.unsupported.join(", ") || "none"}`,
            ),
          );
      }

      // Apply the `active` transition first (it gates whether the user
      // is resolvable for a subsequent attribute write).
      if (plan.active === false) {
        const result = await scimDeactivateUser(ctx, id);
        if (!result.ok) {
          return reply
            .type("application/scim+json")
            .code(404)
            .send(scimError(404, "User not found"));
        }
      } else if (plan.active === true) {
        const result = await scimReactivateUser(ctx, id);
        if (!result.ok) {
          return reply
            .type("application/scim+json")
            .code(404)
            .send(scimError(404, "User not found"));
        }
      }

      // Apply supported attribute updates (displayName / role).
      if (plan.displayName !== undefined || plan.role !== undefined) {
        const upd = await scimUpdateUserAttributes(ctx, id, {
          ...(plan.displayName !== undefined
            ? { displayName: plan.displayName }
            : {}),
          ...(plan.role !== undefined ? { role: plan.role } : {}),
        });
        if (!upd.ok && upd.status === 404) {
          return reply
            .type("application/scim+json")
            .code(404)
            .send(scimError(404, "User not found"));
        }
        // A `noTarget` here (e.g. displayName supplied but the mapping is
        // unlinked) is non-fatal when an `active` change already applied;
        // otherwise surface it so the caller is not misled.
        if (!upd.ok && plan.active === undefined) {
          return reply
            .type("application/scim+json")
            .code(upd.status)
            .send(scimError(upd.status, upd.detail, upd.scimType));
        }
      }

      const user = await scimReadUser(ctx, id);
      return reply
        .type("application/scim+json")
        .code(200)
        .send(user ?? { schemas: [SCIM_USER_SCHEMA_URI], id });
    },
  );

  // DELETE /v2/scim/Users/:id — soft deactivate
  app.delete(
    "/v2/scim/Users/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.deactivate");
      if (!ctx) return;
      const { id } = ParamsUserId.parse(req.params);
      const result = await scimDeactivateUser(ctx, id);
      if (!result.ok) {
        return reply
          .type("application/scim+json")
          .code(404)
          .send(scimError(404, "User not found"));
      }
      return reply.type("application/scim+json").code(204).send();
    },
  );

  // ===========================================================================
  // Phase 26.5 — SCIM Groups (RFC 7644 Group resource)
  // ===========================================================================

  const ParamsGroupId = z.object({ id: z.string().uuid() });

  // POST /v2/scim/Groups
  app.post(
    "/v2/scim/Groups",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.write");
      if (!ctx) return;
      const parsed = ScimGroupSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .type("application/scim+json")
          .code(400)
          .send(scimError(400, "invalid_group_payload", "invalidSyntax"));
      }
      const result = await scimCreateGroup(ctx, parsed.data);
      if (!result.ok) {
        return reply
          .type("application/scim+json")
          .code(result.status)
          .send(scimError(result.status, result.detail));
      }
      return reply
        .type("application/scim+json")
        .code(result.alreadyExisted ? 200 : 201)
        .send(result.group);
    },
  );

  // GET /v2/scim/Groups/:id
  app.get(
    "/v2/scim/Groups/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.read");
      if (!ctx) return;
      const { id } = ParamsGroupId.parse(req.params);
      const group = await scimReadGroup(ctx, id);
      if (!group) {
        return reply
          .type("application/scim+json")
          .code(404)
          .send(scimError(404, "Group not found"));
      }
      return reply.type("application/scim+json").code(200).send(group);
    },
  );

  // GET /v2/scim/Groups
  app.get(
    "/v2/scim/Groups",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.read");
      if (!ctx) return;
      const q = z
        .object({
          filter: z.string().max(200).optional(),
          startIndex: z.coerce.number().int().min(1).optional(),
          count: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const result = await scimListGroups(ctx, q);
      return reply.type("application/scim+json").code(200).send(result);
    },
  );

  // PATCH /v2/scim/Groups/:id
  app.patch(
    "/v2/scim/Groups/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.write");
      if (!ctx) return;
      const { id } = ParamsGroupId.parse(req.params);
      const parsed = ScimGroupPatchOpSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .type("application/scim+json")
          .code(400)
          .send(scimError(400, "invalid_patch", "invalidSyntax"));
      }
      const result = await scimPatchGroup(ctx, id, parsed.data);
      if (!result.ok) {
        return reply
          .type("application/scim+json")
          .code(result.status)
          .send(scimError(result.status, result.detail));
      }
      return reply.type("application/scim+json").code(200).send(result.group);
    },
  );

  // DELETE /v2/scim/Groups/:id
  app.delete(
    "/v2/scim/Groups/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateScim(req, reply, "users.deactivate");
      if (!ctx) return;
      const { id } = ParamsGroupId.parse(req.params);
      const result = await scimDeleteGroup(ctx, id);
      if (!result.ok) {
        return reply
          .type("application/scim+json")
          .code(404)
          .send(scimError(404, "Group not found"));
      }
      return reply.type("application/scim+json").code(204).send();
    },
  );
}
