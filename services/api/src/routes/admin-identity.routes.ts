/**
 * Phase 26 — Admin Identity Governance API.
 *
 * Pure admin surface (workspace OWNER / ADMIN / identity-delegated).
 * Routes go through the Phase 17 access-policy engine via the
 * Phase 26 RBAC engine — never bypassed.
 *
 * Endpoints:
 *
 *   Identity providers (SSO)
 *     GET    /v1/admin/identity/providers
 *     POST   /v1/admin/identity/providers
 *     POST   /v1/admin/identity/providers/:id/transition
 *
 *   Permission matrix
 *     GET    /v1/admin/identity/permission-matrix?subjectUserId=...
 *     GET    /v1/admin/identity/role-matrix
 *
 *   Temporary elevation
 *     POST   /v1/admin/identity/elevations
 *
 *   SCIM tokens
 *     GET    /v1/admin/identity/scim/tokens
 *     POST   /v1/admin/identity/scim/tokens
 *     POST   /v1/admin/identity/scim/tokens/:id/revoke
 *
 *   Active sessions
 *     GET    /v1/admin/identity/sessions
 *     POST   /v1/admin/identity/sessions/:id/revoke
 *     POST   /v1/admin/identity/sessions/user/:userId/revoke-all
 *
 * Auth posture:
 *   - Every route uses requireAuth + 404-on-non-member.
 *   - Every mutating route runs the Phase 26 RBAC engine against
 *     identity.* permissions.
 *   - Sensitive mutations (SSO connection create/revoke, SCIM token
 *     create, session revoke-all, temporary elevation) wrap through
 *     requireStepUpForSensitiveAction.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  SCIM_SCOPES,
  SSO_CONNECTION_STATUSES,
  SsoConnectionCreateInputSchema,
  TEMPORARY_ELEVATION_DEFAULT_SECONDS,
  TEMPORARY_ELEVATION_MAX_SECONDS,
  TEMPORARY_ELEVATION_MIN_SECONDS,
  TemporaryElevationSchema,
  type Permission,
  type ScimScope,
  type SsoConnectionStatus,
  type SessionRevocationReason,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
// PHASE 12B (2026-07-30) — the canonical authorization primitive. The two
// routes the identity-administration console consumes (role-matrix +
// elevations) compose SERVER-derived workspace resolution with
// `authorizeOrFail`; they no longer re-implement the membership/status
// approximation that `requireIdentityAdmin` (still used by the SSO / SCIM /
// session surfaces owned by other tracks) performs inline.
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  RbacEngineError,
  buildPermissionSnapshot,
  computeEffectiveRoleMatrix,
  grantTemporaryElevation,
} from "../services/access-control/rbac-engine.service.js";
import {
  SsoServiceError,
  createSsoConnection,
  listSsoConnections,
  transitionSsoConnection,
  updateSsoConnectionPolicy,
} from "../services/access-control/sso.service.js";
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
} from "../services/access-control/scim.service.js";
import {
  listActiveSessions,
  refreshHighRiskSessionGauge,
  revokeActiveSession,
  revokeAllSessionsForUserAdmin,
  sweepStaleSessions,
} from "../services/access-control/session-inventory.service.js";
import { detectAndScoreSession } from "../services/access-control/suspicious-session.service.js";
import { sweepStaleCallbackAttempts } from "../services/access-control/sso-hardening.service.js";
import { runtimeAdaptiveGate } from "../services/access-control/adaptive-runtime-gate.service.js";
import {
  emergencyOrgRevoke,
  listQuarantinedSessions,
  quarantineSession,
  releaseQuarantine,
  sweepQuarantineReleases,
} from "../services/access-control/session-quarantine.service.js";
import { runtimeRiskRecomputeSweep } from "../services/access-control/runtime-risk.service.js";
import { sweepTrustedDeviceDecay } from "../services/access-control/trusted-device-decay.service.js";
import { sweepGeoCache } from "../services/access-control/geo-intelligence.service.js";
import {
  SESSION_QUARANTINE_REASONS,
  type SessionQuarantineReason,
} from "@proovra/shared";

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

type AdminContext = { userId: string };

async function requireIdentityAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission = "identity.org_policy.read",
): Promise<AdminContext | null> {
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
    reply
      .code(403)
      .send({ error: { code: "member_inactive" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission,
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

function sendError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof SsoServiceError) {
    const status =
      err.code === "SSO_CONNECTION_NOT_FOUND"
        ? 404
        : err.code === "SSO_INVALID_STATE" ||
            err.code === "SSO_INVALID_TRANSITION" ||
            err.code === "SSO_INVALID_PROVIDER" ||
            err.code === "SSO_NO_VERIFIED_DOMAINS" ||
            err.code === "SSO_INVALID_SP_KEY"
          ? 400
          : err.code === "SSO_JIT_DISABLED" ||
              err.code === "SSO_EMAIL_DOMAIN_NOT_ALLOWED"
            ? 403
            : 502;
    reply.code(status).send({
      error: { code: err.code, details: err.details ?? null },
    });
    return true;
  }
  if (err instanceof RbacEngineError) {
    const status =
      err.code === "RBAC_MEMBER_NOT_FOUND"
        ? 404
        : err.code === "RBAC_ELEVATION_BLOCKED"
          ? 403
          : 400;
    reply.code(status).send({
      error: { code: err.code, details: err.details ?? null },
    });
    return true;
  }
  return false;
}

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });
const BoundedNote = z.string().min(1).max(400);

// -----------------------------------------------------------------------------
// PHASE 12B (2026-07-30) — reconcile entrypoints are DUAL-MODE.
//
// The two reconcile sweeps below are consumed by BOTH the scheduler (machine,
// shared-secret authenticated, unchanged) AND an operator in the identity
// administration console. Exactly one mode applies per request:
//
//   machine  — valid `x-cron-secret`; the scheduler names the workspace it was
//              configured for; no session, no step-up, no operator audit.
//   operator — a real session (requireAuth), a SERVER-derived workspace, the
//              canonical `authorizeOrFail` chain, step-up bound to that
//              workspace, and a canonical audit entry carrying the actor and
//              the reconcile outcome.
//
// The secret check stays FIRST so an unauthenticated machine request still
// fails with the scheduler's 401 rather than a session error.
// -----------------------------------------------------------------------------

function hasValidReconcileCronSecret(req: FastifyRequest): boolean {
  const expected =
    process.env["IDENTITY_RECONCILE_CRON_SECRET"] ||
    process.env["INTEGRATION_CRON_SECRET"] ||
    "";
  const got = req.headers["x-cron-secret"];
  return (
    expected.length > 0 &&
    typeof got === "string" &&
    got.length > 0 &&
    got === expected
  );
}

/**
 * Entry guard for the dual-mode reconciles. A request carrying the shared
 * secret is the scheduler and proceeds unauthenticated-by-session; anything
 * else MUST present a real session before the handler runs.
 */
