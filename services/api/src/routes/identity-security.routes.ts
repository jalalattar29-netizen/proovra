/**
 * Phase 19 — Identity Security routes.
 *
 *   POST   /v1/identity-security/step-up/start              — start a challenge
 *   POST   /v1/identity-security/step-up/check              — check OTP
 *   POST   /v1/identity-security/sessions/revoke            — revoke one session
 *   POST   /v1/identity-security/sessions/revoke-all        — revoke all for a user
 *   GET    /v1/identity-security/sessions                   — list recent revocations
 *   GET    /v1/identity-security/devices?teamId             — list trusted devices
 *   POST   /v1/identity-security/devices/trust              — mark a device trusted
 *   POST   /v1/identity-security/devices/:id/revoke         — revoke a trusted device
 *   GET    /v1/identity-security/mfa-policy?teamId          — read policy
 *   PUT    /v1/identity-security/mfa-policy                 — update policy (step-up)
 *   GET    /v1/identity-security/risk/me?teamId             — my own risk snapshot
 *   GET    /v1/identity-security/risk/user/:userId          — operator-visible
 *   GET    /v1/identity-security/security-events?teamId     — Phase 19 audit window
 *   POST   /v1/identity-security/reconcile                  — cron secret
 *
 * Auth posture:
 *   - All operator routes use requireAuth (session) + Phase 17 identity
 *     access-policy gating.
 *   - 404 on non-member (anti-enumeration).
 *   - process-retries-style cron protected by INTEGRATION_CRON_SECRET
 *     (re-used from Phase 12/18; the brief allows this).
 *
 * Privacy:
 *   - No route returns OTP codes, raw phones, raw IPs, or session
 *     tokens. The verification check returns generic { status: "denied" }
 *     on any failure to avoid an oracle.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import {
  MFA_POLICY_LEVELS,
  STEP_UP_PURPOSES,
  isValidDeviceCookieValue,
  type StepUpPurpose,
} from "@proovra/shared";

import { randomBytes } from "node:crypto";

import { getAuthUserId } from "../auth.js";
import { emitPlatformAudit, emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import {
  INTEGRATION_CRON_HEADER,
  requireIntegrationCronSecret,
} from "../middleware/cron-secret.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import {
  StepUpError,
  checkStepUpChallenge,
  projectStepUpChallenge,
  startStepUpChallenge,
} from "../services/identity-security/step-up.service.js";
import {
  evaluateMfaRequirement,
  getMfaPolicy,
  updateMfaPolicy,
} from "../services/identity-security/mfa-policy.service.js";
import {
  getRiskSnapshotForUser,
} from "../services/identity-security/risk.service.js";
import {
  hashSessionId,
  listRevocationsForTeam,
  projectRevokedSession,
  revokeAllSessionsForUser,
  revokeSession,
} from "../services/identity-security/session-revocation.service.js";
import {
  listTrustedDevicesForTeam,
  markDeviceTrusted,
  projectTrustedDevice,
  revokeTrustedDevice,
} from "../services/identity-security/trusted-device.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  verifyAccountStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import { denyTeamIfNotEnterprise as denyIfTeamNotEnterprise } from "../services/enterprise-gate-resolvers.service.js";
import {
  changePasswordForUser,
  isPasswordPolicyCompliant,
} from "../services/email-password-auth.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });

/**
 * PHASE 11 §3 Batch B — D-5 personal Security Center surfaces carry NO
 * teamId (operator's own account scope; see the section comment above) →
 * genuinely GLOBAL platform events, routed through `emitPlatformAudit`.
 */
function auditIdentitySecurityEvent(
  req: FastifyRequest,
  params: {
    userId: string;
    action: string;
    outcome: "success" | "failure" | "blocked";
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
    ip: string | null;
    ua: string | null;
  },
): void {
  const outcome =
    params.outcome === "failure" ? "error" : params.outcome === "blocked" ? "denied" : "success";
  const reason = params.metadata?.["reason"];
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome !== "success" ? (typeof reason === "string" ? reason : params.action) : null,
    sourceApp: "API",
    actorUserId: params.userId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    correlationId: req.id,
    metadata: { ...(params.metadata ?? {}), ipAddress: params.ip, userAgent: params.ua },
  }).catch(() => null);
}

