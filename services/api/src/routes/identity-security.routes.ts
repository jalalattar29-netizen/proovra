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

  // Quiet TS-unused warnings — `hashSessionId` is exported for the test
  // suite and as a stable surface for other modules that might want to
  // pre-compute a hash for the revoke route.
  void hashSessionId;
}