async function reconcileEntrypointAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  if (hasValidReconcileCronSecret(req)) return;
  return requireAuth(req, reply);
}

/**
 * Canonical audit for an OPERATOR-triggered reconcile: actor identity plus the
 * workspace acted on and the bounded outcome counts (never row contents).
 * Audit failures never mask a completed sweep.
 */
async function auditOperatorReconcile(
  req: FastifyRequest,
  input: { teamId: string; action: string; outcome: Record<string, unknown> },
): Promise<void> {
  try {
    await emitTenantAudit({
      action: input.action,
      outcome: "success",
      sourceApp: "API",
      actorUserId: getAuthUserId(req),
      workspaceId: input.teamId,
      resourceType: "team",
      resourceId: input.teamId,
      metadata: { ...input.outcome, trigger: "operator" },
    });
  } catch {
    /* audit is append-only and best-effort here; the sweep already committed */
  }
}

/**
 * PHASE 12B (2026-07-30) — SERVER-DERIVED workspace subject for the identity
 * administration console. The authoritative workspace is the persisted
 * `User.currentWorkspaceId` rail (written only by the audited workspace
 * switcher in platform-context.routes.ts). A `teamId` supplied by the client
 * is accepted only to REJECT a mismatch — it never selects the scope. Absent
 * context is a concealed 404, matching the canonical primitive's
 * not-a-member path.
 */
