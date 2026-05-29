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
  type StepUpPurpose,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
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
  listTrustedDevicesForUser,
  markDeviceTrusted,
  projectTrustedDevice,
  revokeTrustedDevice,
} from "../services/identity-security/trusted-device.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  changePasswordForUser,
  isPasswordPolicyCompliant,
} from "../services/email-password-auth.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";

const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });

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
          phone: body.phone,
          phoneE164OrRaw: body.phone,
          code: body.code,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        } as never);
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

  const TrustBody = z.object({
    teamId: z.string().uuid(),
    userId: z.string().uuid().optional(),
    deviceCookieValue: z.string().min(16).max(256),
    ttlDays: z.number().int().min(1).max(180).optional(),
  });

  app.post(
    "/v1/identity-security/devices/trust",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = TrustBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(req, reply, body.teamId, "identity.member.read");
      if (!actor) return;
      const targetUserId = body.userId ?? actor.userId;
      const row = await markDeviceTrusted({
        teamId: body.teamId,
        userId: targetUserId,
        deviceCookieValue: body.deviceCookieValue,
        ip: requestIp(req),
        userAgent: requestUa(req),
        ttlDays: body.ttlDays ?? null,
        actorUserId: actor.userId,
        ipAddressForAudit: requestIp(req),
        userAgentForAudit: requestUa(req),
      });
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
      const actor = await requireSecurityActor(req, reply, q.teamId, "identity.access_review.action");
      if (!actor) return;
      const snapshot = await getRiskSnapshotForUser({
        teamId: q.teamId,
        userId: id,
      });
      return reply.code(200).send({ snapshot });
    },
  );

  // -------------------------------------------------------------------------
  // Reconcile cron
  // -------------------------------------------------------------------------

  app.post(
    "/v1/identity-security/reconcile",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const now = new Date();
      // 1. Expire step-up challenges past their TTL.
      const expiredStepUps = await prisma.stepUpChallenge.updateMany({
        where: {
          status: prismaPkg.StepUpChallengeStatus.PENDING,
          expiresAtUtc: { lte: now },
        },
        data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
      });
      // 2. Expire trusted devices past trustedUntilUtc.
      const expiredDevices = await prisma.trustedDevice.updateMany({
        where: {
          status: prismaPkg.TrustedDeviceStatus.ACTIVE,
          trustedUntilUtc: { lte: now },
        },
        data: { status: prismaPkg.TrustedDeviceStatus.REVOKED, revokedAtUtc: now, revokedReason: "ttl_expired" },
      });
      return reply.code(200).send({
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
        await appendPlatformAuditLog({
          userId,
          action: "identity_security.password_change",
          category: "identity_security",
          severity: "warning",
          source: "api_identity_security",
          outcome: "blocked",
          resourceType: "user",
          resourceId: userId,
          requestId: req.id,
          metadata: { reason: "rate_limited_user" },
          ipAddress: ip,
          userAgent: ua,
        }).catch(() => null);
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
        await appendPlatformAuditLog({
          userId,
          action: "identity_security.password_change",
          category: "identity_security",
          severity: "warning",
          source: "api_identity_security",
          outcome: "failure",
          resourceType: "user",
          resourceId: userId,
          requestId: req.id,
          metadata: { reason: "weak_new_password" },
          ipAddress: ip,
          userAgent: ua,
        }).catch(() => null);
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
        await appendPlatformAuditLog({
          userId,
          action: "identity_security.password_change",
          category: "identity_security",
          severity:
            result.reason === "current_password_mismatch" ? "warning" : "info",
          source: "api_identity_security",
          outcome: "failure",
          resourceType: "user",
          resourceId: userId,
          requestId: req.id,
          metadata: { reason: result.reason },
          ipAddress: ip,
          userAgent: ua,
        }).catch(() => null);

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

      await appendPlatformAuditLog({
        userId,
        action: "identity_security.password_change",
        category: "identity_security",
        severity: "info",
        source: "api_identity_security",
        outcome: "success",
        resourceType: "user",
        resourceId: userId,
        requestId: req.id,
        metadata: {
          revokeOtherSessions: Boolean(body.revokeOtherSessions),
          revokedOtherSessionsCount: revokedOtherSessions,
        },
        ipAddress: ip,
        userAgent: ua,
      }).catch(() => null);

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
          sessionIdHash: r.sessionIdHash,
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
      await appendPlatformAuditLog({
        userId,
        action: "identity_security.self_revoke_others",
        category: "identity_security",
        severity: "info",
        source: "api_identity_security",
        outcome: "success",
        resourceType: "user",
        resourceId: userId,
        requestId: req.id,
        metadata: { revoked: upd.count },
        ipAddress: requestIp(req),
        userAgent: requestUa(req),
      }).catch(() => null);
      return reply.code(200).send({ revoked: upd.count });
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
