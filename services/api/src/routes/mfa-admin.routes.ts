/**
 * PHASE R8.1.4 — Admin MFA lifecycle + lost-factor recovery routes.
 *
 * Endpoints (ALL under `/v1/identity/mfa-admin/*` — kept distinct
 * from R8.1.1's user-self `/v1/identity/mfa/*` so admin actions
 * vs user-self actions are unambiguous in operator logs):
 *
 *   GET  /v1/identity/mfa-admin/posture/:teamId/:userId
 *        Read-only MFA posture for a target user under a team scope.
 *
 *   POST /v1/identity/mfa-admin/factors/:teamId/:userId/:factorId/revoke
 *        Revoke a single user factor.
 *
 *   POST /v1/identity/mfa-admin/factors/:teamId/:userId/require-reenrollment
 *        Revoke ALL of a user's active factors atomically.
 *
 *   POST /v1/identity/mfa-admin/trusted-devices/:teamId/:userId/reset
 *        Revoke every trusted device the user has under the team.
 *
 *   GET  /v1/identity/mfa-admin/events/:teamId
 *        Recent MFA security events for the team.
 *
 *   GET  /v1/identity/mfa-admin/recovery-requests/:teamId
 *        Pending lost-factor recovery requests (admin queue).
 *
 *   POST /v1/identity/mfa-admin/recovery-requests/:requestId/approve
 *        Record an admin approval. When quorum reached the request
 *        flips to APPROVED AND the target's factors are revoked
 *        atomically.
 *
 *   POST /v1/identity/mfa-admin/recovery-requests/:requestId/reject
 *        Reject a pending request with a bounded reason.
 *
 *   POST /v1/identity/mfa-admin/recovery-requests
 *        USER-facing — a logged-in user requests recovery for one of
 *        their own teams. Subject-of-action MUST equal the actor.
 *
 * Hard rules (enforced by the underlying services):
 *   - The acting user MUST be an ACTIVE OWNER/ADMIN of the team
 *     scope for ALL admin actions (factors/devices/events/recovery
 *     approval/reject). Cross-team actions are refused.
 *   - The actor MUST present a valid canonical session
 *     (`requireAuth`); no admin path is reachable without one.
 *   - The acting user CANNOT approve their own recovery request
 *     (no self-approval).
 *   - NO endpoint returns OTP / recovery code / secret material /
 *     signed token. The most sensitive thing returned is a count
 *     plus a bounded status enum.
 *   - NO endpoint disables MFA in a way that lets the admin log in
 *     as the user; revoking factors only forces the user through
 *     the enrollment-required path on their NEXT primary-credential
 *     login.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { assertTeamAllowsEnterpriseFeature } from "../services/billing-enforcement.service.js";
import { getSecret } from "../config/runtime-secrets.js";
import { getAuthUserId } from "../auth.js";
import { AppError, ErrorCode } from "../errors.js";
import { prisma } from "../db.js";
import {
  listRecentMfaEvents,
  readUserMfaPosture,
  requireUserReenrollment,
  resetTrustedDevicesForUser,
  revokeUserFactor,
  type MfaAdminScopeFailure,
} from "../services/security/mfa-admin-lifecycle.service.js";
import {
  approveRecoveryRequest,
  cancelRecoveryRequest,
  createRecoveryRequest,
  listPendingRecoveryRequests,
  listRecoveryRequestApprovals,
  readRecoveryRequestDetail,
  rejectRecoveryRequest,
  resendRecoveryRequestEmail,
  verifyRecoveryRequestEmail,
} from "../services/security/mfa-recovery-request.service.js";
import {
  getMfaPolicy,
  updateMfaPolicyVersioned,
  MfaPolicyVersionConflictError,
  type ResolvedMfaPolicy,
} from "../services/identity-security/mfa-policy.service.js";
import {
  listDigestPreferences,
  updateDigestPreference,
} from "../services/security/mfa-digest-preference.service.js";
import { previewDigestForAdmin } from "../services/security/mfa-recovery-digest-preview.service.js";
import { readRecoveryEventFeed } from "../services/security/mfa-recovery-event-feed.service.js";
import {
  listTrustedDevicesForUser,
  projectTrustedDevice,
} from "../services/identity-security/trusted-device.service.js";
import {
  signMfaDigestSnoozeToken,
  verifyMfaDigestSnoozeToken,
  MFA_DIGEST_SNOOZE_TTL_SECONDS,
} from "../services/security/mfa-digest-snooze-token.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { verifyJwt } from "../services/jwt.js";
import {
  projectSecurityEventDetails,
  safeEmitSecurityEvent,
} from "../services/security/security-event.service.js";
import { getEmailService } from "../services/email.service.js";
import {
  absoluteInternalUrl,
  internalNavPath,
  MfaPolicyLevelSchema,
} from "@proovra/shared";

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

/**
 * PHASE R8.1.7 — best-effort session detection for endpoints that
 * are intentionally unauthenticated (e.g. the email-link verify
 * route). Returns the session's userId when the caller happens
 * to be signed in, otherwise `null`. NEVER throws — the route
 * proceeds either way.
 */