async function resolveAdminWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  declaredTeamId: string | undefined,
  permission: Permission,
): Promise<{ teamId: string; userId: string } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  const teamId = user?.currentWorkspaceId ?? null;
  if (!teamId || (declaredTeamId && declaredTeamId !== teamId)) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  if (!outcome) return null;
  return { teamId: outcome.teamId, userId: outcome.actorUserId };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function adminIdentityRoutes(app: FastifyInstance) {
  // ===========================================================================
  // SSO — Identity providers
  // ===========================================================================

  app.get(
    "/v1/admin/identity/providers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireIdentityAdmin(req, reply, q.teamId);
      if (!actor) return;
      const providers = await listSsoConnections({ teamId: q.teamId });
      // Phase 3 — surface the owning org's verified-domain count so the UI can
      // safely gate the "restrict to verified domains" toggle. Read-only.
      const team = await prisma.team.findUnique({
        where: { id: q.teamId },
        select: { organizationId: true },
      });
      const verifiedDomainCount = team?.organizationId
        ? await prisma.organizationDomain.count({
            where: {
              organizationId: team.organizationId,
              verifiedAt: { not: null },
            },
          })
        : 0;
      return reply
        .code(200)
        .send({ providers, verifiedDomainCount });
    },
  );

  app.post(
    "/v1/admin/identity/providers",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = SsoConnectionCreateInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: parsed.error.flatten() },
        });
      }
      const body = parsed.data;
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.external_mapping.manage",
      );
      if (!actor) return;
      // Phase 26.75 — runtime adaptive gate (quarantine + age + risk).
      const runtimeGate = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        action: "SSO_CONNECTION_CREATE",
      });
      if (!runtimeGate.allow) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
        resourceId: null,
      });
      if (gate.sent) return;
      try {
        const result = await createSsoConnection({
          ...body,
          actorUserId: actor.userId,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (sendError(reply, err)) return;
        throw err;
      }
    },
  );

  app.post(
    "/v1/admin/identity/providers/:id/transition",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          nextStatus: z.enum(SSO_CONNECTION_STATUSES),
          reason: BoundedNote.optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.external_mapping.manage",
      );
      if (!actor) return;
      if (body.nextStatus === "REVOKED") {
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: body.teamId,
          userId: actor.userId,
          purpose: "EXTERNAL_IDENTITY_UNLINK",
          resourceKind: "sso_connection",
          resourceId: id,
        });
        if (gate.sent) return;
      }
      try {
        const projection = await transitionSsoConnection({
          teamId: body.teamId,
          id,
          nextStatus: body.nextStatus as SsoConnectionStatus,
          actorUserId: actor.userId,
          reason: body.reason ?? null,
        });
        return reply.code(200).send({ projection });
      } catch (err) {
        if (sendError(reply, err)) return;
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 3 — SAML SP signing + verified-domain policy update.
  //
  // Enterprise ORG-admin surface. Sets samlSignRequests / restrictToVerifiedDomains
  // and installs/rotates/clears the per-connection SP signing key + cert.
  //
  // SECURITY: the request body MAY carry a private key (write-only). The
  // response projection NEVER echoes it back (status + fingerprint only).
  // Step-up (EXTERNAL_IDENTITY_LINK — the existing identity-provider purpose)
  // is required; every change is audit-logged with field NAMES only.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/identity/providers/:id/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          samlSignRequests: z.boolean().optional(),
          restrictToVerifiedDomains: z.boolean().optional(),
          // Write-only key material. Empty string clears; omit to leave as-is.
          samlSpPrivateKey: z.string().max(16384).nullable().optional(),
          samlSpCertificate: z.string().max(8192).nullable().optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.external_mapping.manage",
      );
      if (!actor) return;
      // Runtime adaptive gate (quarantine + age + risk), consistent with the
      // other sensitive SSO mutations.
      const runtimeGate = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        action: "SSO_CONNECTION_CREATE",
      });
      if (!runtimeGate.allow) return;
      // Reuse the EXISTING identity-provider step-up purpose.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "sso_connection",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const projection = await updateSsoConnectionPolicy({
          teamId: body.teamId,
          id,
          actorUserId: actor.userId,
          samlSignRequests: body.samlSignRequests,
          restrictToVerifiedDomains: body.restrictToVerifiedDomains,
          samlSpPrivateKey: body.samlSpPrivateKey,
          samlSpCertificate: body.samlSpCertificate,
        });
        return reply.code(200).send({ projection });
      } catch (err) {
        if (sendError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // Permission matrix
  // ===========================================================================

  app.get(
    "/v1/admin/identity/permission-matrix",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          subjectUserId: z.string().uuid(),
        })
        .parse(req.query ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        q.teamId,
        "identity.member.read",
      );
      if (!actor) return;
      try {
        const snapshot = await buildPermissionSnapshot({
          teamId: q.teamId,
          userId: q.subjectUserId,
        });
        return reply.code(200).send({ snapshot });
      } catch (err) {
        if (sendError(reply, err)) return;
        throw err;
      }
    },
  );

  // PHASE 12B — the AUTHORITATIVE role→permission projection consumed by
  // `/admin/identity/permission-matrix`. The console renders this matrix; it
  // never computes role precedence or effective permissions client-side.
  app.get(
    "/v1/admin/identity/role-matrix",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid().optional() })
        .parse(req.query ?? {});
      const ctx = await resolveAdminWorkspace(
        req,
        reply,
        q.teamId,
        "identity.org_policy.read",
      );
      if (!ctx) return;
      const matrix = computeEffectiveRoleMatrix();
      return reply.code(200).send({ matrix, teamId: ctx.teamId });
    },
  );

  // ===========================================================================
  // Temporary elevation
  // ===========================================================================

  app.post(
    "/v1/admin/identity/elevations",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = TemporaryElevationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: "validation_error", detail: parsed.error.flatten() },
        });
      }
      const body = parsed.data;
      // PHASE 12B — the workspace is SERVER-derived; `body.teamId` (required by
      // the strict shared schema) only ever rejects a mismatch. The elevation
      // is always written into the derived workspace, and the subject must be
      // an ACTIVE member of it (enforced by `grantTemporaryElevation`, whose
      // RBAC_MEMBER_NOT_FOUND surfaces as a concealed 404 for a subject that
      // belongs to another Organization).
      const ctx = await resolveAdminWorkspace(
        req,
        reply,
        body.teamId,
        "identity.capability.grant",
      );
      if (!ctx) return;
      // Phase 26.75 — runtime adaptive gate.
      const runtimeGateElev = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        action: "RBAC_TEMPORARY_ELEVATION",
      });
      if (!runtimeGateElev.allow) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "temporary_elevation",
        resourceId: body.userId,
      });
      if (gate.sent) return;
      try {
        const ttl = Math.min(
          Math.max(body.ttlSeconds ?? TEMPORARY_ELEVATION_DEFAULT_SECONDS, TEMPORARY_ELEVATION_MIN_SECONDS),
          TEMPORARY_ELEVATION_MAX_SECONDS,
        );
        const result = await grantTemporaryElevation({
          ...body,
          teamId: ctx.teamId,
          grantedByUserId: ctx.userId,
          ttlSeconds: ttl,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (sendError(reply, err)) return;
        throw err;
      }
    },
  );

  // ===========================================================================
  // SCIM tokens
  // ===========================================================================

  app.get(
    "/v1/admin/identity/scim/tokens",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        q.teamId,
        "identity.external_mapping.read",
      );
      if (!actor) return;
      const tokens = await listScimTokens({ teamId: q.teamId });
      return reply.code(200).send({ tokens });
    },
  );

  app.post(
    "/v1/admin/identity/scim/tokens",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().min(1).max(180),
          scopes: z.array(z.enum(SCIM_SCOPES)).min(1).max(SCIM_SCOPES.length),
          ipAllowlist: z.array(z.string().min(1).max(80)).max(20).optional(),
          expiresAtUtc: z.string().datetime().nullable().optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.external_mapping.manage",
      );
      if (!actor) return;
      // Phase 26.75 — runtime adaptive gate.
      const runtimeGate = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        action: "SCIM_TOKEN_CREATE",
      });
      if (!runtimeGate.allow) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_LINK",
        resourceKind: "scim_token",
        resourceId: null,
      });
      if (gate.sent) return;
      const result = await createScimToken({
        teamId: body.teamId,
        actorUserId: actor.userId,
        name: body.name,
        scopes: body.scopes as ScimScope[],
        ipAllowlist: body.ipAllowlist,
        expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/v1/admin/identity/scim/tokens/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: BoundedNote.optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.external_mapping.manage",
      );
      if (!actor) return;
      // PHASE 12B (2026-07-30) — SCIM token CREATE and ROTATE are step-up
      // gated; revoke was not, so the weakest leg decided how hard it is to
      // change directory-provisioning access. Gated here with the same
      // external-identity purpose, bound to the TOKEN being revoked, AFTER
      // authorization and BEFORE the write.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "EXTERNAL_IDENTITY_UNLINK",
        resourceKind: "SCIM_TOKEN",
        resourceId: id,
      });
      if (gate.sent) return;
      const projection = await revokeScimToken({
        teamId: body.teamId,
        id,
        actorUserId: actor.userId,
        reason: body.reason ?? null,
      });
      if (!projection) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ projection });
    },
  );

  // ===========================================================================
  // Active sessions
  // ===========================================================================

  app.get(
    "/v1/admin/identity/sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          userId: z.string().uuid().optional(),
          includeRevoked: z.coerce.boolean().optional(),
          includeExpired: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireIdentityAdmin(req, reply, q.teamId);
      if (!actor) return;
      const sessions = await listActiveSessions({
        teamId: q.teamId,
        userId: q.userId,
        includeRevoked: q.includeRevoked,
        includeExpired: q.includeExpired,
        limit: q.limit,
      });
      return reply.code(200).send({ sessions });
    },
  );

  app.post(
    "/v1/admin/identity/sessions/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z
            .enum([
              "OPERATOR_REVOKED",
              "MEMBER_SUSPENDED",
              "MEMBER_REVOKED",
              "SUSPICIOUS_ACTIVITY",
              "POLICY_CHANGE",
              "STEP_UP_DENIED",
            ])
            .optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.contributor_session.revoke",
      );
      if (!actor) return;
      const result = await revokeActiveSession({
        teamId: body.teamId,
        sessionId: id,
        actorUserId: actor.userId,
        reason: body.reason as SessionRevocationReason | undefined,
      });
      if (!result.ok) {
        // PHASE 12B C4 — "no such session in this workspace" stays a concealed
        // 404 (identical to a cross-Organization id); "already revoked" is a
        // bounded 409 so the operator learns the state instead of being told the
        // session does not exist, and so a double submit cannot re-attribute the
        // revocation to the second caller.
        if (result.reason === "already_revoked") {
          return reply
            .code(409)
            .send({ error: { code: "session_already_revoked" } });
        }
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ projection: result.projection });
    },
  );

  app.post(
    "/v1/admin/identity/sessions/user/:userId/revoke-all",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { userId } = z
        .object({ userId: z.string().uuid() })
        .parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z
            .enum([
              "OPERATOR_REVOKED",
              "MEMBER_SUSPENDED",
              "MEMBER_REVOKED",
              "SUSPICIOUS_ACTIVITY",
              "POLICY_CHANGE",
              "STEP_UP_DENIED",
            ])
            .optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.contributor_session.revoke",
      );
      if (!actor) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "CONTRIBUTOR_SESSION_REVOKE",
        resourceKind: "user",
        resourceId: userId,
      });
      if (gate.sent) return;
      const result = await revokeAllSessionsForUserAdmin({
        teamId: body.teamId,
        userId,
        actorUserId: actor.userId,
        reason: body.reason as SessionRevocationReason | undefined,
      });
      return reply.code(200).send(result);
    },
  );

  // ===========================================================================
  // Phase 26.5 — Identity event timeline
  // ===========================================================================

  app.get(
    "/v1/admin/identity/timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          subjectUserId: z.string().uuid().optional(),
          kinds: z.string().max(2000).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireIdentityAdmin(req, reply, q.teamId);
      if (!actor) return;
      const kinds = q.kinds
        ? q.kinds
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : null;
      // The timeline is a SecurityEvent projection. We accept a kinds
      // filter to scope the view.
      const events = await prisma.securityEvent.findMany({
        where: {
          teamId: q.teamId,
          ...(kinds ? { eventType: { in: kinds } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(q.limit ?? 100, 1), 500),
      });
      const projected = events.map((e) => ({
        id: e.id,
        kind: e.eventType,
        severity: e.severity,
        occurredAtUtc: e.createdAt.toISOString(),
        actorUserId: q.subjectUserId ?? null,
        // SecurityEvent.details is sanitised by Phase 21; we surface
        // the eventType + a short summary derived from it.
        summary: humaniseEventType(e.eventType),
      }));
      return reply.code(200).send({ events: projected });
    },
  );

  // ===========================================================================
  // Phase 26.5 — Stale session reconcile (cron-secret protected)
  // ===========================================================================

  app.post(
    "/v1/admin/identity/sessions/reconcile-stale",
    { preHandler: reconcileEntrypointAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const machine = hasValidReconcileCronSecret(req);
      const body = z
        .object({
          // Required on the MACHINE path (the scheduler names the workspace it
          // was configured for). On the OPERATOR path it is non-authoritative
          // and only ever rejects a mismatch.
          teamId: z.string().uuid().optional(),
          staleMinutes: z.number().int().min(1).max(1440).optional(),
          batchSize: z.number().int().min(1).max(1000).optional(),
        })
        .parse(req.body ?? {});
      let teamId: string;
      if (machine) {
        if (!body.teamId) {
          return reply.code(400).send({ error: { code: "validation_error" } });
        }
        teamId = body.teamId;
      } else {
        // PHASE 12B — operator-triggered reconcile. Server-derived workspace +
        // canonical authorization + step-up bound to that workspace, because
        // the sweep REVOKES sessions (it is a mutation, not a read).
        const ctx = await resolveAdminWorkspace(
          req,
          reply,
          body.teamId,
          "identity.contributor_session.revoke",
        );
        if (!ctx) return;
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: ctx.teamId,
          userId: ctx.userId,
          purpose: "ORG_SECURITY_POLICY_UPDATE",
          resourceKind: "team",
          resourceId: ctx.teamId,
        });
        if (gate.sent) return;
        teamId = ctx.teamId;
      }
      const result = await sweepStaleSessions({
        teamId,
        staleMinutes: body.staleMinutes,
        batchSize: body.batchSize,
        revoke: true,
      });
      // Also sweep stale OIDC callback attempts.
      const callbackSweep = await sweepStaleCallbackAttempts({});
      // Refresh the high-risk-sessions gauge.
      await refreshHighRiskSessionGauge({ teamId });
      if (!machine) {
        await auditOperatorReconcile(req, {
          teamId,
          action: "identity.sessions.reconcile_stale",
          outcome: { sessions: result, callbackAttempts: callbackSweep },
        });
      }
      return reply.code(200).send({
        sessions: result,
        callbackAttempts: callbackSweep,
        teamId,
      });
    },
  );

  // ===========================================================================
  // Phase 26.5 — On-demand suspicious-session scoring
  // ===========================================================================

  app.post(
    "/v1/admin/identity/sessions/:id/score",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
      const actor = await requireIdentityAdmin(req, reply, body.teamId);
      if (!actor) return;
      const result = await detectAndScoreSession({
        teamId: body.teamId,
        sessionId: id,
      });
      if (!result) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ result });
    },
  );
}

