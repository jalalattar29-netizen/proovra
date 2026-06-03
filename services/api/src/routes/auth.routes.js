import { z } from "zod";
import { createGuestProfile, exchangeAppleCodeForIdToken, exchangeGoogleCodeForIdToken, ensureGuestIdentity, upsertUser, upsertUserWithEmailLink, verifyAppleIdToken, verifyGoogleIdToken, } from "../services/auth.service.js";
import { registerWithEmailPassword, loginWithEmailPassword, createPasswordResetTokenForEmail, resetPasswordWithToken, } from "../services/email-password-auth.service.js";
import { getEmailService } from "../services/email.service.js";
import { getSecret } from "../config/runtime-secrets.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { signJwt, verifyJwt, signMfaPendingToken, verifyMfaPendingTokenSignature, MFA_PENDING_TTL_SECONDS, } from "../services/jwt.js";
import { getAuthUserId } from "../auth.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { verifyActiveTotp, consumeRecoveryCode, createMfaPendingChallenge, consumeMfaPendingChallenge, recordPendingChallengeFailure, } from "../services/security/mfa.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { resolveLoginMfaEnforcement } from "../services/security/login-mfa-enforcement.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
// Phase 2.7Z+ — E2E auth rate-limit bypass (env-gated, production-safe).
// See services/api/src/services/auth-test-bypass.ts for the three
// layers of defense and the operational rules.
import { shouldBypassAuthRateLimit, buildBypassLogPayload, } from "../services/auth-test-bypass.js";
// Phase 2.5 — record the AuthenticatedSession row for non-SAML/SSO
// login paths so the user-facing `/v1/users/me/sessions` list is not
// empty for guest + email-password users (Phase 2.4 finding).
import { recordAuthenticatedSession } from "../services/access-control/session-inventory.service.js";
// Phase E10.1 — DEF-037 closure. Per-IP rate limits on the public,
// unauthenticated email login and password-reset-request surfaces.
// Bucket sizes are deliberately tight to defeat credential stuffing
// while still tolerating normal user retries (typo → retry within the
// minute).
const AUTH_LOGIN_RATE_LIMIT_PER_IP_PER_MIN = 10;
const AUTH_PASSWORD_RESET_RATE_LIMIT_PER_IP_PER_MIN = 5;
const AUTH_RATE_LIMIT_WINDOW_SEC = 60;
// Phase 1 — guest-auth rate limit. Anonymous /v1/auth/guest creates a
// new User row and JWT every call. Without a bucket an attacker can
// inflate the user table arbitrarily, exhaust signing-key bucket
// references, and abuse downstream guest-tier evidence quotas. 5/min/IP
// is generous for legitimate flows (one human + a handful of retries)
// but cuts off scripted creation. The bucket is configurable via env.
const AUTH_GUEST_RATE_LIMIT_PER_IP_PER_MIN = 5;
function readClientIp(req) {
    // `req.ip` is normalised by Fastify; fall back to "unknown" so the
    // rate-limit key is always non-empty (the limiter throws otherwise).
    return (req.ip && req.ip.length > 0 ? req.ip : "unknown").slice(0, 200);
}
// Phase 2.5 — session inventory recording helpers.
//
// These helpers mirror the SAML / SSO route helpers (saml-auth.routes.ts:89-103)
// so the AuthenticatedSession `ipPreview` + `uaPreview` shapes stay
// consistent across login providers. They are display-only previews,
// NEVER raw IP / UA.
function authIpPreview(req) {
    const ip = req.ip ?? "";
    if (!ip)
        return null;
    if (ip.includes(".")) {
        const parts = ip.split(".");
        if (parts.length === 4)
            return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
    }
    return ip.slice(0, 10) + "…";
}
function authUaPreview(req) {
    const raw = req.headers["user-agent"];
    if (typeof raw !== "string")
        return null;
    return raw.trim().slice(0, 120);
}
/**
 * Phase 2.5 — record an AuthenticatedSession row after signing a
 * non-SAML/SSO JWT.
 *
 * Pre-Phase-2.5 the guest + email-password login paths called
 * `signJwt()` directly and skipped the session-inventory write. This
 * meant `GET /v1/users/me/sessions` returned `[]` for those users
 * (Phase 2.4 finding). The recording is best-effort: an inventory
 * write failure must NEVER break login.
 *
 * `signJwt()` already mints a random `sid` internally; we extract it
 * by base64-decoding the resulting token payload. This avoids any
 * change to signJwt's signature and keeps every existing caller's
 * behavior identical for the token value.
 *
 * `teamId` is NULL for guest / fresh email-password tokens — the
 * AuthenticatedSession schema permits null teamId rows (workspace-less
 * sessions). The user-facing sessions endpoint already handles that
 * case (Phase 2.4).
 */