function readOptionalSessionUserId(req: FastifyRequest): string | null {
  try {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const cookieToken =
      (req.cookies as { proovra_session?: string } | undefined)
        ?.proovra_session ?? null;
    const token = bearer || cookieToken;
    if (!token) return null;
    const secret = getSecret("AUTH_JWT_SECRET");
    if (!secret) return null;
    const payload = verifyJwt(token, secret);
    // Pending tokens never carry session authority — refuse them
    // here too so a pending token cannot satisfy the optional
    // identity check.
    if (payload.mfa === "pending") return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function mapScopeFailure(reason: MfaAdminScopeFailure): {
  code: number;
  message: string;
} {
  switch (reason) {
    case "admin_not_in_team":
      return { code: 403, message: "admin_not_in_team" };
    case "admin_not_admin":
      return { code: 403, message: "admin_not_admin" };
    case "target_not_in_team":
      return { code: 404, message: "target_not_in_team" };
  }
}

/**
 * PHASE 12B (2026-07-30) — SERVER-AUTHORIZED workspace scope for the
 * `/v1/identity/mfa-admin/*` surface.
 *
 * DEFECT CLOSED: these routes carry `:teamId` (and `:userId`) in the PATH,
 * so before this pass the CLIENT declared the tenant and the only thing
 * standing between an attacker and another Organization's MFA posture was
 * the service-level `assertAdminCanAct` membership lookup — which answers
 * with DISTINGUISHABLE 403 (`admin_not_in_team`) vs 404
 * (`target_not_in_team`) codes and therefore ENUMERATES workspaces and
 * memberships. The path SHAPE is unchanged (other consumers/tests
 * reference it); the ENFORCEMENT is now:
 *
 *   1. `authorizeOrFail` with `antiEnumeration: true` — ACTIVE membership,
 *      Organization lifecycle, capability, audit emission, fail-closed.
 *      A teamId belonging to another Organization returns 404 not_found.
 *   2. OWNER/ADMIN-only narrowing (the identity.* capabilities are not
 *      admin-exclusive) — concealed as 404, never 403.
 *   3. The TARGET userId must hold an ACTIVE membership in the SAME
 *      workspace — otherwise concealed 404.
 *
 * Every denial from this helper is the SAME 404 body, so an outside caller
 * cannot tell "team does not exist" from "you are not an admin of it" from
 * "that user is not a member".
 */
async function authorizeMfaAdminScope(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: {
    teamId: string;
    permission:
      | "identity.org_policy.read"
      | "identity.org_policy.manage"
      | "identity.access_review.action";
    targetUserId?: string | null;
  },
): Promise<{ actorUserId: string; teamId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId: opts.teamId,
    permission: opts.permission,
    antiEnumeration: true,
  });
  if (!outcome) return null;
  const conceal = () => {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  };
  const actorMembership = await prisma.teamMember.findFirst({
    where: {
      teamId: opts.teamId,
      userId: outcome.actorUserId,
      status: "ACTIVE",
    },
    select: { role: true },
  });
  if (
    !actorMembership ||
    (actorMembership.role !== "OWNER" && actorMembership.role !== "ADMIN")
  ) {
    return conceal();
  }
  if (opts.targetUserId) {
    const target = await prisma.teamMember.findFirst({
      where: {
        teamId: opts.teamId,
        userId: opts.targetUserId,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!target) return conceal();
  }
  return outcome;
}

/**
 * PHASE 12B — SAFE factor projection for the admin posture surface.
 * The operator needs a factor id to revoke a single factor; the row also
 * carries the AES-GCM envelope (`secretCiphertext` / `secretIv` /
 * `secretAuthTag` / `secretKekId`). Those columns are NEVER selected here,
 * so they cannot reach a response, a log, or the DOM.
 */
async function listSafeFactorsForTarget(userId: string): Promise<
  Array<{
    id: string;
    kind: string;
    status: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>
> {
  const rows = await prisma.mfaFactor.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      kind: true,
      status: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: String(r.kind),
    status: String(r.status),
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

const TeamUserParams = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
});
const TeamUserFactorParams = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  factorId: z.string().uuid(),
});
const TeamParams = z.object({ teamId: z.string().uuid() });
const RequestIdParams = z.object({ requestId: z.string().uuid() });

const RevokeFactorBody = z.object({
  reason: z.string().trim().min(3).max(120),
});
const RequireReenrollBody = z.object({
  reason: z.string().trim().min(3).max(120),
});
const ResetTrustedDevicesBody = z.object({
  reason: z.string().trim().min(3).max(200),
});
const CreateRecoveryRequestBody = z.object({
  teamId: z.string().uuid(),
  reason: z.string().trim().min(10).max(400),
});
const RejectRecoveryRequestBody = z.object({
  reason: z.string().trim().max(400).optional(),
});
const VerifyEmailBody = z.object({
  // 64-hex SHA-256 token. We accept the slightly relaxed 16+ chars
  // here so future token shapes don't break the schema; the service
  // does the actual constant-time compare against the row's hash.
  token: z.string().trim().min(16).max(128),
});
const PatchPolicyBody = z.object({
  // PHASE 12B — optimistic concurrency. The client MUST send the
  // `policyVersion` it read; the value becomes part of the ATOMIC database
  // mutation predicate (see `updateMfaPolicyVersioned`). A stale value
  // mutates NOTHING and returns 409.
  expectedPolicyVersion: z.number().int().min(0),
  level: MfaPolicyLevelSchema,
  stepUpTtlSeconds: z.number().int().min(60).max(3600).optional(),
  trustedDeviceTtlDays: z.number().int().min(1).max(180).optional(),
  mfaEnforcementFailMode: z
    .enum(["SMART", "FAIL_OPEN", "FAIL_CLOSED"])
    .nullable()
    .optional(),
});

// PHASE R8.1.7 — admin digest preference body. teamId is OPTIONAL —
// when omitted the global preference (no team scope) is written.
// digestEnabled and suppressUntil are individually optional so the
// route supports partial-update semantics.
const PatchDigestPreferenceBody = z.object({
  teamId: z.string().uuid().nullable().optional(),
  digestEnabled: z.boolean().optional(),
  suppressUntil: z.string().datetime().nullable().optional(),
});

