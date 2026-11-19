/**
 * PHASE R8.1.1 — MFA REST endpoints.
 *
 * Authenticated endpoints that wire the canonical MFA orchestrator
 * (`services/security/mfa.service.ts`) into Fastify. Routes live
 * under `/v1/identity/mfa/*` as a sub-domain of the canonical
 * identity surface — they are NOT a parallel auth system. They
 * reuse `requireAuth` + the canonical session resolution.
 *
 * RATE LIMITING:
 *   - Enrollment-verify and challenge-verify endpoints carry a
 *     per-user cooldown (5 attempts / 60 s) on the SHARED canonical
 *     limiter with a global bound (B1-F-011, free-audit 0ea0): one
 *     bucket across every API instance. The cooldown emits
 *     `mfa_verification_failed` with `reason: "rate_limited"` so
 *     operators see the brute-force surface.
 *
 * SECURITY:
 *   - Every mutation requires `requireAuth`.
 *   - Inputs go through zod validation (length / shape).
 *   - Plaintext TOTP codes + plaintext recovery codes appear only
 *     in the request body — NEVER in logs (sanitized via
 *     bounded responses; the orchestrator's audit emissions never
 *     contain the user's code).
 *   - The plaintext secret is returned exactly ONCE (begin-enroll
 *     response) and the plaintext recovery codes are returned
 *     exactly ONCE (verify-enroll + regenerate responses).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode, inputRefusal } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { MFA_ENROLLMENT_SCOPE } from "../services/auth/extension-scope.js";
import { issueEnrolledToken } from "../services/auth/mfa-enrollment-session.js";
import {
  verifyAccountStepUp,
  verifyFactorEnrollmentStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { assertLimiterAvailable } from "../http/limiter-unavailable.js";
import {
  beginTotpEnrollment,
  checkRecoveryCode,
  readMfaStatus,
  regenerateRecoveryBatch,
  revokeFactor,
  verifyActiveTotp,
  verifyAndActivateEnrollment,
} from "../services/security/mfa.service.js";

// =============================================================================
// Attempt throttle — the SHARED limiter
// =============================================================================
//
// B1-F-011 (free-audit 0ea0): this was an in-memory Map per process, so the
// 5-per-minute budget on enrolment-verify and challenge-verify multiplied by
// the number of API instances, while the login MFA verify already used the
// shared limiter. It is now the same canonical limiter with a GLOBAL bound: one
// bucket across every instance, and with Redis configured but unreachable the
// attempt is refused rather than counted in this process (a per-process count
// is exactly the multiplied budget this limit exists to prevent).

const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_MAX = 5;

async function isRateLimited(key: string): Promise<boolean> {
  const result = await enforceRateLimit({
    key,
    max: ATTEMPT_MAX,
    windowSec: Math.round(ATTEMPT_WINDOW_MS / 1000),
    bound: "global",
  });
  // DEC-20 — a store outage is a retryable 503, not "too many attempts".
  assertLimiterAvailable(result);
  return !result.allowed;
}

async function readAccountName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true },
  });
  return user?.email ?? user?.displayName ?? `user:${userId.slice(0, 8)}`;
}

// =============================================================================
// Zod schemas (bounded inputs)
// =============================================================================

/**
 * PV-API-002 — THIS ROUTE ENROLS AN AUTHENTICATOR APP, AND SAYS SO.
 *
 * The body was a loose object: `{ "kind": "SMS" }` was silently ignored and a
 * caller asking for a phone factor got a TOTP enrolment it never asked for,
 * with a QR secret and no error. The body is now strict — an unknown field is
 * a 400, not a no-op — and `kind`, when present, may only name what this route
 * does. A request for a CONTACT factor is refused with a pointer to the route
 * that enrols one (see the handler).
 */