async function recordSessionFromSignedToken(req, user, token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return;
        const payloadJson = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
        const payload = JSON.parse(payloadJson);
        if (typeof payload.sid !== "string" ||
            typeof payload.iat !== "number" ||
            typeof payload.exp !== "number") {
            return;
        }
        await recordAuthenticatedSession({
            userId: user.id,
            teamId: user.currentWorkspaceId ?? null,
            sid: payload.sid,
            iat: payload.iat,
            exp: payload.exp,
            ipPreview: authIpPreview(req),
            uaPreview: authUaPreview(req),
        });
    }
    catch {
        // Best-effort. A failed inventory write must not break login.
    }
}
const TokenBody = z.object({
    idToken: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
});
const AppleBody = z.object({
    idToken: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
});
const EmailRegisterBody = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().min(1).optional(),
});
const EmailLoginBody = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
const PasswordResetRequestBody = z.object({
    email: z.string().email(),
});
const PasswordResetConfirmBody = z.object({
    token: z.string().min(10),
    newPassword: z.string().min(8),
});
// PHASE R8.1.2 — login-time MFA verify body. Exactly one of `code`
// (TOTP) or `recoveryCode` must be present. The shared verification
// orchestrator (services/security/mfa.service) owns the actual
// cryptographic check — this route is a thin login-flow adapter so
// step-up and login share the same verification path.
const LoginMfaVerifyBody = z
    .object({
    mfaPendingToken: z.string().min(20),
    code: z.string().trim().min(6).max(10).optional(),
    recoveryCode: z.string().trim().min(10).max(20).optional(),
})
    .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), "exactly_one_of_code_or_recoveryCode");
// PHASE R8.1.2 — process-local rate limiter for the MFA verify route.
// Identical bounds to `mfa.routes.ts` so the two surfaces behave
// uniformly. Keyed by userId (NOT by IP) because the pending token
// already binds to a specific user; an attacker spraying many user
// ids against the endpoint would still need a valid pending token
// per user.
const LOGIN_MFA_ATTEMPT_WINDOW_MS = 60_000;
const LOGIN_MFA_ATTEMPT_MAX = 5;
const loginMfaAttempts = new Map();
function loginMfaIsRateLimited(userId) {
    const now = Date.now();
    const arr = loginMfaAttempts.get(userId) ?? [];
    const recent = arr.filter((t) => now - t < LOGIN_MFA_ATTEMPT_WINDOW_MS);
    recent.push(now);
    loginMfaAttempts.set(userId, recent);
    return recent.length > LOGIN_MFA_ATTEMPT_MAX;
}
/** TEST-ONLY rate-limit reset — exported for the contract tests. */
export function __resetLoginMfaRateLimiterForTests() {
    loginMfaAttempts.clear();
}
function readUserAgent(req) {
    const ua = req.headers["user-agent"];
    return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}