function humaniseEventType(eventType: string): string {
  // Operator-safe transform: snake_case → "Snake case".
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// =============================================================================
// Phase 26.75 — Runtime governance routes
// =============================================================================

export async function adminIdentityRuntimeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/admin/identity/quarantined-sessions
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/admin/identity/quarantined-sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const actor = await requireIdentityAdmin(req, reply, q.teamId);
      if (!actor) return;
      const items = await listQuarantinedSessions({
        teamId: q.teamId,
        limit: q.limit,
      });
      return reply.code(200).send({ items });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/admin/identity/sessions/:id/quarantine
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/identity/sessions/:id/quarantine",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.enum(SESSION_QUARANTINE_REASONS),
          releaseHours: z.number().int().min(1).max(24).optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.contributor_session.revoke",
      );
      if (!actor) return;
      const gate = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        action: "MEMBER_SUSPEND",
      });
      if (!gate.allow) return;
      const result = await quarantineSession({
        teamId: body.teamId,
        sessionId: id,
        reason: body.reason as SessionQuarantineReason,
        actorUserId: actor.userId,
        releaseHours: body.releaseHours,
      });
      if (!result) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ quarantine: result });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/admin/identity/sessions/:id/release
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/identity/sessions/:id/release",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          note: z.string().max(400).optional(),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.contributor_session.revoke",
      );
      if (!actor) return;
      const ok = await releaseQuarantine({
        teamId: body.teamId,
        sessionId: id,
        actorUserId: actor.userId,
        note: body.note ?? null,
      });
      if (!ok) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/admin/identity/emergency-revoke
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/identity/emergency-revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(8).max(400),
        })
        .parse(req.body ?? {});
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.contributor_session.revoke",
      );
      if (!actor) return;
      // Emergency revoke always wraps the step-up gate. This is the
      // single hardest action in the platform.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "ORG_SECURITY_POLICY_UPDATE",
        resourceKind: "team",
        resourceId: body.teamId,
      });
      if (stepUp.sent) return;
      const result = await emergencyOrgRevoke({
        teamId: body.teamId,
        actorUserId: actor.userId,
        reason: body.reason,
      });
      return reply.code(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/admin/identity/runtime/reconcile (cron-secret protected)
  //
  // One endpoint that runs ALL runtime sweeps for a workspace:
  //   - runtime-risk recompute
  //   - trusted-device decay
  //   - quarantine auto-release
  //   - geo cache sweep
  //   - high-risk gauge refresh
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/admin/identity/runtime/reconcile",
    { preHandler: reconcileEntrypointAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const machine = hasValidReconcileCronSecret(req);
      const body = z
        .object({
          teamId: z.string().uuid().optional(),
          recomputeWindowMinutes: z
            .number()
            .int()
            .min(5)
            .max(360)
            .optional(),
          decayStaleDays: z.number().int().min(1).max(180).optional(),
        })
        .parse(req.body ?? {});
      let teamId: string;
      if (machine) {
        if (!body.teamId) {
          return reply.code(400).send({ error: { code: "validation_error" } });
        }
        teamId = body.teamId;
      } else {
        // PHASE 12B — operator-triggered runtime reconcile. The sweeps release
        // quarantines and decay trusted devices, so the operator path is
        // authorized canonically and step-up gated on the derived workspace.
        const ctx = await resolveAdminWorkspace(
          req,
          reply,
          body.teamId,
          "identity.contributor_session.revoke",
        );
        if (!ctx) return;
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: ctx.teamId,
          userId: ctx.userId,
          purpose: "ORG_SECURITY_POLICY_UPDATE",
          resourceKind: "team",
          resourceId: ctx.teamId,
        });
        if (gate.sent) return;
        teamId = ctx.teamId;
      }
      const [risk, decay, releases, geo] = await Promise.all([
        runtimeRiskRecomputeSweep({
          teamId,
          recomputeWindowMinutes: body.recomputeWindowMinutes,
        }),
        sweepTrustedDeviceDecay({
          teamId,
          staleDays: body.decayStaleDays,
        }),
        sweepQuarantineReleases({ teamId }),
        sweepGeoCache(),
      ]);
      if (!machine) {
        await auditOperatorReconcile(req, {
          teamId,
          action: "identity.runtime.reconcile",
          outcome: { risk, decay, releases, geo },
        });
      }
      return reply.code(200).send({ risk, decay, releases, geo, teamId });
    },
  );
}