function requestIp(req: FastifyRequest): string | null {
  const raw = (req.ip ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function requestUa(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 512) || null;
}

/**
 * Anti-enumeration: 404 for non-members. Then permission gate against
 * the supplied identity.* permission via Phase 17 access-policy.
 */
async function requireSecurityActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission:
    | "identity.org_policy.read"
    | "identity.org_policy.manage"
    | "identity.member.read"
    | "identity.access_review.action",
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

function handleStepUpError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof StepUpError) {
    if (err.code === "feature_disabled") {
      reply.code(503).send({ error: { code: "feature_disabled" } });
      return true;
    }
    if (err.code === "invalid_phone") {
      reply.code(400).send({ error: { code: "invalid_phone" } });
      return true;
    }
    if (err.code === "rate_limited") {
      reply.code(429).send({ error: { code: "rate_limited" } });
      return true;
    }
    if (err.code === "denied" || err.code === "challenge_expired" || err.code === "challenge_not_found") {
      // Bucket every check failure into a single response shape so an
      // attacker cannot tell which exact branch failed.
      reply.code(400).send({ status: "denied" });
      return true;
    }
    reply.code(502).send({ error: { code: "provider_error" } });
    return true;
  }
  return false;
}

export async function identitySecurityRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  const StartBody = z.object({
    teamId: z.string().uuid(),
    purpose: z.enum(STEP_UP_PURPOSES as unknown as [string, ...string[]]),
    resourceKind: z.string().min(1).max(64).optional(),
    resourceId: z.string().min(1).max(128).optional(),
    phone: z.string().min(3).max(32),
    channel: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
    reason: z.string().min(1).max(400).optional(),
  });

  app.post(
    "/v1/identity-security/step-up/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = StartBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.member.read");
      if (!actor) return;
      try {
        const result = await startStepUpChallenge({
          teamId: body.teamId,
          userId: actor.userId,
          purpose: body.purpose as StepUpPurpose,
          resourceKind: body.resourceKind ?? null,
          resourceId: body.resourceId ?? null,
          phoneE164OrRaw: body.phone,
          channel: body.channel,
          reason: body.reason ?? null,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
          // PHASE 12B B3 — bind the challenge to THIS session, read from the
          // authenticated request rather than any caller-supplied field.
          sessionIdHash: req.user?.sessionIdHash ?? null,
        });
        return reply
          .code(200)
          .send({ challenge: projectStepUpChallenge(result.challenge) });
      } catch (err) {
        if (handleStepUpError(reply, err)) return;
        throw err;
      }
    },
  );

  const CheckBody = z.object({
    teamId: z.string().uuid(),
    challengeId: z.string().uuid(),
    phone: z.string().min(3).max(32),
    code: z.string().min(3).max(16),
  });

  app.post(
    "/v1/identity-security/step-up/check",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CheckBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.member.read");
      if (!actor) return;
      try {
        const result = await checkStepUpChallenge({
          teamId: body.teamId,
          userId: actor.userId,
          challengeId: body.challengeId,
          phoneE164OrRaw: body.phone,
          code: body.code,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
          // PHASE 12B B3 — the approval must come from the session that started
          // the challenge. (The former `as never` cast was hiding a stray
          // `phone` field that the input type never declared; removing the cast
          // means this call is now actually type-checked.)
          sessionIdHash: req.user?.sessionIdHash ?? null,
        });
        return reply.code(200).send({
          status: "approved",
          challenge: projectStepUpChallenge(result.challenge),
        });
      } catch (err) {
        if (handleStepUpError(reply, err)) return;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  const RevokeSessionBody = z.object({
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    sessionIdHash: z.string().min(64).max(64),
    reason: z.string().min(1).max(64).optional(),
  });

  app.post(
    "/v1/identity-security/sessions/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = RevokeSessionBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.access_review.action");
      if (!actor) return;
      if (await denyIfTeamNotEnterprise(reply, body.teamId, "sessionGovernance")) return;
      const result = await revokeSession({
        teamId: body.teamId,
        userId: body.userId,
        sessionIdHash: body.sessionIdHash,
        reason: (body.reason ?? "OPERATOR_REVOKED") as never,
        actorUserId: actor.userId,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });
      return reply.code(200).send({
        revoked: result ? projectRevokedSession(result) : null,
      });
    },
  );

  const RevokeAllBody = z.object({
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    reason: z.string().min(1).max(64).optional(),
  });

  app.post(
    "/v1/identity-security/sessions/revoke-all",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = RevokeAllBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.access_review.action");
      if (!actor) return;
      if (await denyIfTeamNotEnterprise(reply, body.teamId, "sessionGovernance")) return;
      const row = await revokeAllSessionsForUser({
        teamId: body.teamId,
        userId: body.userId,
        reason: (body.reason ?? "OPERATOR_REVOKED") as never,
        actorUserId: actor.userId,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });
      return reply.code(200).send({ revoked: projectRevokedSession(row) });
    },
  );

  app.get(
    "/v1/identity-security/sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSecurityActor(req, reply, q.teamId, "identity.member.read");
      if (!actor) return;
      if (await denyIfTeamNotEnterprise(reply, q.teamId, "sessionGovernance")) return;
      const rows = await listRevocationsForTeam({ teamId: q.teamId, limit: 100 });
      return reply
        .code(200)
        .send({ revoked: rows.map(projectRevokedSession) });
    },
  );

  // -------------------------------------------------------------------------
  // Trusted devices
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity-security/devices",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSecurityActor(req, reply, q.teamId, "identity.member.read");
      if (!actor) return;
      const rows = await listTrustedDevicesForTeam({ teamId: q.teamId });
      return reply
        .code(200)
        .send({ devices: rows.map(projectTrustedDevice) });
    },
  );

  // PHASE 12B (2026-07-30) — device trust hardening.
  //
  // DEFECTS CLOSED on this route:
  //   1. `deviceCookieValue` was a CLIENT-SUPPLIED device secret. A caller
  //      could invent any value and have the server hash it into a trusted
  //      device row, i.e. mint device trust for a device it does not hold.
  //      The correlation value is now SERVER-DERIVED from an HTTP-only
  //      cookie (minted here on first use), never accepted from the body.
  //   2. `userId` let a caller declare the SUBJECT, so an admin could mark
  //      a device "trusted" on behalf of another member — a device that
  //      member never used. Trust is now SELF-ONLY: the subject is always
  //      the authenticated actor. A body `userId` naming anyone else is
  //      concealed as 404.
  //   3. The route ran on `identity.member.read` with no step-up. It is now
  //      `identity.access_review.action` + anti-enumeration authorize +
  //      target-bound step-up.
  //
  // The cookie value never appears in a response, a URL, the DOM, or a log.
  const DEVICE_CORRELATION_COOKIE = "proovra_device_id";

  const TrustBody = z.object({
    teamId: z.string().uuid(),
    // Accepted ONLY so a caller sending the legacy field gets a bounded
    // denial instead of silently trusting a device for someone else.
    userId: z.string().uuid().optional(),
    ttlDays: z.number().int().min(1).max(180).optional(),
  });

  function readDeviceCorrelationValue(req: FastifyRequest): string | null {
    const jar = req.cookies as Record<string, string | undefined> | undefined;
    const raw = jar?.[DEVICE_CORRELATION_COOKIE];
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return isValidDeviceCookieValue(trimmed) ? trimmed : null;
  }

  app.post(
    "/v1/identity-security/devices/trust",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = TrustBody.parse(req.body ?? {});
      const authorized = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "identity.access_review.action",
        antiEnumeration: true,
      });
      if (!authorized) return;
      // SELF-ONLY subject — server-derived, never client-declared.
      if (body.userId && body.userId !== authorized.actorUserId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const targetUserId = authorized.actorUserId;
      // Server-derived device correlation value. Minted (and set as an
      // HTTP-only cookie) when the browser does not yet carry one.
      let deviceCookieValue = readDeviceCorrelationValue(req);
      let minted = false;
      if (!deviceCookieValue) {
        deviceCookieValue = randomBytes(32).toString("base64url");
        minted = true;
      }
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: authorized.actorUserId,
        // PHASE 12B — dedicated purpose. SESSION_SANITY_CHECK is the generic
        // "confirm this operator session" purpose; trusting a device suppresses
        // future prompts on it, so it gets its own auditable purpose.
        purpose: "TRUSTED_DEVICE_TRUST",
        resourceKind: "trusted_device_subject",
        resourceId: targetUserId,
      });
      if (gate.sent) return;
      const row = await markDeviceTrusted({
        teamId: body.teamId,
        userId: targetUserId,
        deviceCookieValue,
        ip: requestIp(req),
        userAgent: requestUa(req),
        ttlDays: body.ttlDays ?? null,
        actorUserId: authorized.actorUserId,
        ipAddressForAudit: requestIp(req),
        userAgentForAudit: requestUa(req),
      });
      if (minted) {
        const host = (req.headers.host ?? "").toLowerCase();
        const isProdDomain = host.includes("proovra.com");
        reply.setCookie(DEVICE_CORRELATION_COOKIE, deviceCookieValue, {
          httpOnly: true,
          secure: isProdDomain,
          sameSite: "lax",
          path: "/",
          ...(isProdDomain ? { domain: ".proovra.com" } : {}),
          maxAge: 60 * 60 * 24 * 365,
        });
      }
      return reply
        .code(200)
        .send({ device: row ? projectTrustedDevice(row) : null });
    },
  );

  app.post(
    "/v1/identity-security/devices/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid(), reason: z.string().min(1).max(400).optional() })
        .parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.access_review.action");
      if (!actor) return;
      const row = await revokeTrustedDevice({
        teamId: body.teamId,
        deviceId: id,
        actorUserId: actor.userId,
        reason: body.reason ?? null,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });
      if (!row) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ device: projectTrustedDevice(row) });
    },
  );

  // -------------------------------------------------------------------------
  // MFA policy
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity-security/mfa-policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSecurityActor(req, reply, q.teamId, "identity.org_policy.read");
      if (!actor) return;
      const policy = await getMfaPolicy(q.teamId);
      const requirement = await evaluateMfaRequirement({
        teamId: q.teamId,
        role:
          ((await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: q.teamId, userId: actor.userId } },
            select: { role: true },
          }))?.role as "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") ?? "VIEWER",
      });
      return reply.code(200).send({ policy, currentUserRequirement: requirement });
    },
  );

  const PolicyBody = z.object({
    teamId: z.string().uuid(),
    level: z.enum(MFA_POLICY_LEVELS as unknown as [string, ...string[]]),
    stepUpTtlSeconds: z.number().int().min(60).max(3600).nullable().optional(),
    trustedDeviceTtlDays: z.number().int().min(1).max(180).nullable().optional(),
  });

  app.put(
    "/v1/identity-security/mfa-policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = PolicyBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.org_policy.manage");
      if (!actor) return;
      // MFA policy update is itself a sensitive action.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: actor.userId,
        purpose: "MFA_POLICY_UPDATE",
        resourceKind: "organization_security_policy",
        resourceId: body.teamId,
      });
      if (gate.sent) return;
      const updated = await updateMfaPolicy({
        teamId: body.teamId,
        actorUserId: actor.userId,
        level: body.level as never,
        stepUpTtlSeconds: body.stepUpTtlSeconds,
        trustedDeviceTtlDays: body.trustedDeviceTtlDays,
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      });
      return reply.code(200).send({ policy: updated });
    },
  );

  // -------------------------------------------------------------------------
  // Risk snapshot
  // -------------------------------------------------------------------------

  app.get(
    "/v1/identity-security/risk/me",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const actor = await requireSecurityActor(req, reply, q.teamId, "identity.member.read");
      if (!actor) return;
      const snapshot = await getRiskSnapshotForUser({
        teamId: q.teamId,
        userId: actor.userId,
      });
      return reply.code(200).send({
        level: snapshot.level,
        score: snapshot.score,
        signalCount: snapshot.signals.length,
        // We deliberately omit signal kinds + reasons from the
        // "me" surface to avoid handing an attacker confirmation of
        // which signals fire. Operators see them via /risk/user/:id.
      });
    },
  );

  app.get(
    "/v1/identity-security/risk/user/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const q = TeamIdQuery.parse(req.query ?? {});
      // PHASE 12B — was `requireSecurityActor` (403 on permission denial,
      // and NO check that `:id` is a member of the workspace, so an
      // operator could probe an arbitrary user id's risk posture). Now:
      // anti-enumeration authorize + the target must hold an ACTIVE
      // membership in the SAME workspace, otherwise concealed 404.
      const authorized = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "identity.access_review.action",
        antiEnumeration: true,
      });
      if (!authorized) return;
      const target = await prisma.teamMember.findFirst({
        where: { teamId: q.teamId, userId: id, status: "ACTIVE" },
        select: { id: true },
      });
      if (!target) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const snapshot = await getRiskSnapshotForUser({
        teamId: q.teamId,
        userId: id,
      });
      return reply.code(200).send({
        snapshot: {
          userId: id,
          level: snapshot.level,
          score: snapshot.score,
          signals: snapshot.signals.map((s) => ({
            kind: s.kind,
            reason: s.reason,
            observedAtUtc: s.observedAtUtc.toISOString(),
            expiresAtUtc: s.expiresAtUtc?.toISOString() ?? null,
          })),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // PHASE 12B (2026-07-30) — concurrent-session POLICY IMPACT projection.
  //
  // The org security policy carries `concurrentSessionLimit` /
  // `maxSessionAgeSeconds` / `idleTimeoutSeconds`, but nothing surfaced what
  // those settings actually DO to the live session inventory. This read
  // computes the impact SERVER-SIDE (the client computes no policy
  // decision): per member, how many live sessions exist and whether that
  // member is already over the configured concurrency limit.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/identity-security/session-policy-impact",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = TeamIdQuery.parse(req.query ?? {});
      const authorized = await authorizeOrFail(req, reply, {
        teamId: q.teamId,
        permission: "identity.org_policy.read",
        antiEnumeration: true,
      });
      if (!authorized) return;
      const team = await prisma.team.findUnique({
        where: { id: q.teamId },
        select: { organizationId: true },
      });
      const policyRow = team?.organizationId
        ? await prisma.organizationSecurityPolicy.findUnique({
            where: { organizationId: team.organizationId },
            select: {
              concurrentSessionLimit: true,
              maxSessionAgeSeconds: true,
              idleTimeoutSeconds: true,
              stepUpIntervalSeconds: true,
              policyVersion: true,
            },
          })
        : null;
      const limit = policyRow?.concurrentSessionLimit ?? null;
      const now = new Date();
      const members = await prisma.teamMember.findMany({
        where: { teamId: q.teamId, status: "ACTIVE" },
        select: { userId: true, role: true },
        take: 500,
      });
      const grouped = await prisma.authenticatedSession.groupBy({
        by: ["userId"],
        where: {
          teamId: q.teamId,
          revokedAtUtc: null,
          expiresAtUtc: { gt: now },
          userId: { in: members.map((m) => m.userId) },
        },
        _count: { _all: true },
      });
      const counts = new Map<string, number>(
        grouped.map((g) => [g.userId, g._count._all]),
      );
      const rows = members
        .map((m) => {
          const activeSessionCount = counts.get(m.userId) ?? 0;
          return {
            userId: m.userId,
            role: m.role,
            activeSessionCount,
            // SERVER-side decision — the client never re-derives this.
            overLimit: limit !== null && activeSessionCount > limit,
            excessSessionCount:
              limit !== null && activeSessionCount > limit
                ? activeSessionCount - limit
                : 0,
          };
        })
        .sort((a, b) => b.activeSessionCount - a.activeSessionCount);
      return reply.code(200).send({
        policy: {
          policyProvisioned: policyRow !== null,
          policyVersion: policyRow?.policyVersion ?? 0,
          concurrentSessionLimit: limit,
          maxSessionAgeSeconds: policyRow?.maxSessionAgeSeconds ?? null,
          idleTimeoutSeconds: policyRow?.idleTimeoutSeconds ?? null,
          stepUpIntervalSeconds: policyRow?.stepUpIntervalSeconds ?? null,
        },
        membersOverLimit: rows.filter((r) => r.overLimit).length,
        impact: rows,
      });
    },
  );

  // -------------------------------------------------------------------------
  // NOTE (PHASE 12B, 2026-07-30) — contributor-session revocation
  // (`POST /v1/identity/contributor-sessions/:id/revoke`, identity.routes.ts)
  // is owned by the Identity Administration surface, including whatever
  // inventory read it needs. Deliberately NOT duplicated here so there is
  // exactly ONE contributor-session authority.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Reconcile — cron OR operator-triggered
  //
  // PHASE 12B (2026-07-30): this sweep (expire stale step-up challenges +
  // TTL-expired trusted devices) was reachable ONLY by the integration cron
  // secret, so an operator staring at a stuck runtime posture had no product
  // action. It now has TWO callers with DIFFERENT gates and identical work:
  //
  //   - CRON: presents `x-proovra-integration-cron-secret` → unchanged
  //     `requireIntegrationCronSecret` path, unchanged global sweep.
  //   - OPERATOR: no cron header → requireAuth + `authorizeOrFail`
  //     (ACTIVE membership + Organization lifecycle + `identity.org_policy.
  //     manage` + anti-enumeration) + target-bound step-up, and the sweep
  //     is SCOPED to the authorized workspace so an operator can never
  //     trigger a platform-wide mutation. The outcome is audited with both
  //     the actor and the workspace target.
  // -------------------------------------------------------------------------

  const ReconcileBody = z.object({ teamId: z.string().uuid() });

  app.post(
    "/v1/identity-security/reconcile",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const cronHeaderRaw = req.headers[INTEGRATION_CRON_HEADER];
      const cronHeader = Array.isArray(cronHeaderRaw)
        ? cronHeaderRaw[0]
        : cronHeaderRaw;
      const isCronCaller =
        typeof cronHeader === "string" && cronHeader.trim().length > 0;

      let operator: { actorUserId: string; teamId: string } | null = null;
      if (isCronCaller) {
        const ok = await requireIntegrationCronSecret(req, reply);
        if (!ok) return;
      } else {
        await requireAuth(req, reply);
        if (reply.sent) return;
        const body = ReconcileBody.parse(req.body ?? {});
        operator = await authorizeOrFail(req, reply, {
          teamId: body.teamId,
          permission: "identity.org_policy.manage",
          antiEnumeration: true,
        });
        if (!operator) return;
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: operator.teamId,
          userId: operator.actorUserId,
          // PHASE 12B — dedicated purpose: an operator-triggered reconcile
          // sweep mutates rows in bulk, so it is not a generic session check.
          purpose: "IDENTITY_RUNTIME_RECONCILE",
          resourceKind: "workspace_identity_runtime",
          resourceId: operator.teamId,
        });
        if (gate.sent) return;
      }
      const scopeTeamId = operator?.teamId ?? null;
      const now = new Date();
      // Both sweeps run in ONE transaction so a failure between them can
      // never leave a half-reconciled runtime.
      const [expiredStepUps, expiredDevices] = await prisma.$transaction(
        async (tx) => {
          // 1. Expire step-up challenges past their TTL.
          const stepUps = await tx.stepUpChallenge.updateMany({
            where: {
              status: prismaPkg.StepUpChallengeStatus.PENDING,
              expiresAtUtc: { lte: now },
              ...(scopeTeamId ? { teamId: scopeTeamId } : {}),
            },
            data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
          });
          // 2. Expire trusted devices past trustedUntilUtc.
          const devices = await tx.trustedDevice.updateMany({
            where: {
              status: prismaPkg.TrustedDeviceStatus.ACTIVE,
              trustedUntilUtc: { lte: now },
              ...(scopeTeamId ? { teamId: scopeTeamId } : {}),
            },
            data: {
              status: prismaPkg.TrustedDeviceStatus.REVOKED,
              revokedAtUtc: now,
              revokedReason: "ttl_expired",
            },
          });
          return [stepUps, devices] as const;
        },
      );
      if (operator) {
        await emitTenantAudit({
          action: "identity_security.runtime.reconcile",
          outcome: "success",
          sourceApp: "API",
          actorUserId: operator.actorUserId,
          workspaceId: operator.teamId,
          resourceType: "workspace_identity_runtime",
          resourceId: operator.teamId,
          metadata: {
            trigger: "operator",
            targetWorkspaceId: operator.teamId,
            expiredStepUps: expiredStepUps.count,
            expiredDevices: expiredDevices.count,
            ipAddress: requestIp(req),
            userAgent: requestUa(req),
          },
        });
      }
      return reply.code(200).send({
        scope: scopeTeamId === null ? "platform_cron" : "workspace",
        expiredStepUps: expiredStepUps.count,
        expiredDevices: expiredDevices.count,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // D-5 closure — Security Center personal surfaces.
  //
  //   POST /v1/identity-security/password           — change password (rate-limited)
  //   GET  /v1/identity-security/my-sessions        — list current user's active sessions
  //   POST /v1/identity-security/my-sessions/revoke-others
  //                                                 — revoke every session except the current one
  //   GET  /v1/identity-security/security-events    — security-events feed for current user
  //
  // None of these endpoints require a teamId (operator's own scope).
  // All emit platform audit log rows in the "identity_security"
  // category so they are visible in the audit center.
  // ---------------------------------------------------------------------------

  const ChangePasswordBody = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
    revokeOtherSessions: z.boolean().optional(),
  });

  app.post(
    "/v1/identity-security/password",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const ip = requestIp(req);
      const ua = requestUa(req);

      // Two rate-limit buckets: per-user (defend against guess) and
      // per-IP (defend against a compromised endpoint trying many
      // accounts). Both are bounded at 5/min — generous enough for
      // legitimate retry / paste-mistake, tight enough that a brute
      // force can't burn through ~scrypt evaluations.
      const userRl = await enforceRateLimit({
        key: `identity-security:password-change:user:${userId}`,
        max: 5,
        windowSec: 60,
      });
      if (!userRl.allowed) {
        auditIdentitySecurityEvent(req, {
          userId,
          action: "identity_security.password_change",
          outcome: "blocked",
          resourceType: "user",
          resourceId: userId,
          metadata: { reason: "rate_limited_user" },
          ip,
          ua,
        });
        return reply.code(429).send({ error: { code: "rate_limited" } });
      }
      const ipRl = await enforceRateLimit({
        key: `identity-security:password-change:ip:${ip ?? "unknown"}`,
        max: 30,
        windowSec: 60,
      });
      if (!ipRl.allowed) {
        return reply.code(429).send({ error: { code: "rate_limited" } });
      }

      const body = ChangePasswordBody.parse(req.body ?? {});

      // Quick policy preflight so we can return a precise error
      // before doing the scrypt round-trip in the service.
      if (!isPasswordPolicyCompliant(body.newPassword)) {
        auditIdentitySecurityEvent(req, {
          userId,
          action: "identity_security.password_change",
          outcome: "failure",
          resourceType: "user",
          resourceId: userId,
          metadata: { reason: "weak_new_password" },
          ip,
          ua,
        });
        return reply
          .code(400)
          .send({ error: { code: "weak_new_password" } });
      }

      const result = await changePasswordForUser({
        userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });

      if (!result.ok) {
        auditIdentitySecurityEvent(req, {
          userId,
          action: "identity_security.password_change",
          outcome: "failure",
          resourceType: "user",
          resourceId: userId,
          metadata: { reason: result.reason },
          ip,
          ua,
        });

        // For `current_password_mismatch` we return a generic 400 so
        // the caller cannot use the response shape as an oracle for
        // which exact failure branch fired. For policy issues we are
        // explicit because the operator NEEDS the feedback.
        if (
          result.reason === "current_password_mismatch" ||
          result.reason === "user_not_found"
        ) {
          return reply
            .code(400)
            .send({ error: { code: "current_password_invalid" } });
        }
        if (result.reason === "not_email_user") {
          return reply
            .code(400)
            .send({ error: { code: "sso_user_password_unsupported" } });
        }
        if (result.reason === "no_password_set") {
          return reply
            .code(400)
            .send({ error: { code: "no_password_set" } });
        }
        if (result.reason === "same_as_current") {
          return reply
            .code(400)
            .send({ error: { code: "same_as_current" } });
        }
        return reply
          .code(400)
          .send({ error: { code: "weak_new_password" } });
      }

      // Optional fan-out: revoke every other session for this user.
      // The current session stays valid so the caller doesn't get
      // logged out of the page they used to change the password.
      let revokedOtherSessions = 0;
      if (body.revokeOtherSessions) {
        const currentHash =
          (req as unknown as { sessionIdHash?: string }).sessionIdHash ?? null;
        const where: {
          userId: string;
          revokedAtUtc: null;
          NOT?: { sessionIdHash: string };
        } = { userId, revokedAtUtc: null };
        if (currentHash) where.NOT = { sessionIdHash: currentHash };
        const upd = await prisma.authenticatedSession.updateMany({
          where,
          data: {
            revokedAtUtc: new Date(),
            revokedByUserId: userId,
            revokedReason: "PASSWORD_CHANGED",
          },
        });
        revokedOtherSessions = upd.count;
      }

      auditIdentitySecurityEvent(req, {
        userId,
        action: "identity_security.password_change",
        outcome: "success",
        resourceType: "user",
        resourceId: userId,
        metadata: {
          revokeOtherSessions: Boolean(body.revokeOtherSessions),
          revokedOtherSessionsCount: revokedOtherSessions,
        },
        ip,
        ua,
      });

      return reply.code(200).send({
        ok: true,
        revokedOtherSessions,
      });
    },
  );

  app.get(
    "/v1/identity-security/my-sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const now = new Date();
      const rows = await prisma.authenticatedSession.findMany({
        where: {
          userId,
          revokedAtUtc: null,
          expiresAtUtc: { gt: now },
        },
        orderBy: { lastSeenAtUtc: "desc" },
        take: 50,
        select: {
          id: true,
          sessionIdHash: true,
          issuedAtUtc: true,
          expiresAtUtc: true,
          lastSeenAtUtc: true,
          ipPreview: true,
          uaPreview: true,
          ssoConnectionId: true,
          countryCode: true,
          quarantinedAtUtc: true,
        },
      });
      const currentHash =
        (req as unknown as { sessionIdHash?: string }).sessionIdHash ?? null;
      return reply.code(200).send({
        sessions: rows.map((r) => ({
          id: r.id,
          // PHASE 12B — `sessionIdHash` REMOVED from the projection. It is
          // HMAC session-correlation material; the row `id` is the stable
          // handle every product action (my-sessions/:id/revoke) uses, so
          // the hash never needs to reach a client, the DOM, or a log.
          isCurrent: currentHash !== null && currentHash === r.sessionIdHash,
          issuedAtUtc: r.issuedAtUtc.toISOString(),
          expiresAtUtc: r.expiresAtUtc.toISOString(),
          lastSeenAtUtc: r.lastSeenAtUtc.toISOString(),
          ipPreview: r.ipPreview,
          uaPreview: r.uaPreview,
          countryCode: r.countryCode,
          ssoConnectionId: r.ssoConnectionId,
          quarantined: r.quarantinedAtUtc !== null,
        })),
      });
    },
  );

  app.post(
    "/v1/identity-security/my-sessions/revoke-others",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      // Step-up (2026-07-16): terminating every other session is a
      // sensitive account mutation — backend-enforced re-auth required
      // (password / current MFA code / recent OAuth sign-in).
      const stepUpBody = (req.body ?? {}) as { stepUp?: AccountStepUpProof };
      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "sessions_revoke_others",
        proof: stepUpBody.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }
      const currentHash =
        (req as unknown as { sessionIdHash?: string }).sessionIdHash ?? null;
      const where: {
        userId: string;
        revokedAtUtc: null;
        NOT?: { sessionIdHash: string };
      } = { userId, revokedAtUtc: null };
      if (currentHash) where.NOT = { sessionIdHash: currentHash };
      const upd = await prisma.authenticatedSession.updateMany({
        where,
        data: {
          revokedAtUtc: new Date(),
          revokedByUserId: userId,
          revokedReason: "SELF_REVOKE_OTHERS",
        },
      });
      auditIdentitySecurityEvent(req, {
        userId,
        action: "identity_security.self_revoke_others",
        outcome: "success",
        resourceType: "user",
        resourceId: userId,
        metadata: { revoked: upd.count },
        ip: requestIp(req),
        ua: requestUa(req),
      });
      return reply.code(200).send({ revoked: upd.count });
    },
  );

  // POST /v1/identity-security/my-sessions/:id/revoke
  //
  // Settings remediation (2026-07-17) — revoke ONE of the caller's OWN
  // other sessions. Strictly user-bound; the CURRENT session is never
  // revocable through this route (sign-out is the product action for
  // that). Step-up enforced like every sensitive session mutation.
  app.post<{ Params: { id: string } }>(
    "/v1/identity-security/my-sessions/:id/revoke",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const stepUpBody = (req.body ?? {}) as { stepUp?: AccountStepUpProof };
      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "session_revoke",
        proof: stepUpBody.stepUp,
      });
      if (!stepUp.ok) {
        return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      }
      const currentHash =
        (req as unknown as { sessionIdHash?: string }).sessionIdHash ?? null;
      const target = await prisma.authenticatedSession.findFirst({
        where: { id: params.id, userId, revokedAtUtc: null },
        select: { id: true, sessionIdHash: true },
      });
      if (!target) {
        return reply.code(404).send({ error: { code: "session_not_found" } });
      }
      if (currentHash !== null && target.sessionIdHash === currentHash) {
        return reply.code(409).send({
          error: {
            code: "current_session_not_revocable",
            message: "Sign out to end your current session.",
          },
        });
      }
      await prisma.authenticatedSession.update({
        where: { id: target.id },
        data: {
          revokedAtUtc: new Date(),
          revokedByUserId: userId,
          revokedReason: "SELF_REVOKE_SINGLE",
        },
      });
      auditIdentitySecurityEvent(req, {
        userId,
        action: "identity_security.self_revoke_session",
        outcome: "success",
        resourceType: "authenticated_session",
        resourceId: target.id,
        metadata: {},
        ip: requestIp(req),
        ua: requestUa(req),
      });
      return reply.code(200).send({ revoked: 1 });
    },
  );

  app.get(
    "/v1/identity-security/security-events",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const Limit = z.coerce.number().int().min(1).max(200).default(50);
      const limit = Limit.parse((req.query as { limit?: unknown })?.limit ?? 50);

      // The security-events feed is the bounded operator-readable
      // window into the platform audit log for the current user.
      // We restrict to identity_security / auth / billing categories
      // and to the bounded action allowlist below — categories like
      // "evidence" don't belong on a security center timeline.
      const SECURITY_ACTIONS_PREFIX = [
        "identity_security.",
        "auth.",
        "identity.",
      ];

      const rows = await prisma.adminAuditLog.findMany({
        where: {
          userId,
          OR: SECURITY_ACTIONS_PREFIX.map((p) => ({
            action: { startsWith: p },
          })),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          action: true,
          severity: true,
          outcome: true,
          createdAt: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          // ip / ua previews — read from the audit log columns
          // (these are already truncated by the audit writer).
          ipAddress: true,
          userAgent: true,
        },
      });

      return reply.code(200).send({
        events: rows.map((r) => ({
          id: r.id,
          action: r.action,
          severity: r.severity,
          outcome: r.outcome,
          occurredAtUtc: r.createdAt.toISOString(),
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          ipPreview: r.ipAddress ? r.ipAddress.slice(0, 16) : null,
          uaPreview: r.userAgent ? r.userAgent.slice(0, 80) : null,
          metadata: r.metadata,
        })),
      });
    },
  );

  // Quiet TS-unused warnings — `hashSessionId` is exported for the test
  // suite and as a stable surface for other modules that might want to
  // pre-compute a hash for the revoke route.
  void hashSessionId;
}