function auditAuthEvent(req, params) {
    void appendPlatformAuditLog({
        userId: params.userId,
        action: params.action,
        category: "auth",
        severity: params.severity ?? "info",
        source: "api_auth",
        outcome: params.outcome ?? "success",
        resourceType: "user_auth",
        resourceId: params.resourceId ?? params.userId ?? null,
        requestId: req.id,
        metadata: params.metadata ?? {},
        ipAddress: req.ip,
        userAgent: readUserAgent(req),
    }).catch(() => null);
}
function fireLoginCompletedAnalytics(userId, req, metadata) {
    void writeAnalyticsEvent({
        eventType: "login_completed",
        userId,
        path: req?.url ?? null,
        entityType: "user",
        entityId: userId,
        severity: "info",
        metadata,
        req,
        skipSessionUpsert: true,
    }).catch(() => null);
}
function fireRegisterCompletedAnalytics(userId, req, metadata) {
    void writeAnalyticsEvent({
        eventType: "register_completed",
        userId,
        path: req?.url ?? null,
        entityType: "user",
        entityId: userId,
        severity: "info",
        metadata,
        req,
        skipSessionUpsert: true,
    }).catch(() => null);
}
export async function authRoutes(app) {
    // Phase P2.0 — read once at route-registration time (after
    // `initSecretsManager` has run). AWS first, env fallback.
    const jwtSecret = getSecret("AUTH_JWT_SECRET");
    if (!jwtSecret) {
        throw new Error("AUTH_JWT_SECRET is not set");
    }
    function jwtPayloadFromUser(user) {
        return {
            sub: user.id,
            provider: user.provider,
            email: user.email,
            ...(user.platformRole === "admin" ? { role: "admin" } : {}),
        };
    }
    function maybeSetWebCookie(req, reply, token) {
        if (req.headers["x-web-client"] !== "1") {
            return;
        }
        const host = req.headers.host ?? "";
        const origin = req.headers.origin ?? "";
        const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
        const cookieOpts = isProductionDomain
            ? {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: "/",
                domain: ".proovra.com",
                maxAge: 60 * 60 * 24 * 30,
            }
            : {
                httpOnly: true,
                secure: false,
                sameSite: "lax",
                path: "/",
                domain: undefined,
                maxAge: 60 * 60 * 24 * 30,
            };
        reply.clearCookie("proovra_session", { path: "/", domain: ".proovra.com" });
        reply.clearCookie("proovra_session", { path: "/" });
        reply.setCookie("proovra_session", token, cookieOpts);
    }
    // PHASE R8.1.2 — MFA-pending cookie. A separately-named cookie
    // (`proovra_mfa_pending`) carries the pending token through the
    // browser redirect flow used by SSO/OIDC. Properties matter:
    //   - HTTP-only       → invisible to page JS (no XSS exfiltration)
    //   - SameSite=lax    → posts back from /auth/mfa-challenge work
    //   - maxAge = 5 min  → matches MFA_PENDING_TTL_SECONDS exactly
    //   - DIFFERENT name  → never confused with the canonical session
    //                       cookie; cleared the instant verify succeeds.
    function setMfaPendingCookie(req, reply, token) {
        const host = req.headers.host ?? "";
        const origin = req.headers.origin ?? "";
        const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
        const cookieOpts = isProductionDomain
            ? {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: "/",
                domain: ".proovra.com",
                maxAge: MFA_PENDING_TTL_SECONDS,
            }
            : {
                httpOnly: true,
                secure: false,
                sameSite: "lax",
                path: "/",
                domain: undefined,
                maxAge: MFA_PENDING_TTL_SECONDS,
            };
        reply.setCookie("proovra_mfa_pending", token, cookieOpts);
    }
    function clearMfaPendingCookie(req, reply) {
        const host = req.headers.host ?? "";
        const origin = req.headers.origin ?? "";
        const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
        reply.clearCookie("proovra_mfa_pending", {
            path: "/",
            domain: isProductionDomain ? ".proovra.com" : undefined,
        });
    }
    // ---------------------------------------------------------------------------
    // PHASE R8.1.2 — login-time MFA gate.
    //
    // Inserts a SECOND-FACTOR checkpoint between primary credential
    // validation and full-session issuance. Reuses the canonical
    // orchestrator (`readMfaStatus`) so step-up and login agree on
    // factor state.
    //
    // Behaviour:
    //   - User has NO active MFA factor      → returns null; caller
    //     proceeds with normal cookie + session issuance.
    //   - User has at least one ACTIVE factor → mints a short-lived
    //     pending token (5-min TTL, single-use) and returns a 200
    //     response body { mfaRequired: true, mfaPendingToken, user }.
    //     The proovra_session cookie is NOT set in this branch.
    //
    // The pending token never leaves the response body (no cookie),
    // and the browser is instructed to keep it in component state
    // ONLY — not localStorage. The frontend exchanges it at
    // `POST /v1/auth/mfa/verify`.
    //
    // Guest sessions are EXEMPT: they have no primary credentials to
    // tie a second factor to. Guest is the only auth flow that bypasses
    // this gate by design.
    // ---------------------------------------------------------------------------
    async function gateLoginWithMfa(req, reply, user, loginMethod) {
        // R8.1.3 — consult both per-user enrollment state AND org policy.
        // The enforcement resolver returns one of three decisions:
        //   NOT_REQUIRED         → normal login, no MFA gate
        //   MFA_REQUIRED         → issue durable challenge + signed token
        //   ENROLLMENT_REQUIRED  → user has no factor but org policy says
        //                          they must — surface a clear next-step
        //                          response, NOT a silent lockout
        //
        // Fail-OPEN on resolver error only — surfacing a 500 in the
        // middle of login would lock every operator out on a transient
        // Prisma blip. The resolver itself emits `auth_login_failed` when
        // that happens so SecOps still sees the event.
        let decision;
        try {
            decision = await resolveLoginMfaEnforcement({
                userId: user.id,
            });
        }
        catch (err) {
            req.log.warn({
                requestId: req.id,
                userId: user.id,
                errorMessage: err instanceof Error ? err.message : "mfa_enforcement_failed",
            }, "auth.mfa_gate_unreachable");
            auditAuthEvent(req, {
                userId: user.id,
                action: "auth.mfa_gate_unreachable",
                severity: "warning",
                outcome: "failure",
                metadata: { loginMethod },
            });
            return { mfaIssued: false };
        }
        if (decision.outcome === "NOT_REQUIRED") {
            return { mfaIssued: false };
        }
        // ENROLLMENT_REQUIRED — user has NO factor but at least one of
        // their teams' policies requires MFA for their role. We do NOT
        // issue a session and we do NOT issue a pending token. The
        // browser routes to /auth/mfa-challenge which detects this state
        // and shows the guided enrollment surface. The user can complete
        // enrollment within the flow; no silent lockout.
        if (decision.outcome === "ENROLLMENT_REQUIRED") {
            auditAuthEvent(req, {
                userId: user.id,
                action: "auth.mfa_enrollment_required",
                outcome: "blocked",
                severity: "warning",
                resourceId: user.id,
                metadata: {
                    loginMethod,
                    policyTeamId: decision.policyTeamId,
                    policyLevel: decision.policyLevel,
                },
            });
            safeEmitSecurityEvent({
                teamId: decision.policyTeamId,
                eventType: "mfa_enrollment_required",
                severity: "WARNING",
                details: {
                    actorUserId: user.id,
                    loginMethod,
                    policyLevel: decision.policyLevel,
                },
            });
            reply.code(403).send({
                mfaRequired: true,
                mfaEnrollmentRequired: true,
                reason: "org_policy_requires_mfa",
                message: "Your organization requires multi-factor authentication. Please enroll an authenticator to continue.",
                user: {
                    id: user.id,
                    email: user.email,
                    provider: user.provider,
                },
            });
            return { mfaIssued: true };
        }
        // MFA_REQUIRED — create durable challenge + sign token whose
        // `sid` is the challenge JTI.
        const challenge = await createMfaPendingChallenge({
            userId: user.id,
            purpose: "LOGIN",
            ipAddress: req.ip ?? null,
            userAgent: readUserAgent(req),
            metadata: { loginMethod },
        });
        const pendingToken = signMfaPendingToken(jwtPayloadFromUser(user), jwtSecret, challenge.jti);
        if (req.headers["x-web-client"] === "1") {
            setMfaPendingCookie(req, reply, pendingToken);
        }
        auditAuthEvent(req, {
            userId: user.id,
            action: "auth.mfa_challenge_issued",
            outcome: "success",
            resourceId: user.id,
            metadata: {
                loginMethod,
                factorCount: decision.activeFactorCount,
                policyTeamId: decision.policyTeamId,
                policyLevel: decision.policyLevel,
            },
        });
        if (decision.policyLevel && decision.policyTeamId) {
            // Emit policy-enforcement event ONLY when the enforcement was
            // actually driven by org policy (not just per-user opt-in).
            safeEmitSecurityEvent({
                teamId: decision.policyTeamId,
                eventType: "org_mfa_policy_enforced",
                severity: "INFO",
                details: {
                    actorUserId: user.id,
                    loginMethod,
                    policyLevel: decision.policyLevel,
                },
            });
        }
        reply.code(200).send({
            mfaRequired: true,
            mfaPendingToken: pendingToken,
            mfaPendingExpiresInSeconds: MFA_PENDING_TTL_SECONDS,
            user: {
                id: user.id,
                email: user.email,
                provider: user.provider,
            },
        });
        return { mfaIssued: true };
    }
    app.post("/v1/auth/guest", async (req, reply) => {
        // Phase 1 — per-IP rate limit on guest-account creation. Each call
        // inserts a User row + JWT signing; unprotected the endpoint is a
        // free guest-account fountain that breaks plan enforcement and
        // inflates the audit log.
        //
        // Phase 2.7Z+ — E2E bypass: when `E2E_AUTH_BYPASS_SECRET` is set
        // (test environments only) AND the request includes a matching
        // `X-E2E-Auth-Bypass` header AND `NODE_ENV !== "production"`,
        // the rate limit is skipped for this request only. Each bypass
        // is logged so any unexpected use in non-test environments is
        // discoverable post-hoc. Production NEVER honors the bypass
        // regardless of env or header.
        const bypassed = shouldBypassAuthRateLimit(req);
        if (bypassed) {
            req.log.info(buildBypassLogPayload(req), "auth.guest.rate_limit_bypassed_e2e");
        }
        const rl = bypassed
            ? { allowed: true, remaining: AUTH_GUEST_RATE_LIMIT_PER_IP_PER_MIN, resetAtMs: Date.now() }
            : await enforceRateLimit({
                key: `auth:guest:ip:${readClientIp(req)}`,
                max: AUTH_GUEST_RATE_LIMIT_PER_IP_PER_MIN,
                windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
            });
        if (!rl.allowed) {
            const retryAfter = Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000));
            req.log.warn({ ip: readClientIp(req), bucket: "ip", retryAfterSec: retryAfter }, "auth.guest.rate_limited");
            auditAuthEvent(req, {
                userId: null,
                action: "auth.guest_session_created",
                outcome: "failure",
                severity: "warning",
                metadata: { reason: "rate_limited" },
            });
            reply.header("Retry-After", String(retryAfter));
            return reply
                .code(429)
                .send({ code: "RATE_LIMITED", message: "Rate limit exceeded" });
        }
        const profile = await createGuestProfile();
        const user = await upsertUser(profile);
        await ensureGuestIdentity(user.id);
        const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
        // Phase 2.5 — record AuthenticatedSession row so /v1/users/me/sessions
        // surfaces guest sessions (Phase 2.4 closed the read path; this
        // closes the write path). Best-effort; never blocks login.
        await recordSessionFromSignedToken(req, user, token);
        maybeSetWebCookie(req, reply, token);
        auditAuthEvent(req, {
            userId: user.id,
            action: "auth.guest_session_created",
            outcome: "success",
            resourceId: user.id,
            metadata: {
                provider: user.provider,
                email: user.email,
            },
        });
        fireRegisterCompletedAnalytics(user.id, req, {
            provider: user.provider,
            method: "guest",
        });
        return reply.code(201).send({ token, user });
    });
    app.post("/v1/auth/google", async (req, reply) => {
        try {
            const body = TokenBody.parse(req.body);
            let idToken = body.idToken ?? body.id_token ?? null;
            if (body.code) {
                idToken = await exchangeGoogleCodeForIdToken(body.code);
            }
            if (!idToken) {
                auditAuthEvent(req, {
                    userId: null,
                    action: "auth.google_login",
                    outcome: "failure",
                    severity: "warning",
                    metadata: { reason: "missing_id_token_or_code" },
                });
                return reply.code(400).send({ message: "invalid_id_token" });
            }
            const profile = await verifyGoogleIdToken(idToken);
            const user = await upsertUser(profile);
            // R8.1.2 — second-factor gate. If the user has an active MFA
            // factor, the helper sends the mfa-required 200 response itself
            // and we return early WITHOUT setting the session cookie.
            const gate = await gateLoginWithMfa(req, reply, user, body.code ? "google_oauth_code" : "google_id_token");
            if (gate.mfaIssued)
                return;
            const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
            fireLoginCompletedAnalytics(user.id, req, {
                provider: user.provider,
                method: body.code ? "oauth_code" : "id_token",
            });
            auditAuthEvent(req, {
                userId: user.id,
                action: "auth.google_login",
                outcome: "success",
                resourceId: user.id,
                metadata: {
                    provider: user.provider,
                    email: user.email,
                    loginMethod: body.code ? "oauth_code" : "id_token",
                },
            });
            maybeSetWebCookie(req, reply, token);
            return reply.code(200).send({ token, user });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "invalid_id_token";
            auditAuthEvent(req, {
                userId: null,
                action: "auth.google_login",
                outcome: "failure",
                severity: "warning",
                metadata: { reason: message },
            });
            if (message === "invalid_code") {
                return reply.code(400).send({
                    message: "invalid_code",
                    hint: "Code may be expired or already used. Ensure GOOGLE_REDIRECT_URI matches exactly.",
                });
            }
            if (message === "redirect_uri_mismatch") {
                return reply.code(400).send({
                    message: "redirect_uri_mismatch",
                    hint: "GOOGLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback",
                });
            }
            if (message === "token_exchange_failed") {
                return reply.code(502).send({ message: "token_exchange_failed" });
            }
            return reply.code(401).send({ message: "invalid_id_token" });
        }
    });
    app.post("/v1/auth/apple", async (req, reply) => {
        try {
            const body = AppleBody.parse(req.body);
            let idToken = body.idToken ?? body.id_token ?? null;
            if (body.code) {
                idToken = await exchangeAppleCodeForIdToken(body.code);
            }
            if (!idToken) {
                auditAuthEvent(req, {
                    userId: null,
                    action: "auth.apple_login",
                    outcome: "failure",
                    severity: "warning",
                    metadata: { reason: "missing_id_token_or_code" },
                });
                return reply.code(400).send({ message: "invalid_id_token" });
            }
            const profile = await verifyAppleIdToken(idToken);
            const user = await upsertUserWithEmailLink(profile);
            // R8.1.2 — second-factor gate (Apple flow parallel to Google).
            const gate = await gateLoginWithMfa(req, reply, user, body.code ? "apple_oauth_code" : "apple_id_token");
            if (gate.mfaIssued)
                return;
            const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
            fireLoginCompletedAnalytics(user.id, req, {
                provider: user.provider,
                method: body.code ? "oauth_code" : "id_token",
            });
            auditAuthEvent(req, {
                userId: user.id,
                action: "auth.apple_login",
                outcome: "success",
                resourceId: user.id,
                metadata: {
                    provider: user.provider,
                    email: user.email,
                    loginMethod: body.code ? "oauth_code" : "id_token",
                },
            });
            maybeSetWebCookie(req, reply, token);
            return reply.code(200).send({ token, user });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "invalid_id_token";
            auditAuthEvent(req, {
                userId: null,
                action: "auth.apple_login",
                outcome: "failure",
                severity: "warning",
                metadata: { reason: message },
            });
            if (message === "invalid_code") {
                return reply.code(400).send({
                    message: "invalid_code",
                    hint: "Code may be expired or already used. Ensure APPLE_REDIRECT_URI matches exactly.",
                });
            }
            if (message === "redirect_uri_mismatch") {
                return reply.code(400).send({
                    message: "redirect_uri_mismatch",
                    hint: "APPLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback",
                });
            }
            if (message === "token_exchange_failed") {
                return reply.code(502).send({ message: "token_exchange_failed" });
            }
            if (message === "apple_jwks_fetch_failed") {
                return reply.code(502).send({ message: "apple_jwks_fetch_failed" });
            }
            return reply.code(401).send({ message: "invalid_id_token" });
        }
    });
    app.post("/v1/auth/email/register", async (req, reply) => {
        const body = EmailRegisterBody.parse(req.body);
        const user = await registerWithEmailPassword({
            email: body.email,
            password: body.password,
            displayName: body.displayName ?? null,
        });
        const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
        // Phase 2.5 — record AuthenticatedSession on first email/password
        // register so the new user immediately sees the session in
        // /v1/users/me/sessions. Best-effort.
        await recordSessionFromSignedToken(req, user, token);
        maybeSetWebCookie(req, reply, token);
        auditAuthEvent(req, {
            userId: user.id,
            action: "auth.email_register",
            outcome: "success",
            resourceId: user.id,
            metadata: {
                provider: user.provider,
                email: user.email,
                displayName: body.displayName ?? null,
            },
        });
        fireRegisterCompletedAnalytics(user.id, req, {
            provider: user.provider,
            method: "email_password",
        });
        return reply.code(201).send({ token, user });
    });
    app.post("/v1/auth/email/login", async (req, reply) => {
        // Phase E10.1 — DEF-037 closure. Per-IP rate limit to defeat
        // credential-stuffing / password-spray attacks at ingress. The
        // bucket is bounded; legitimate users typing wrong passwords a
        // few times stay well under it. Returns 429 with no enumeration
        // detail.
        const rl = await enforceRateLimit({
            key: `auth:email-login:ip:${readClientIp(req)}`,
            max: AUTH_LOGIN_RATE_LIMIT_PER_IP_PER_MIN,
            windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
        });
        if (!rl.allowed) {
            auditAuthEvent(req, {
                userId: null,
                action: "auth.email_login",
                outcome: "blocked",
                severity: "warning",
                metadata: { reason: "rate_limited", scope: "ip" },
            });
            return reply
                .code(429)
                .header("Retry-After", String(Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000))))
                .send({ message: "too_many_requests" });
        }
        const body = EmailLoginBody.parse(req.body);
        const user = await loginWithEmailPassword({
            email: body.email,
            password: body.password,
        });
        if (!user) {
            auditAuthEvent(req, {
                userId: null,
                action: "auth.email_login",
                outcome: "failure",
                severity: "warning",
                metadata: {
                    email: body.email,
                    reason: "invalid_credentials",
                },
            });
            return reply.code(401).send({ message: "invalid_credentials" });
        }
        // R8.1.2 — second-factor gate. Email/password is the primary
        // attack surface for credential stuffing; MFA matters most here.
        const gate = await gateLoginWithMfa(req, reply, user, "email_password");
        if (gate.mfaIssued)
            return;
        const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
        // Phase 2.5 — record AuthenticatedSession for the user-facing
        // sessions inventory. Best-effort; never blocks login.
        await recordSessionFromSignedToken(req, user, token);
        fireLoginCompletedAnalytics(user.id, req, {
            provider: user.provider,
            method: "email_password",
        });
        auditAuthEvent(req, {
            userId: user.id,
            action: "auth.email_login",
            outcome: "success",
            resourceId: user.id,
            metadata: {
                provider: user.provider,
                email: user.email,
            },
        });
        maybeSetWebCookie(req, reply, token);
        return reply.code(200).send({ token, user });
    });
    app.post("/v1/auth/password-reset/request", async (req, reply) => {
        // Phase E10.1 — DEF-037 closure. Per-IP rate limit to defeat
        // password-reset abuse (mailbox flooding + enumeration via timing).
        // Bucket is tighter than login because legitimate users rarely
        // request password resets more than a handful of times per minute.
        const rl = await enforceRateLimit({
            key: `auth:password-reset:ip:${readClientIp(req)}`,
            max: AUTH_PASSWORD_RESET_RATE_LIMIT_PER_IP_PER_MIN,
            windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
        });
        if (!rl.allowed) {
            auditAuthEvent(req, {
                userId: null,
                action: "auth.password_reset_requested",
                outcome: "blocked",
                severity: "warning",
                metadata: { reason: "rate_limited", scope: "ip" },
            });
            // Return the same 200 shape that the normal handler returns so
            // we do NOT leak enumeration information via the response shape.
            return reply
                .code(429)
                .header("Retry-After", String(Math.max(1, Math.ceil((rl.resetAtMs - Date.now()) / 1000))))
                .send({ message: "too_many_requests" });
        }
        const body = PasswordResetRequestBody.parse(req.body);
        try {
            const result = await createPasswordResetTokenForEmail(body.email);
            auditAuthEvent(req, {
                userId: null,
                action: "auth.password_reset_requested",
                outcome: "success",
                metadata: {
                    email: body.email,
                    userMatched: Boolean(result),
                },
            });
            if (!result) {
                return reply.code(200).send({ ok: true });
            }
            const webBase = process.env.WEB_BASE_URL || "https://www.proovra.com";
            const resetUrl = `${webBase.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(result.rawToken)}`;
            try {
                const emailService = getEmailService();
                await emailService.sendPasswordResetEmail(body.email, resetUrl);
            }
            catch {
                auditAuthEvent(req, {
                    userId: null,
                    action: "auth.password_reset_email_send",
                    outcome: "failure",
                    severity: "warning",
                    metadata: {
                        email: body.email,
                    },
                });
            }
            return reply.code(200).send({ ok: true });
        }
        catch {
            auditAuthEvent(req, {
                userId: null,
                action: "auth.password_reset_requested",
                outcome: "failure",
                severity: "warning",
                metadata: {
                    email: body.email,
                    reason: "request_failed",
                },
            });
            return reply.code(200).send({ ok: true });
        }
    });
    app.post("/v1/auth/password-reset/confirm", async (req, reply) => {
        const body = PasswordResetConfirmBody.parse(req.body);
        const res = await resetPasswordWithToken({
            token: body.token,
            newPassword: body.newPassword,
        });
        if (!res.ok) {
            auditAuthEvent(req, {
                userId: null,
                action: "auth.password_reset_confirm",
                outcome: "failure",
                severity: "warning",
                metadata: {
                    reason: res.reason,
                },
            });
            return reply.code(400).send({ message: res.reason });
        }
        auditAuthEvent(req, {
            userId: null,
            action: "auth.password_reset_confirm",
            outcome: "success",
            metadata: {
                passwordChanged: true,
            },
        });
        return reply.code(200).send({ ok: true });
    });
    // ---------------------------------------------------------------------------
    // PHASE R8.1.2 — login-time MFA verify.
    //
    // Accepts the short-lived pending token issued by `gateLoginWithMfa`
    // PLUS either a TOTP `code` OR a one-time `recoveryCode`. Delegates
    // the cryptographic check to the canonical orchestrator (the same
    // path step-up uses), so the verification logic exists in EXACTLY
    // one place.
    //
    // On success: issues the canonical session JWT + cookie (identical
    //   to a non-MFA login).
    // On failure: 401 + bounded reason, audit + security event.
    //
    // Rate-limited per-userId (5 attempts / 60 s). The pending token's
    // sid is consumed on FIRST verify attempt so even a successful
    // login cannot reuse it to issue a second session.
    // ---------------------------------------------------------------------------
    app.post("/v1/auth/mfa/verify", async (req, reply) => {
        // The pending token may arrive either as a body field (JSON
        // clients) OR as the `proovra_mfa_pending` HTTP-only cookie
        // (browser SSO flow). The body wins if both are present; we
        // still clear the cookie on every code path so a stale pending
        // cookie cannot linger past one verify attempt.
        const cookiePending = req.cookies
            ?.proovra_mfa_pending ?? null;
        const rawBody = typeof req.body === "object" && req.body !== null
            ? req.body
            : {};
        const candidateBody = {
            mfaPendingToken: typeof rawBody.mfaPendingToken === "string"
                ? rawBody.mfaPendingToken
                : cookiePending ?? "",
            code: rawBody.code,
            recoveryCode: rawBody.recoveryCode,
        };
        const parsed = LoginMfaVerifyBody.safeParse(candidateBody);
        if (!parsed.success) {
            clearMfaPendingCookie(req, reply);
            return reply.code(400).send({ message: "invalid_body" });
        }
        const body = parsed.data;
        // 1) Verify the pending token SIGNATURE. R8.1.3 moved the
        //    actual replay-protection check off the in-process deny list
        //    and onto the durable `MfaPendingChallenge` row (consumed
        //    below in step 2.5 with a single atomic UPDATE).
        let pendingPayload;
        try {
            pendingPayload = verifyMfaPendingTokenSignature(body.mfaPendingToken, jwtSecret);
        }
        catch (err) {
            clearMfaPendingCookie(req, reply);
            const reason = err instanceof Error ? err.message : "pending_token_invalid";
            auditAuthEvent(req, {
                userId: null,
                action: "auth.mfa_verify",
                outcome: "failure",
                severity: "warning",
                metadata: { reason },
            });
            safeEmitSecurityEvent({
                teamId: null,
                eventType: "auth_login_failed",
                severity: "WARNING",
                details: { reason: "mfa_pending_token_invalid" },
            });
            return reply.code(401).send({ message: "mfa_pending_invalid" });
        }
        const userId = pendingPayload.sub;
        const challengeJti = typeof pendingPayload.sid === "string" ? pendingPayload.sid : null;
        if (!challengeJti) {
            // Should never happen — signMfaPendingToken always sets sid.
            clearMfaPendingCookie(req, reply);
            return reply.code(401).send({ message: "mfa_pending_invalid" });
        }
        if (loginMfaIsRateLimited(userId)) {
            auditAuthEvent(req, {
                userId,
                action: "auth.mfa_verify",
                outcome: "blocked",
                severity: "warning",
                metadata: { reason: "rate_limited" },
            });
            return reply.code(429).send({ message: "rate_limited" });
        }
        // 2) Verify the second factor. Exactly one of code|recoveryCode
        //    was guaranteed by zod refine().
        let verifyOk = false;
        let verifyMethod = "totp";
        if (body.code) {
            verifyMethod = "totp";
            const r = await verifyActiveTotp({
                userId,
                code: body.code,
            });
            verifyOk = r.ok;
        }
        else if (body.recoveryCode) {
            verifyMethod = "recovery_code";
            const r = await consumeRecoveryCode({
                userId,
                code: body.recoveryCode,
                ipAddress: req.ip ?? null,
            });
            verifyOk = r.ok;
        }
        if (!verifyOk) {
            // Do NOT clear the pending cookie here — the user may retry
            // within the 5-min window. Rate-limit above bounds the retries.
            // Bump the challenge's per-row failure counter for forensics.
            void recordPendingChallengeFailure(challengeJti);
            auditAuthEvent(req, {
                userId,
                action: "auth.mfa_verify",
                outcome: "failure",
                severity: "warning",
                metadata: { method: verifyMethod },
            });
            safeEmitSecurityEvent({
                teamId: null,
                eventType: "auth_login_failed",
                severity: "WARNING",
                details: {
                    actorUserId: userId,
                    phase: "mfa_verify",
                    method: verifyMethod,
                },
            });
            return reply.code(401).send({ message: "mfa_invalid" });
        }
        // 2.5) Atomically consume the durable pending challenge. This is
        //      R8.1.3's source-of-truth replay check — works across
        //      instances/regions because the WHERE clause includes
        //      `consumedAt: null` AND `expiresAt > now`. If a parallel
        //      verify already won the race (replay) or the challenge
        //      expired between signature-verify and now, this fails.
        const consume = await consumeMfaPendingChallenge({
            jti: challengeJti,
            expectedUserId: userId,
            expectedPurpose: "LOGIN",
        });
        if (!consume.ok) {
            clearMfaPendingCookie(req, reply);
            auditAuthEvent(req, {
                userId,
                action: "auth.mfa_verify",
                outcome: "failure",
                severity: "warning",
                metadata: {
                    reason: consume.reason ?? "challenge_consume_failed",
                    method: verifyMethod,
                },
            });
            const msg = consume.reason === "expired"
                ? "mfa_challenge_expired"
                : consume.reason === "already_consumed"
                    ? "mfa_challenge_already_used"
                    : "mfa_pending_invalid";
            return reply.code(401).send({ message: msg });
        }
        // 3) Success — load user (re-fetch so we get current platformRole
        //    and provider) and issue the canonical session.
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            // Vanishingly rare: pending token was issued but the user was
            // hard-deleted in the 5-minute window. Fail closed.
            return reply.code(401).send({ message: "user_not_found" });
        }
        const token = signJwt(jwtPayloadFromUser({
            id: user.id,
            provider: user.provider,
            email: user.email,
            platformRole: user.platformRole,
        }), jwtSecret, 60 * 60 * 24 * 30);
        fireLoginCompletedAnalytics(user.id, req, {
            provider: user.provider,
            method: `mfa_${verifyMethod}`,
        });
        auditAuthEvent(req, {
            userId: user.id,
            action: "auth.mfa_verify",
            outcome: "success",
            resourceId: user.id,
            metadata: { method: verifyMethod },
        });
        // Clear the pending cookie + set the canonical session cookie
        // in a single response. After this point the pending token is
        // useless — the durable challenge row's `consumedAt` was flipped
        // atomically above, so any replay attempt is rejected by the
        // database before any side effect can occur.
        void consume; // keep var alive for telemetry diff in followups
        clearMfaPendingCookie(req, reply);
        maybeSetWebCookie(req, reply, token);
        return reply.code(200).send({ token, user });
    });
    app.post("/v1/auth/logout", async (req, reply) => {
        let userId = null;
        try {
            const authHeader = req.headers.authorization ?? "";
            const bearer = authHeader.startsWith("Bearer ")
                ? authHeader.slice(7).trim()
                : "";
            if (bearer) {
                const payload = verifyJwt(bearer, jwtSecret);
                userId = payload.sub;
            }
        }
        catch {
            // noop
        }
        if (req.headers["x-web-client"] === "1") {
            const host = req.headers.host ?? "";
            const origin = req.headers.origin ?? "";
            const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
            reply.clearCookie("proovra_session", {
                path: "/",
                domain: isProductionDomain ? ".proovra.com" : undefined,
            });
        }
        auditAuthEvent(req, {
            userId,
            action: "auth.logout",
            outcome: "success",
            metadata: {
                webClient: req.headers["x-web-client"] === "1",
            },
        });
        return reply.code(200).send({ ok: true });
    });
    app.get("/v1/auth/me", { preHandler: requireAuth }, async (req) => {
        const userId = getAuthUserId(req);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            return { user: null };
        return {
            user: {
                id: user.id,
                email: user.email,
                displayName: user.displayName,
                firstName: user.firstName,
                lastName: user.lastName,
                avatarUrl: user.avatarUrl,
                locale: user.locale,
                timezone: user.timezone,
                country: user.country,
                bio: user.bio,
                provider: user.provider,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
                ...(user.platformRole === "admin" ? { role: "admin" } : {}),
            },
        };
    });
    // ---------------------------------------------------------------------------
    // PHASE R8.1.9 — session-light: lightweight "am I signed in?" probe.
    //
    // UX-ONLY endpoint. Returns ONLY { authenticated: boolean }. Never
    // returns user id, email, team, workspace, role, capabilities,
    // pending MFA state, or error detail. Used by surfaces (e.g. the
    // MFA recovery verify page) that need to choose between
    // "Continue to home" vs "Return to sign in" without revealing
    // whose session is present.
    //
    // Hard rules:
    //   - NEVER mutates session state.
    //   - NEVER refreshes the session cookie.
    //   - Pending MFA tokens (mfa: "pending") are NOT authenticated.
    //   - Invalid / expired / missing tokens collapse to false.
    //   - Failure to read the session revocation registry collapses
    //     to false (fail-closed for the boolean — better to send
    //     the user back to /login on a Prisma blip than to spuriously
    //     claim a session exists).
    // ---------------------------------------------------------------------------
    app.get("/v1/auth/session-light", async (req, _reply) => {
        try {
            const authHeader = req.headers.authorization ?? "";
            const bearer = authHeader.startsWith("Bearer ")
                ? authHeader.slice(7).trim()
                : "";
            const cookieToken = req.cookies
                ?.proovra_session ?? null;
            const token = bearer || cookieToken;
            if (!token)
                return { authenticated: false };
            const payload = verifyJwt(token, jwtSecret);
            // Pending MFA tokens are NOT a session — they only authorize
            // the verify-mfa endpoint.
            if (payload.mfa === "pending")
                return { authenticated: false };
            // Confirm the session is not on the revocation deny list.
            // We don't fail open on a registry read error — the boolean
            // collapses to false.
            const sid = typeof payload.sid === "string" ? payload.sid : null;
            const iat = typeof payload.iat === "number" ? payload.iat : null;
            try {
                const { isSessionRevoked, hashSessionId } = await import("../services/identity-security/session-revocation.service.js");
                const revoked = await isSessionRevoked({
                    userId: payload.sub,
                    sessionIdHash: sid ? hashSessionId(sid) : null,
                    iat,
                });
                if (revoked)
                    return { authenticated: false };
            }
            catch {
                return { authenticated: false };
            }
            return { authenticated: true };
        }
        catch {
            // Invalid signature, expired token, malformed payload —
            // collapse to false. NEVER expose the specific reason.
            return { authenticated: false };
        }
    });
}
