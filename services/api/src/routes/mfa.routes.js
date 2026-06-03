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
 *     bounded in-memory cooldown per user (5 attempts / 60 s). The
 *     in-memory limiter is sufficient for single-process and small
 *     cluster deployments; multi-region deployments should layer a
 *     Redis-backed limiter at the gateway level. The cooldown
 *     emits `mfa_verification_failed` with `reason: "rate_limited"`
 *     so operators see the brute-force surface.
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
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { beginTotpEnrollment, consumeRecoveryCode, readMfaStatus, regenerateRecoveryBatch, revokeFactor, verifyActiveTotp, verifyAndActivateEnrollment, } from "../services/security/mfa.service.js";
// =============================================================================
// Bounded in-memory rate limiter (per-process)
// =============================================================================
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_MAX = 5;
const attempts = new Map();
function isRateLimited(key) {
    const now = Date.now();
    const arr = attempts.get(key) ?? [];
    const recent = arr.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    recent.push(now);
    attempts.set(key, recent);
    return recent.length > ATTEMPT_MAX;
}
function requestIp(req) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.length > 0) {
        return xf.split(",")[0]?.trim() ?? null;
    }
    return req.ip ?? null;
}
async function readAccountName(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, displayName: true },
    });
    return user?.email ?? user?.displayName ?? `user:${userId.slice(0, 8)}`;
}
// =============================================================================
// Zod schemas (bounded inputs)
// =============================================================================
const EnrollStartBody = z.object({
    label: z.string().min(1).max(60).optional(),
});
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
    .refine((body) => Boolean(body.code) !== Boolean(body.recoveryCode), {
    message: "Provide exactly one of `code` (TOTP) or `recoveryCode` (backup).",
});
// =============================================================================
// Routes
// =============================================================================
export async function mfaRoutes(app) {
    // ---------------------------------------------------------------------------
    // GET /v1/identity/mfa/factors — read-only status
    // ---------------------------------------------------------------------------
    app.get("/v1/identity/mfa/factors", { preHandler: requireAuth }, async (req, _reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const status = await readMfaStatus({ userId });
        return status;
    });
    // ---------------------------------------------------------------------------
    // POST /v1/identity/mfa/enroll/start — begin enrollment
    // ---------------------------------------------------------------------------
    app.post("/v1/identity/mfa/enroll/start", { preHandler: requireAuth }, async (req, _reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const body = EnrollStartBody.parse(req.body ?? {});
        const accountName = await readAccountName(userId);
        const result = await beginTotpEnrollment({
            userId,
            accountName,
            label: body.label ?? null,
        });
        return result;
    });
    // ---------------------------------------------------------------------------
    // POST /v1/identity/mfa/enroll/verify — verify + activate
    // ---------------------------------------------------------------------------
    app.post("/v1/identity/mfa/enroll/verify", { preHandler: requireAuth }, async (req, reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const body = EnrollVerifyBody.parse(req.body ?? {});
        const key = `mfa:enroll-verify:${userId}`;
        if (isRateLimited(key)) {
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
        };
    });
    // ---------------------------------------------------------------------------
    // DELETE /v1/identity/mfa/factors/:id — revoke a factor
    // ---------------------------------------------------------------------------
    app.delete("/v1/identity/mfa/factors/:id", { preHandler: requireAuth }, async (req, reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const params = FactorIdParams.parse(req.params);
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
    });
    // ---------------------------------------------------------------------------
    // POST /v1/identity/mfa/recovery-codes/regenerate
    // ---------------------------------------------------------------------------
    app.post("/v1/identity/mfa/recovery-codes/regenerate", { preHandler: requireAuth }, async (req, _reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const result = await regenerateRecoveryBatch({ userId });
        // Recovery codes returned ONCE here.
        return { recoveryCodes: result.recoveryCodes };
    });
    // ---------------------------------------------------------------------------
    // POST /v1/identity/mfa/challenge/verify
    // Accepts EITHER a TOTP `code` OR a `recoveryCode`. Used by step-up
    // flows; the login-flow integration is deferred to R8.1.2.
    // ---------------------------------------------------------------------------
    app.post("/v1/identity/mfa/challenge/verify", { preHandler: requireAuth }, async (req, reply) => {
        const userId = getAuthUserId(req);
        if (!userId)
            throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
        const body = ChallengeVerifyBody.parse(req.body ?? {});
        const key = `mfa:challenge-verify:${userId}`;
        if (isRateLimited(key)) {
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
            const result = await consumeRecoveryCode({
                userId,
                code: body.recoveryCode,
                ipAddress: requestIp(req),
            });
            if (!result.ok) {
                reply.code(400);
                return { error: result.reason };
            }
            return { ok: true, used: "recovery_code" };
        }
        const result = await verifyActiveTotp({
            userId,
            code: body.code,
        });
        if (!result.ok) {
            reply.code(400);
            return { error: "code_invalid" };
        }
        return { ok: true, used: "totp", factorId: result.factorId };
    });
}