export async function mfaAdminRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // Read posture
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/posture/:teamId/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamUserParams.parse(req.params);
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.org_policy.read",
        targetUserId: params.userId,
      });
      if (!scope) return;
      const result = await readUserMfaPosture({
        teamId: params.teamId,
        actorUserId: scope.actorUserId,
        targetUserId: params.userId,
      });
      if (!result.ok) {
        // The scope was already server-authorized above; any residual
        // service-level refusal is concealed identically.
        reply.code(404);
        return { error: { code: "not_found" } };
      }
      return {
        posture: result.posture,
        factors: await listSafeFactorsForTarget(params.userId),
        trustedDevices: (
          await listTrustedDevicesForUser({
            teamId: params.teamId,
            userId: params.userId,
          })
        ).map(projectTrustedDevice),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Revoke a single factor
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/factors/:teamId/:userId/:factorId/revoke",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamUserFactorParams.parse(req.params);
      const body = RevokeFactorBody.parse(req.body ?? {});
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.access_review.action",
        targetUserId: params.userId,
      });
      if (!scope) return;
      // TARGET-BOUND step-up: the challenge is bound to the exact factor
      // being revoked, so an approval for factor A can never satisfy a
      // revoke of factor B.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: params.teamId,
        userId: scope.actorUserId,
        // PHASE 12B — dedicated purpose. Borrowing MFA_POLICY_UPDATE meant a
        // challenge approved to change the workspace policy could also be spent
        // to revoke a specific member's factor.
        purpose: "MFA_FACTOR_REVOKE",
        resourceKind: "mfa_factor",
        resourceId: params.factorId,
      });
      if (gate.sent) return;
      const result = await revokeUserFactor({
        teamId: params.teamId,
        actorUserId: scope.actorUserId,
        targetUserId: params.userId,
        factorId: params.factorId,
        reason: body.reason,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        // Every refusal (missing factor, already-revoked factor, residual
        // scope refusal) collapses to one concealed 404.
        reply.code(404);
        return { error: { code: "not_found" } };
      }
      return { ok: true, targetUserId: params.userId, factorId: params.factorId };
    },
  );

  // ---------------------------------------------------------------------------
  // Require re-enrollment (revoke ALL active factors)
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/factors/:teamId/:userId/require-reenrollment",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamUserParams.parse(req.params);
      const body = RequireReenrollBody.parse(req.body ?? {});
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.access_review.action",
        targetUserId: params.userId,
      });
      if (!scope) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: params.teamId,
        userId: scope.actorUserId,
        // PHASE 12B — dedicated purpose (see the factor-revoke note above).
        purpose: "MFA_REENROLLMENT_REQUIRE",
        resourceKind: "user",
        resourceId: params.userId,
      });
      if (gate.sent) return;
      const result = await requireUserReenrollment({
        teamId: params.teamId,
        actorUserId: scope.actorUserId,
        targetUserId: params.userId,
        reason: body.reason,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        reply.code(404);
        return { error: { code: "not_found" } };
      }
      return {
        ok: true,
        targetUserId: params.userId,
        revokedFactorCount: result.revokedFactorCount,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Reset trusted devices
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/trusted-devices/:teamId/:userId/reset",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamUserParams.parse(req.params);
      const body = ResetTrustedDevicesBody.parse(req.body ?? {});
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.access_review.action",
        targetUserId: params.userId,
      });
      if (!scope) return;
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: params.teamId,
        userId: scope.actorUserId,
        // PHASE 12B — dedicated purpose (see the factor-revoke note above).
        purpose: "MFA_TRUSTED_DEVICE_RESET",
        resourceKind: "user_trusted_devices",
        resourceId: params.userId,
      });
      if (gate.sent) return;
      const result = await resetTrustedDevicesForUser({
        teamId: params.teamId,
        actorUserId: scope.actorUserId,
        targetUserId: params.userId,
        reason: body.reason,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        reply.code(404);
        return { error: { code: "not_found" } };
      }
      return {
        ok: true,
        targetUserId: params.userId,
        resetCount: result.resetCount,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Recent MFA events
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/events/:teamId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamParams.parse(req.params);
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.org_policy.read",
      });
      if (!scope) return;
      const RECENT_EVENT_CAP = 50;
      const result = await listRecentMfaEvents({
        teamId: params.teamId,
        actorUserId: scope.actorUserId,
        limit: RECENT_EVENT_CAP,
      });
      if (!result.ok) {
        reply.code(404);
        return { error: { code: "not_found" } };
      }
      // PHASE 12B — the service returns the RAW `details` JSON blob, which
      // can carry device id hashes / correlation material an emitter folded
      // in. Route the blob through the canonical allow-list projector so no
      // hash or secret can reach the operator surface.
      return {
        events: result.events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          severity: e.severity,
          createdAt: e.createdAt,
          details: projectSecurityEventDetails(e.details),
        })),
        // The most RECENT 50. Presenting them as the security history of a
        // workspace is the difference between "nothing happened" and "nothing
        // happened in the last fifty events".
        limit: RECENT_EVENT_CAP,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Lost-factor recovery: list pending (admin queue)
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/recovery-requests/:teamId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = TeamParams.parse(req.params);
      // Re-use the admin scope check via posture (sets up the same
      // OWNER/ADMIN check on the team).
      const guard = await readUserMfaPosture({
        teamId: params.teamId,
        actorUserId,
        targetUserId: actorUserId,
      });
      if (!guard.ok) {
        const m = mapScopeFailure(guard.reason!);
        reply.code(m.code);
        return { error: m.message };
      }
      const requests = await listPendingRecoveryRequests({
        teamId: params.teamId,
      });
      return { requests };
    },
  );

  // ---------------------------------------------------------------------------
  // Lost-factor recovery: USER request
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/recovery-requests",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = CreateRecoveryRequestBody.parse(req.body ?? {});
      const result = await createRecoveryRequest({
        userId: actorUserId,
        teamId: body.teamId,
        reason: body.reason,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        if (result.reason === "already_pending") {
          reply.code(409);
          return {
            error: "already_pending",
            request: result.request,
          };
        }
        if (result.reason === "not_member") {
          reply.code(403);
          return { error: "not_member" };
        }
        // PHASE R8.1.6 — per-account throttle. We surface the
        // bounded `retryAfter` ISO timestamp so the UI can show a
        // calm "try again at HH:MM" message without leaking the
        // raw row counts.
        if (result.reason === "rate_limited") {
          reply.code(429);
          return {
            error: "rate_limited",
            retryAfter: result.retryAfter?.toISOString() ?? null,
          };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return { ok: true, request: result.request };
    },
  );

  // ---------------------------------------------------------------------------
  // Lost-factor recovery: ADMIN approve
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/recovery-requests/:requestId/approve",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const result = await approveRecoveryRequest({
        requestId: params.requestId,
        approverUserId: actorUserId,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        if (result.reason === "request_not_found") {
          reply.code(404);
          return { error: "request_not_found" };
        }
        if (
          result.reason === "approver_not_admin" ||
          result.reason === "approver_not_in_team" ||
          result.reason === "cannot_self_approve"
        ) {
          reply.code(403);
          return { error: result.reason };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return {
        ok: true,
        approvedNow: result.approvedNow ?? false,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Lost-factor recovery: ADMIN reject
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/recovery-requests/:requestId/reject",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const body = RejectRecoveryRequestBody.parse(req.body ?? {});
      const result = await rejectRecoveryRequest({
        requestId: params.requestId,
        approverUserId: actorUserId,
        reason: body.reason ?? null,
      });
      if (!result.ok) {
        if (result.reason === "request_not_found") {
          reply.code(404);
          return { error: "request_not_found" };
        }
        if (
          result.reason === "approver_not_admin" ||
          result.reason === "cannot_self_reject"
        ) {
          reply.code(403);
          return { error: result.reason };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.5 — USER endpoints under /v1/identity/mfa/
  //
  // These live alongside the user-self MFA endpoints (R8.1.1) and
  // are NOT admin endpoints — they let the request OWNER drive their
  // own recovery preflight (verify email, resend email, cancel).
  // ---------------------------------------------------------------------------

  // PHASE R8.1.7 — verify-email is intentionally UNAUTHENTICATED.
  // The verification TOKEN itself is the auth proof for this single
  // call. The route still emits the bounded R8.1.7 analytics event
  // on every outcome so SecOps can dashboard the verify funnel.
  app.post(
    "/v1/identity/mfa/recovery-requests/:requestId/verify-email",
    async (req, reply) => {
      const params = RequestIdParams.parse(req.params);
      const body = VerifyEmailBody.parse(req.body ?? {});
      // OPTIONAL session detection — if the caller happens to be
      // authenticated, we tighten the check (`actorUserId` must
      // match `row.userId`). If anonymous, the service's `wrong_user`
      // branch simply does not trigger. This is the right shape
      // for email-link verification because the user may click
      // the link from their phone before signing in on a desktop.
      const actorUserId = readOptionalSessionUserId(req);
      const result = await verifyRecoveryRequestEmail({
        requestId: params.requestId,
        rawToken: body.token,
        actorUserId,
      });
      // Analytics emit AFTER the verify, regardless of outcome.
      // Payload carries ONLY the bounded reason — never the raw
      // token, the email, or any recovery details.
      if (result.ok) {
        void writeAnalyticsEvent({
          eventType: "mfa_recovery_verify_succeeded",
          userId: actorUserId ?? null,
          path: req.url ?? null,
          entityType: "mfa_recovery_request",
          entityId: params.requestId,
          severity: "info",
          metadata: {},
          req,
          skipSessionUpsert: true,
        }).catch(() => null);
      } else {
        void writeAnalyticsEvent({
          eventType: "mfa_recovery_verify_failed",
          userId: actorUserId ?? null,
          path: req.url ?? null,
          entityType: "mfa_recovery_request",
          entityId: params.requestId,
          severity: "warning",
          metadata: { reason: result.reason ?? "unknown" },
          req,
          skipSessionUpsert: true,
        }).catch(() => null);
        if (result.reason === "request_not_found") {
          reply.code(404);
          return { error: "request_not_found" };
        }
        if (result.reason === "wrong_user") {
          reply.code(403);
          return { error: "wrong_user" };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return { ok: true };
    },
  );

  // PHASE R8.1.7 — recovery verify page-viewed analytics ingest.
  // The frontend pings this on mount BEFORE attempting the verify
  // POST so SecOps can dashboard the verify funnel's top of
  // conversion. Anonymous-friendly; never trusts inputs as
  // session signals.
  app.post(
    "/v1/identity/mfa/recovery-requests/analytics/page-viewed",
    async (req) => {
      const actorUserId = readOptionalSessionUserId(req);
      void writeAnalyticsEvent({
        eventType: "mfa_recovery_verify_page_viewed",
        userId: actorUserId ?? null,
        path: req.url ?? null,
        entityType: "mfa_recovery_request",
        severity: "info",
        metadata: {},
        req,
        skipSessionUpsert: true,
      }).catch(() => null);
      return { ok: true };
    },
  );

  app.post(
    "/v1/identity/mfa/recovery-requests/:requestId/resend-email",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const result = await resendRecoveryRequestEmail({
        requestId: params.requestId,
        actorUserId,
      });
      if (!result.ok) {
        if (result.reason === "request_not_found") {
          reply.code(404);
          return { error: "request_not_found" };
        }
        if (result.reason === "wrong_user") {
          reply.code(403);
          return { error: "wrong_user" };
        }
        if (
          result.reason === "resend_throttled" ||
          result.reason === "resend_limit_reached"
        ) {
          reply.code(429);
          return {
            error: result.reason,
            nextResendAfter: result.nextResendAfter?.toISOString() ?? null,
          };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return {
        ok: true,
        nextResendAfter: result.nextResendAfter?.toISOString() ?? null,
      };
    },
  );

  app.post(
    "/v1/identity/mfa/recovery-requests/:requestId/cancel",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const result = await cancelRecoveryRequest({
        requestId: params.requestId,
        actorUserId,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        if (result.reason === "request_not_found") {
          reply.code(404);
          return { error: "request_not_found" };
        }
        if (result.reason === "wrong_user") {
          reply.code(403);
          return { error: "wrong_user" };
        }
        if (result.reason === "already_approved") {
          reply.code(409);
          return { error: "already_approved" };
        }
        reply.code(400);
        return { error: result.reason };
      }
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.5 — request detail view (user OR admin)
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/recovery-requests/detail/:requestId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const result = await readRecoveryRequestDetail({
        requestId: params.requestId,
        actorUserId,
      });
      if (!result.ok) {
        // PHASE 12B ACCEPTANCE — CROSS-ORGANIZATION CONCEALMENT.
        //
        // This previously answered 403 `not_authorized` for a request the
        // caller may not read and 404 `request_not_found` for one that does not
        // exist. The difference made recovery-request ids ENUMERABLE across
        // Organizations: an authenticated caller could walk ids and learn which
        // ones name a real MFA recovery in someone else's Organization — that
        // is, which of another tenant's users lost a second factor and when.
        //
        // Both outcomes are now byte-identical, matching the anti-enumeration
        // contract `authorizeOrFail({ antiEnumeration: true })` applies
        // everywhere else in this vertical: "not yours" and "not there" are
        // indistinguishable.
        reply.code(404);
        return { error: "request_not_found" };
      }
      return { detail: result.detail };
    },
  );

  // ---------------------------------------------------------------------------
  // Phase Final-Hidden-Feature-Surfacing — recovery approval history
  // (read-only). Permits both the subject of the request AND any
  // OWNER/ADMIN of the team to read the full approver list. SOC
  // operators reviewing a recovery now see who approved and when.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/recovery-requests/:requestId/approvals",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = RequestIdParams.parse(req.params);
      const result = await listRecoveryRequestApprovals({
        requestId: params.requestId,
        actorUserId,
      });
      if (!result.ok) {
        // PHASE 12B ACCEPTANCE — same cross-Organization concealment as the
        // detail route above: the approval chain names WHO approved a recovery,
        // so a distinguishable denial leaked both the request's existence and
        // its approvers to another tenant.
        reply.code(404);
        return { error: "request_not_found" };
      }
      return { approvals: result.approvals };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.5 — org MFA policy GET / PATCH
  //
  // The Phase 19 surface in identity-security.routes.ts already
  // exposed MFA policy under /v1/identity-security/mfa-policy.
  // R8.1.5 adds the admin-scoped read/write equivalents under
  // /v1/identity/mfa-admin/policy/:teamId so the admin surface has
  // a consistent prefix and so the fail-mode patch lives next to
  // the other admin lifecycle endpoints.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/policy/:teamId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamParams.parse(req.params);
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.org_policy.read",
      });
      if (!scope) return;
      const policy: ResolvedMfaPolicy = await getMfaPolicy(params.teamId);
      return { policy };
    },
  );

  app.patch(
    "/v1/identity/mfa-admin/policy/:teamId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = TeamParams.parse(req.params);
      const body = PatchPolicyBody.parse(req.body ?? {});
      // Pricing-hardening: MFA enforcement administration is Enterprise-only.
      try {
        await assertTeamAllowsEnterpriseFeature(params.teamId, "mfaEnforcement");
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 402;
        const code = (err as { code?: string }).code ?? "ENTERPRISE_FEATURE_REQUIRED";
        return reply.code(status).send({
          error: {
            code,
            message: (err as Error).message,
            upgradeCta: "/contact-sales",
          },
        });
      }
      const scope = await authorizeMfaAdminScope(req, reply, {
        teamId: params.teamId,
        permission: "identity.org_policy.manage",
      });
      if (!scope) return;
      // Changing the org MFA posture is itself a sensitive action, bound to
      // the workspace whose posture is being rewritten.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: params.teamId,
        userId: scope.actorUserId,
        purpose: "MFA_POLICY_UPDATE",
        resourceKind: "organization_security_policy",
        resourceId: params.teamId,
      });
      if (gate.sent) return;
      try {
        const updated = await updateMfaPolicyVersioned({
          teamId: params.teamId,
          actorUserId: scope.actorUserId,
          expectedPolicyVersion: body.expectedPolicyVersion,
          level: body.level,
          ...(body.stepUpTtlSeconds !== undefined
            ? { stepUpTtlSeconds: body.stepUpTtlSeconds }
            : {}),
          ...(body.trustedDeviceTtlDays !== undefined
            ? { trustedDeviceTtlDays: body.trustedDeviceTtlDays }
            : {}),
          ...(body.mfaEnforcementFailMode !== undefined
            ? { mfaEnforcementFailMode: body.mfaEnforcementFailMode }
            : {}),
          ipAddress: req.ip ?? null,
          userAgent: readUserAgent(req),
        });
        return { policy: updated };
      } catch (err) {
        if (err instanceof MfaPolicyVersionConflictError) {
          reply.code(409);
          return {
            error: {
              code: "MFA_POLICY_VERSION_CONFLICT",
              message:
                "The MFA policy changed while you were editing it. Reload, review, and retry.",
              details: {
                expectedVersion: err.expectedVersion,
                currentVersion: err.currentVersion,
              },
            },
          };
        }
        const msg = err instanceof Error ? err.message : "policy_update_failed";
        if (msg === "invalid_fail_mode") {
          reply.code(400);
          return { error: { code: "invalid_fail_mode" } };
        }
        if (msg === "org_security_policy_not_applicable") {
          reply.code(400);
          return { error: { code: "ORG_SECURITY_POLICY_NOT_APPLICABLE" } };
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.7 — admin digest notification preferences.
  //
  // GET   returns ALL preference rows for the authenticated user
  //       (both global + per-team). The route does NOT expose
  //       another user's preferences — tenant scoping is by actor.
  //
  // PATCH upserts ONE row keyed by (actor, teamId|null). When
  //       teamId is supplied, the actor must be an ACTIVE member
  //       of that team (the service enforces). Suppression /
  //       opt-out applies to digest emails ONLY — audit logs and
  //       security events are unaffected.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/digest-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const result = await listDigestPreferences({ userId: actorUserId });
      // PHASE R8.1.8 — analytics: dashboards "how often do admins
      // open the preferences page?". Bounded payload; no secrets.
      void writeAnalyticsEvent({
        eventType: "mfa_recovery_digest_preferences_viewed",
        userId: actorUserId,
        path: req.url ?? null,
        entityType: "mfa_admin_digest_preference",
        severity: "info",
        metadata: { rowCount: result.preferences.length },
        req,
        skipSessionUpsert: true,
      }).catch(() => null);
      void reply;
      return { preferences: result.preferences };
    },
  );

  app.patch(
    "/v1/identity/mfa-admin/digest-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = PatchDigestPreferenceBody.parse(req.body ?? {});
      const result = await updateDigestPreference({
        actorUserId,
        teamId: body.teamId ?? null,
        ...(body.digestEnabled !== undefined
          ? { digestEnabled: body.digestEnabled }
          : {}),
        ...(body.suppressUntil !== undefined
          ? { suppressUntil: body.suppressUntil }
          : {}),
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        if (result.reason === "not_member") {
          reply.code(403);
          return { error: "not_member" };
        }
        reply.code(400);
        return { error: result.reason };
      }
      // PHASE R8.1.8 — analytics: classify the change so SecOps
      // can dashboard snooze adoption + resume rates. Inference:
      // suppressUntil set in the future → snoozed; cleared or in
      // the past → resumed (when previously snoozed). digestEnabled
      // toggle is a separate dimension. Bounded payload.
      const nowMs = Date.now();
      const suppressEnding =
        body.suppressUntil === null
          ? "cleared"
          : body.suppressUntil
            ? new Date(body.suppressUntil).getTime() > nowMs
              ? "snoozed"
              : "past"
            : "unchanged";
      if (suppressEnding === "snoozed") {
        void writeAnalyticsEvent({
          eventType: "mfa_recovery_digest_snoozed",
          userId: actorUserId,
          path: req.url ?? null,
          entityType: "mfa_admin_digest_preference",
          entityId: result.preference?.id ?? null,
          severity: "info",
          metadata: { teamScoped: body.teamId !== null && body.teamId !== undefined },
          req,
          skipSessionUpsert: true,
        }).catch(() => null);
      } else if (suppressEnding === "cleared") {
        void writeAnalyticsEvent({
          eventType: "mfa_recovery_digest_resumed",
          userId: actorUserId,
          path: req.url ?? null,
          entityType: "mfa_admin_digest_preference",
          entityId: result.preference?.id ?? null,
          severity: "info",
          metadata: { teamScoped: body.teamId !== null && body.teamId !== undefined },
          req,
          skipSessionUpsert: true,
        }).catch(() => null);
      }
      return { preference: result.preference };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.8 — digest PREVIEW endpoint.
  //
  // Returns the digest payload the calling admin WOULD receive on
  // the next scheduled worker tick — WITHOUT sending any email.
  // Useful for sanity-checking notification preferences. The
  // response carries ONLY bounded counters + team display names —
  // never a recovery reason, an OTP, a recovery code, or any token
  // material. The service layer scopes strictly to the actor's
  // ACTIVE OWNER/ADMIN memberships.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/digest-preferences/preview",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const rawQuery =
        typeof req.query === "object" && req.query !== null
          ? (req.query as Record<string, unknown>)
          : {};
      const includeSuppressed =
        rawQuery.includeSuppressed === "true" ||
        rawQuery.includeSuppressed === "1";
      const preview = await previewDigestForAdmin({
        actorUserId,
        includeSuppressed,
      });
      // PHASE R8.1.8 — analytics: track preview usage so SecOps
      // can dashboard adoption. Bounded payload; no secrets.
      void writeAnalyticsEvent({
        eventType: "mfa_recovery_digest_preview_generated",
        userId: actorUserId,
        path: req.url ?? null,
        entityType: "mfa_admin_digest_preference",
        severity: "info",
        metadata: {
          teamCount: preview.teamCount,
          requestCount: preview.requestCount,
          suppressedTeamCount: preview.suppressedTeamCount,
          includeSuppressed,
        },
        req,
        skipSessionUpsert: true,
      }).catch(() => null);
      void reply;
      return { preview };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.9 — email-side signed snooze link (one-click).
  //
  // Anonymous endpoint — the signed token is the auth proof for
  // THIS single action. The endpoint:
  //   1. Verifies the token signature + the `mfa_recovery_digest_snooze`
  //      purpose discriminator (refuses cross-purpose tokens).
  //   2. Checks the JTI against an in-process deny set so a leaked
  //      link cannot be replayed within a single API instance.
  //      Multi-instance correctness is provided by the
  //      `suppressUntil` write itself — the second call would
  //      simply overwrite the same scope's suppress timestamp, so
  //      the worst-case multi-instance replay is "snoozed twice
  //      for 15 days" which is a no-op outcome.
  //   3. Applies `suppressUntil = now + snoozeSeconds` via the
  //      canonical `updateDigestPreference` service (which also
  //      emits `mfa_recovery_digest_preference_updated`).
  //   4. Emits `mfa_recovery_digest_snooze_link_used` so SecOps
  //      can dashboard one-click adoption.
  //   5. Returns a safe success page-style JSON. The frontend can
  //      render a plain confirmation; nothing is required of the
  //      user beyond clicking the link.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/digest-preferences/snooze-link",
    async (req, reply) => {
      const rawQuery =
        typeof req.query === "object" && req.query !== null
          ? (req.query as Record<string, unknown>)
          : {};
      const rawToken =
        typeof rawQuery.token === "string" ? rawQuery.token : "";
      if (!rawToken) {
        reply.code(400);
        return { ok: false, error: "missing_token" };
      }
      const jwtSecret = getSecret("AUTH_JWT_SECRET");
      if (!jwtSecret) {
        reply.code(500);
        return { ok: false, error: "server_misconfigured" };
      }
      const verified = verifyMfaDigestSnoozeToken(rawToken, jwtSecret);
      if (!verified.ok || !verified.payload) {
        reply.code(400);
        return { ok: false, error: verified.reason ?? "invalid" };
      }
      // Replay protection — bounded in-process set keyed by JTI.
      // Cheap and adequate; the token's bounded TTL caps the
      // working set automatically.
      if (snoozeLinkJtiSeen(verified.payload.jti, verified.payload.exp)) {
        reply.code(409);
        return { ok: false, error: "already_used" };
      }
      // Apply the snooze through the canonical service.
      const suppressUntil = new Date(
        Date.now() + verified.payload.snoozeSeconds * 1000,
      ).toISOString();
      const result = await updateDigestPreference({
        actorUserId: verified.payload.sub,
        teamId: verified.payload.teamId,
        digestEnabled: true,
        suppressUntil,
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req),
      });
      if (!result.ok) {
        reply.code(400);
        return { ok: false, error: result.reason ?? "update_failed" };
      }
      safeEmitSecurityEvent({
        teamId: verified.payload.teamId,
        eventType: "mfa_recovery_digest_snooze_link_used",
        severity: "INFO",
        details: {
          actorUserId: verified.payload.sub,
          teamScoped: verified.payload.teamId !== null,
          snoozeSeconds: verified.payload.snoozeSeconds,
        },
      });
      return {
        ok: true,
        message:
          "Digest notifications snoozed. Security events and audit logs are unaffected.",
        suppressUntil,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.9 — send-test digest endpoint.
  //
  // Lets an admin email themselves a one-off "test digest" that
  // mirrors the consolidated email shape. Rate-limited per user:
  //   - Max 3 tests per UTC day
  //   - Min 60 seconds between tests
  //
  // Hard rules:
  //   - The send target is ALWAYS the calling admin's own email —
  //     never another address.
  //   - The test digest does NOT write `MfaRecoveryAdminDigestLog`,
  //     so the real digest tick will still send the daily digest
  //     normally.
  //   - The subject is prefixed `[TEST]` so the admin can
  //     unambiguously tell a test apart from a scheduled digest.
  //   - Emits `mfa_recovery_digest_test_sent` on accept,
  //     `mfa_recovery_digest_test_failed` on transport failure.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa-admin/digest-preferences/preview/send-test",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");

      // Rate limit. Cheap in-process; per-user throttle. Multi-
      // instance correctness is enforced by the bounded daily +
      // hourly caps; an attacker spraying across replicas would
      // still hit the SAME limits per replica with the same effect.
      const rl = sendTestRateLimit(actorUserId);
      if (rl.reason) {
        reply.code(429);
        return {
          ok: false,
          error: rl.reason,
          nextAllowedAt: rl.nextAllowedAt?.toISOString() ?? null,
        };
      }

      // Build the preview payload.
      const preview = await previewDigestForAdmin({
        actorUserId,
        includeSuppressed: false,
      });
      // Look up the admin's email address.
      const user = await prisma.user.findUnique({
        where: { id: actorUserId },
        select: { email: true },
      });
      if (!user?.email) {
        reply.code(400);
        return { ok: false, error: "user_email_missing" };
      }

      // PHASE 11 — nav path, composed via internalNavPath + absoluteInternalUrl.
      const adminSpaUrl = absoluteInternalUrl(
        process.env.WEB_BASE_URL || "https://www.proovra.com",
        internalNavPath("/security-center/mfa-recovery"),
      );

      // Build a one-click snooze URL for the test email so the
      // admin can see and validate the snooze link flow. Uses the
      // same `buildMfaDigestSnoozeUrl` helper that the email-side
      // snooze route uses. Returns null if JWT secret is absent.
      const testSnoozeUrl = (() => {
        const secret = process.env.AUTH_JWT_SECRET;
        if (!secret) return null;
        return buildMfaDigestSnoozeUrl(
          actorUserId,
          null,
          secret,
          process.env.API_BASE_URL || "https://api.proovra.com",
        );
      })();

      // Send via the canonical email service. The subject is
      // prefixed `[TEST]` so the admin sees it unambiguously.
      try {
        const email = getEmailService();
        if (email.isConfigured()) {
          await email.sendMfaRecoveryAdminDigestEmail(
            user.email,
            `[TEST] preview for ${preview.adminUserId.slice(0, 8)}…`,
            preview.requestCount,
            adminSpaUrl,
            testSnoozeUrl,
          );
        }
      } catch (err) {
        safeEmitSecurityEvent({
          teamId: null,
          eventType: "mfa_recovery_digest_test_failed",
          severity: "WARNING",
          details: {
            actorUserId,
            reason: "transport_error",
            errorCode: err instanceof Error ? err.name.slice(0, 64) : "unknown_error",
          },
        });
        void writeAnalyticsEvent({
          eventType: "mfa_recovery_digest_test_failed",
          userId: actorUserId,
          path: req.url ?? null,
          entityType: "mfa_admin_digest_preference",
          severity: "warning",
          metadata: { reason: "transport_error" },
          req,
          skipSessionUpsert: true,
        }).catch(() => null);
        reply.code(502);
        return { ok: false, error: "transport_error" };
      }

      safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_recovery_digest_test_sent",
        severity: "INFO",
        details: {
          actorUserId,
          teamCount: preview.teamCount,
          requestCount: preview.requestCount,
        },
      });
      void writeAnalyticsEvent({
        eventType: "mfa_recovery_digest_test_sent",
        userId: actorUserId,
        path: req.url ?? null,
        entityType: "mfa_admin_digest_preference",
        severity: "info",
        metadata: {
          teamCount: preview.teamCount,
          requestCount: preview.requestCount,
        },
        req,
        skipSessionUpsert: true,
      }).catch(() => null);
      return {
        ok: true,
        preview,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE R8.1.9 — admin recovery event feed.
  //
  // Bounded read of the canonical `SecurityEvent` table for the
  // last 14 days of mfa_recovery_* events scoped to the actor's
  // ACTIVE OWNER/ADMIN teams. Returns LABELED rows — never the
  // raw `details` JSON payload.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa-admin/recovery-events",
    { preHandler: requireAuth },
    async (req, reply) => {
      const actorUserId = getAuthUserId(req);
      if (!actorUserId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const rawQuery =
        typeof req.query === "object" && req.query !== null
          ? (req.query as Record<string, unknown>)
          : {};
      const limit =
        typeof rawQuery.limit === "string"
          ? Math.max(1, Math.min(200, Number.parseInt(rawQuery.limit, 10) || 100))
          : 100;
      const windowDays =
        typeof rawQuery.windowDays === "string"
          ? Math.max(1, Math.min(60, Number.parseInt(rawQuery.windowDays, 10) || 14))
          : 14;
      const result = await readRecoveryEventFeed({
        actorUserId,
        limit,
        windowDays,
      });
      void writeAnalyticsEvent({
        eventType: "mfa_recovery_event_feed_viewed",
        userId: actorUserId,
        path: req.url ?? null,
        entityType: "mfa_admin_event_feed",
        severity: "info",
        metadata: {
          eventCount: result.events.length,
          windowDays: result.windowDays,
        },
        req,
        skipSessionUpsert: true,
      }).catch(() => null);
      void reply;
      return result;
    },
  );
}

// ---------------------------------------------------------------------------
// PHASE R8.1.9 — bounded in-process replay set for one-click
// snooze tokens. Single-process correctness; cross-instance
// correctness is provided by the suppressUntil overwrite being a
// no-op outcome (snoozing twice = same end state).
// ---------------------------------------------------------------------------
const snoozeLinkJtiByExp = new Map<string, number>();
const SNOOZE_LINK_GC_INTERVAL_MS = 60 * 60 * 1000;
let snoozeLinkLastGcAtMs = 0;

function snoozeLinkJtiSeen(jti: string, expSeconds: number): boolean {
  const nowMs = Date.now();
  if (nowMs - snoozeLinkLastGcAtMs > SNOOZE_LINK_GC_INTERVAL_MS) {
    snoozeLinkLastGcAtMs = nowMs;
    for (const [seenJti, exp] of snoozeLinkJtiByExp) {
      if (nowMs / 1000 >= exp) snoozeLinkJtiByExp.delete(seenJti);
    }
  }
  if (snoozeLinkJtiByExp.has(jti)) return true;
  snoozeLinkJtiByExp.set(jti, expSeconds);
  return false;
}

// ---------------------------------------------------------------------------
// PHASE R8.1.9 — bounded in-process rate limit for send-test
// digest. Per-user; cross-instance correctness is provided by the
// SAME caps applying per replica — the worst case is N replicas
// * 3 sends/day, which is still bounded.
// ---------------------------------------------------------------------------
const SEND_TEST_DAILY_CAP = 3;
const SEND_TEST_MIN_INTERVAL_MS = 60 * 1000;
const sendTestHistoryByUser = new Map<string, number[]>();

interface SendTestRateLimitResult {
  reason?: "too_soon" | "daily_cap";
  nextAllowedAt?: Date;
}

function sendTestRateLimit(userId: string): SendTestRateLimitResult {
  const nowMs = Date.now();
  const dayCutoff = nowMs - 24 * 60 * 60 * 1000;
  const prior = (sendTestHistoryByUser.get(userId) ?? []).filter(
    (t) => t > dayCutoff,
  );
  if (prior.length > 0) {
    const last = prior[prior.length - 1];
    if (nowMs - last < SEND_TEST_MIN_INTERVAL_MS) {
      return {
        reason: "too_soon",
        nextAllowedAt: new Date(last + SEND_TEST_MIN_INTERVAL_MS),
      };
    }
  }
  if (prior.length >= SEND_TEST_DAILY_CAP) {
    return {
      reason: "daily_cap",
      nextAllowedAt: new Date(prior[0] + 24 * 60 * 60 * 1000),
    };
  }
  prior.push(nowMs);
  sendTestHistoryByUser.set(userId, prior);
  return {};
}

/** TEST-ONLY helper — exposed for the source-contract suite. */
export function __resetMfaAdminRouteRateLimitersForTests(): void {
  snoozeLinkJtiByExp.clear();
  snoozeLinkLastGcAtMs = 0;
  sendTestHistoryByUser.clear();
}

/** PHASE R8.1.9 — exported signing helper for the email service to
 *  use when assembling the digest. The route imports the verify
 *  helper directly. Keeping this thin re-export keeps the email
 *  service from importing from a route file. */
export function buildMfaDigestSnoozeUrl(
  userId: string,
  teamId: string | null,
  secret: string,
  baseUrl: string,
): string {
  const token = signMfaDigestSnoozeToken({ userId, teamId }, secret);
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/v1/identity/mfa-admin/digest-preferences/snooze-link?token=${encodeURIComponent(token)}`;
}

void MFA_DIGEST_SNOOZE_TTL_SECONDS; // re-export keeps the constant
// available for callers + the test suite.
