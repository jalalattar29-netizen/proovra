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
            err.code === "SSO_INVALID_PROVIDER"
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
      return reply.code(200).send({ providers });
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

  app.get(
    "/v1/admin/identity/role-matrix",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireIdentityAdmin(req, reply, q.teamId);
      if (!actor) return;
      const matrix = computeEffectiveRoleMatrix();
      return reply.code(200).send({ matrix });
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
      const actor = await requireIdentityAdmin(
        req,
        reply,
        body.teamId,
        "identity.capability.grant",
      );
      if (!actor) return;
      // Phase 26.75 — runtime adaptive gate.
      const runtimeGateElev = await runtimeAdaptiveGate({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        action: "RBAC_TEMPORARY_ELEVATION",
      });
      if (!runtimeGateElev.allow) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
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
          grantedByUserId: actor.userId,
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
      const projection = await revokeActiveSession({
        teamId: body.teamId,
        sessionId: id,
        actorUserId: actor.userId,
        reason: body.reason as SessionRevocationReason | undefined,
      });
      if (!projection) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ projection });
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
    async (req: FastifyRequest, reply: FastifyReply) => {
      const expected =
        process.env["IDENTITY_RECONCILE_CRON_SECRET"] ||
        process.env["INTEGRATION_CRON_SECRET"] ||
        "";
      const got = req.headers["x-cron-secret"];
      if (
        !expected ||
        typeof got !== "string" ||
        got.length === 0 ||
        got !== expected
      ) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }
      const body = z
        .object({
          teamId: z.string().uuid(),
          staleMinutes: z.number().int().min(1).max(1440).optional(),
          batchSize: z.number().int().min(1).max(1000).optional(),
        })
        .parse(req.body ?? {});
      const result = await sweepStaleSessions({
        teamId: body.teamId,
        staleMinutes: body.staleMinutes,
        batchSize: body.batchSize,
        revoke: true,
      });
      // Also sweep stale OIDC callback attempts.
      const callbackSweep = await sweepStaleCallbackAttempts({});
      // Refresh the high-risk-sessions gauge.
      await refreshHighRiskSessionGauge({ teamId: body.teamId });
      return reply.code(200).send({
        sessions: result,
        callbackAttempts: callbackSweep,
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
    async (req: FastifyRequest, reply: FastifyReply) => {
      const expected =
        process.env["IDENTITY_RECONCILE_CRON_SECRET"] ||
        process.env["INTEGRATION_CRON_SECRET"] ||
        "";
      const got = req.headers["x-cron-secret"];
      if (
        !expected ||
        typeof got !== "string" ||
        got.length === 0 ||
        got !== expected
      ) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }
      const body = z
        .object({
          teamId: z.string().uuid(),
          recomputeWindowMinutes: z
            .number()
            .int()
            .min(5)
            .max(360)
            .optional(),
          decayStaleDays: z.number().int().min(1).max(180).optional(),
        })
        .parse(req.body ?? {});
      const [risk, decay, releases, geo] = await Promise.all([
        runtimeRiskRecomputeSweep({
          teamId: body.teamId,
          recomputeWindowMinutes: body.recomputeWindowMinutes,
        }),
        sweepTrustedDeviceDecay({
          teamId: body.teamId,
          staleDays: body.decayStaleDays,
        }),
        sweepQuarantineReleases({ teamId: body.teamId }),
        sweepGeoCache(),
      ]);
      return reply.code(200).send({ risk, decay, releases, geo });
    },
  );
}