const EnrollStartBody = z
  .object({
    label: z.string().min(1).max(60).optional(),
    kind: z.literal("TOTP").optional(),
    // PRO-015 — the account step-up proof, required once a factor exists.
    stepUp: z
      .object({
        method: z.enum(["password", "mfa"]).optional(),
        currentPassword: z.string().max(1024).optional(),
        code: z.string().max(16).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CONTACT_FACTOR_ENROL_ROUTE =
  "/v1/identity-security/contact-factors/enroll/start";

const EnrollVerifyBody = z.object({
  factorId: z.string().uuid(),
  code: z.string().min(6).max(10),
});

const FactorIdParams = z.object({
  id: z.string().uuid(),
});

const ChallengeVerifyBody = z
  .object({
    code: z.string().min(6).max(11).optional(),
    recoveryCode: z.string().min(10).max(20).optional(),
  })
  .refine(
    (body) => Boolean(body.code) !== Boolean(body.recoveryCode),
    {
      message:
        "Provide exactly one of `code` (TOTP) or `recoveryCode` (backup).",
    },
  );

// =============================================================================
// Routes
// =============================================================================

export async function mfaRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/identity/mfa/factors — read-only status
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/identity/mfa/factors",
    { preHandler: requireAuth },
    async (req: FastifyRequest) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const status = await readMfaStatus({ userId });
      return status;
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/identity/mfa/enroll/start — begin enrollment
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa/enroll/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const raw = (req.body ?? {}) as Record<string, unknown>;
      if (raw.kind === "SMS" || raw.kind === "WHATSAPP") {
        throw inputRefusal({
          code: "MFA_ENROLL_WRONG_ROUTE",
          message:
            "This route enrols an authenticator app. Phone factors are enrolled through the contact-factor route.",
          metadata: { kind: raw.kind, route: CONTACT_FACTOR_ENROL_ROUTE },
        });
      }
      const body = EnrollStartBody.parse(raw);
      // PRO-015 (AUTH-09) — this enrolment ends in ten recovery codes, and an
      // added authenticator answers workspace step-ups. Once the account holds
      // a factor, adding one is stepped up exactly like regenerating codes.
      const stepUp = await verifyFactorEnrollmentStepUp({
        req,
        reply,
        userId,
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        reply.code(stepUp.denial.status);
        return stepUp.denial.body;
      }
      const accountName = await readAccountName(userId);
      const result = await beginTotpEnrollment({
        userId,
        accountName,
        label: body.label ?? null,
      });
      return result;
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/identity/mfa/enroll/verify — verify + activate
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa/enroll/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = EnrollVerifyBody.parse(req.body ?? {});
      const key = `mfa:enroll-verify:${userId}`;
      if (await isRateLimited(key)) {
        safeEmitSecurityEvent({
          teamId: null,
          eventType: "mfa_verification_failed",
          severity: "WARNING",
          details: {
            actorUserId: userId,
            context: "enrollment",
            reason: "rate_limited",
          },
        });
        reply.code(429);
        return { error: "rate_limited", retryAfterMs: ATTEMPT_WINDOW_MS };
      }
      const result = await verifyAndActivateEnrollment({
        userId,
        factorId: body.factorId,
        code: body.code,
      });
      if (!result.ok) {
        reply.code(result.reason === "code_invalid" ? 400 : 404);
        return { error: result.reason };
      }
      // Recovery codes returned ONCE here. The client must surface
      // them immediately; we never return them again.
      return {
        factorId: result.factorId,
        recoveryCodes: result.recoveryCodes,
        ...(req.user?.tokenScope === MFA_ENROLLMENT_SCOPE
          ? { mfaEnrollmentToken: issueEnrolledToken(req, reply, result.factorId) }
          : {}),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/identity/mfa/factors/:id — revoke a factor
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/v1/identity/mfa/factors/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = FactorIdParams.parse(req.params);
      // Step-up (2026-07-16): removing a VERIFIED (ACTIVE) factor is a
      // sensitive account mutation and requires backend-enforced re-auth.
      // Deleting the caller's own ENROLLING factor is the enrollment
      // CANCEL path — the factor was never verified, is inert, and needs
      // no step-up. The status check is scoped to the CALLER's factor, so
      // the cancel route can never touch another user's row or silently
      // downgrade a verified factor.
      const target = await prisma.mfaFactor.findFirst({
        where: { id: params.id, userId },
        select: { status: true },
      });
      if (!target) {
        reply.code(404);
        return { error: "factor_not_found" };
      }
      if (target.status === "ACTIVE") {
        const body = (req.body ?? {}) as { stepUp?: AccountStepUpProof };
        const stepUp = await verifyAccountStepUp({
          req,
          reply,
          userId,
          action: "mfa_factor_remove",
          proof: body.stepUp,
        });
        if (!stepUp.ok) {
          reply.code(stepUp.denial.status);
          return stepUp.denial.body;
        }
      }
      const result = await revokeFactor({
        userId,
        factorId: params.id,
        reason: "user_revoked",
      });
      if (!result.ok) {
        reply.code(404);
        return { error: result.reason ?? "factor_not_found" };
      }
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/identity/mfa/recovery-codes/regenerate
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa/recovery-codes/regenerate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      // Step-up (2026-07-16): regeneration invalidates every existing
      // recovery code — a sensitive account mutation requiring
      // backend-enforced re-auth (never just a confirmation dialog).
      const body = (req.body ?? {}) as { stepUp?: AccountStepUpProof };
      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "mfa_recovery_codes_regenerate",
        proof: body.stepUp,
      });
      if (!stepUp.ok) {
        reply.code(stepUp.denial.status);
        return stepUp.denial.body;
      }
      const result = await regenerateRecoveryBatch({ userId });
      // B1-F-002 — a new batch (which ends every earlier code) is an entry on
      // the person's own "Account & security activity" timeline, which reads
      // `identity.*` audit rows for the caller. No code, count or hash is
      // recorded. The product has no security-alert email or push channel.
      void emitPlatformAudit({
        action: "identity.mfa_recovery_codes_regenerated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        resourceType: "user",
        resourceId: userId,
        metadata: { batchSize: result.recoveryCodes.length },
      }).catch(() => null);
      // Recovery codes returned ONCE here.
      return { recoveryCodes: result.recoveryCodes };
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/identity/mfa/challenge/verify
  // Accepts EITHER a TOTP `code` OR a `recoveryCode`. Used by step-up
  // flows; the login-flow integration is deferred to R8.1.2.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/identity/mfa/challenge/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = ChallengeVerifyBody.parse(req.body ?? {});
      const key = `mfa:challenge-verify:${userId}`;
      if (await isRateLimited(key)) {
        safeEmitSecurityEvent({
          teamId: null,
          eventType: "mfa_verification_failed",
          severity: "WARNING",
          details: {
            actorUserId: userId,
            context: "challenge",
            reason: "rate_limited",
          },
        });
        reply.code(429);
        return { error: "rate_limited", retryAfterMs: ATTEMPT_WINDOW_MS };
      }
      if (body.recoveryCode) {
        // B1-F-020 (free-audit 0ea0) — A CHECK DOES NOT SPEND THE CREDENTIAL.
        // This route changes no other state (it is the posture self-check), so
        // consuming the code here only burned one of the person's scarce
        // recovery codes to prove nothing. The code is verified exactly as a
        // sign-in would verify it — same lookup, owner, batch and verifier
        // checks, same failure events — and stays unused.
        const result = await checkRecoveryCode({
          userId,
          code: body.recoveryCode,
        });
        if (!result.ok) {
          reply.code(400);
          return { error: result.reason };
        }
        return { ok: true, used: "recovery_code", consumed: false };
      }
      const result = await verifyActiveTotp({
        userId,
        code: body.code as string,
      });
      if (!result.ok) {
        reply.code(400);
        return { error: "code_invalid" };
      }
      return { ok: true, used: "totp", factorId: result.factorId };
    },
  );
}
