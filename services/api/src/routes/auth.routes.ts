import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import {
  exchangeAppleCodeForIdToken,
  exchangeGoogleCodeForIdToken,
  upsertUser,
  upsertUserWithEmailLink,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from "../services/auth.service.js";

import {
  registerWithEmailPassword,
  loginWithEmailPassword,
  createPasswordResetTokenForEmail,
  resetPasswordWithToken,
  isEmailAvailableForRegistration,
  EmailAlreadyExistsError,
} from "../services/email-password-auth.service.js";
import {
  dispatchVerificationEmail,
  processResendVerification,
  confirmVerificationToken,
} from "../services/email-verification.service.js";

import { getEmailService } from "../services/email.service.js";
import { getSecret } from "../config/runtime-secrets.js";
import { requireAuth } from "../middleware/auth.js";
import { toAuthUserProjection } from "../http/auth-user-projection.js";
import { prisma } from "../db.js";
import {
  signJwt,
  verifyJwt,
  signMfaPendingToken,
  verifyMfaPendingTokenSignature,
  MFA_PENDING_TTL_SECONDS,
} from "../services/jwt.js";
import type { AuthProvenanceMethod } from "../services/jwt.js";
import { getAuthUserId } from "../auth.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import {
  verifyActiveTotp,
  consumeRecoveryCode,
  createMfaPendingChallenge,
  consumeMfaPendingChallenge,
  recordPendingChallengeFailure,
} from "../services/security/mfa.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { resolveLoginMfaEnforcement } from "../services/security/login-mfa-enforcement.service.js";
// PHASE 13 §1.4 — the canonical trusted-client-IP binding; see `readClientIp`.
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit, clearAllRateLimitBuckets } from "../services/rate-limit.js";
// Phase 2.7Z+ — E2E auth rate-limit bypass (env-gated, production-safe).
// See services/api/src/services/auth-test-bypass.ts for the three
// layers of defense and the operational rules.
// Phase 2.5 — record the AuthenticatedSession row for non-SAML/SSO
// login paths so the user-facing `/v1/users/me/sessions` list is not
// empty for email-password users (Phase 2.4 finding).
import { recordAuthenticatedSession } from "../services/access-control/session-inventory.service.js";
// PHASE 11 — canonical internal URL builder (destination-URL construction
// only; this file's identity/session/MFA logic is untouched).
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

// Phase E10.1 — DEF-037 closure. Per-IP rate limits on the public,
// unauthenticated email login and password-reset-request surfaces.
// Bucket sizes are deliberately tight to defeat credential stuffing
// while still tolerating normal user retries (typo → retry within the
// minute).
const AUTH_LOGIN_RATE_LIMIT_PER_IP_PER_MIN = 10;
const AUTH_PASSWORD_RESET_RATE_LIMIT_PER_IP_PER_MIN = 5;
const AUTH_RATE_LIMIT_WINDOW_SEC = 60;
// Email-register + availability are unauthenticated public surfaces.
// Both can be scripted to flood the user table (register) or scrape
// existence (availability). Tight buckets; legitimate humans are
// already nowhere near these counts.
const AUTH_REGISTER_RATE_LIMIT_PER_IP_PER_MIN = 5;
const AUTH_EMAIL_AVAILABILITY_RATE_LIMIT_PER_IP_PER_MIN = 30;
// EV4 — verification + resend per-IP buckets. The per-email
// cooldown (60 s) lives in email-verification.service.ts so the
// route stays thin.
const AUTH_EMAIL_VERIFY_RATE_LIMIT_PER_IP_PER_MIN = 10;
const AUTH_EMAIL_RESEND_RATE_LIMIT_PER_IP_PER_MIN = 3;

/**
 * PHASE 13 §1.4 — the sixth copy of the client-IP decision, on the surface
 * where getting it wrong matters most.
 *
 * This keyed every public auth limiter — registration, LOGIN, password-reset
 * request, email verification and resend — on `req.ip`. That reads as the
 * caller's address and is one on a deployment with no proxy declared. It is
 * NOT one when `API_TRUST_PROXY` is set, which is what every deployment behind
 * a load balancer sets: Fastify then DERIVES `req.ip` from `X-Forwarded-For`,
 * taking the leftmost entry, which the caller supplies.
 *
 * Measured on a trusting instance:
 *
 *     X-Forwarded-For: 10.0.0.1, 192.168.1.5, 127.0.0.1
 *     req.ip → "10.0.0.1"   (the caller's own bytes, not the peer)
 *
 * So on production the per-IP bound on LOGIN and on PASSWORD-RESET REQUEST was
 * defeated by rotating one header — the same defect PHASE1-002 and PHASE1-003
 * recorded on the public intake surfaces, on a surface where the bound is
 * brute-force protection rather than spam control.
 *
 * `trustedClientIpKey` is the canonical binding those two rows converged on.
 * Using it here means this file no longer decides who the caller is; it asks
 * the one authority that does, and inherits its private-hop skipping, its
 * CF-Connecting-IP precedence, and its socket fallback.
 */
function readClientIp(req: FastifyRequest): string {
  return trustedClientIpKey(req).slice(0, 200);
}

// Shared 429 reply — every public auth route returns this exact
// shape on rate-limit hits. Single helper keeps the file small.
function replyRateLimited(reply: FastifyReply, resetAtMs: number) {
  return reply
    .code(429)
    .header("Retry-After", String(Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))))
    .send({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again shortly.",
        timestamp: new Date().toISOString(),
      },
    });
}

// Phase 2.5 — session inventory recording helpers.
//
// These helpers mirror the SAML / SSO route helpers (saml-auth.routes.ts:89-103)
// so the AuthenticatedSession `ipPreview` + `uaPreview` shapes stay
// consistent across login providers. They are display-only previews,
// NEVER raw IP / UA.
function authIpPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
  }
  return ip.slice(0, 10) + "…";
}

function authUaPreview(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 120);
}

/**
 * Phase 2.5 — record an AuthenticatedSession row after signing a
 * non-SAML/SSO JWT.
 *
 * Pre-Phase-2.5 the email-password login path called `signJwt()`
 * directly and skipped the session-inventory write. This meant
 * `GET /v1/users/me/sessions` returned `[]` for those users
 * (Phase 2.4 finding). The recording is best-effort: an inventory
 * write failure must NEVER break login.
 *
 * `signJwt()` already mints a random `sid` internally; we extract it
 * by base64-decoding the resulting token payload. This avoids any
 * change to signJwt's signature and keeps every existing caller's
 * behavior identical for the token value.
 *
 * `teamId` is NULL for fresh email-password tokens — the
 * AuthenticatedSession schema permits null teamId rows (workspace-less
 * sessions). The user-facing sessions endpoint already handles that
 * case (Phase 2.4).
 */
async function recordSessionFromSignedToken(
  req: FastifyRequest,
  user: { id: string; currentWorkspaceId?: string | null },
  token: string,
): Promise<void> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return;
    const payloadJson = Buffer.from(parts[1] ?? "", "base64url").toString(
      "utf8",
    );
    const payload = JSON.parse(payloadJson) as {
      sid?: string;
      iat?: number;
      exp?: number;
    };
    if (
      typeof payload.sid !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
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
  } catch {
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
  .refine(
    (v) => Boolean(v.code) !== Boolean(v.recoveryCode),
    "exactly_one_of_code_or_recoveryCode",
  );

// PHASE R8.1.2 — process-local rate limiter for the MFA verify route.
// Identical bounds to `mfa.routes.ts` so the two surfaces behave
// uniformly. Keyed by userId (NOT by IP) because the pending token
// already binds to a specific user; an attacker spraying many user
// ids against the endpoint would still need a valid pending token
// per user.
const LOGIN_MFA_ATTEMPT_WINDOW_MS = 60_000;
const LOGIN_MFA_ATTEMPT_MAX = 5;
// Enterprise launch hardening — the MFA-verify attempt limit is backed by
// the shared rate limiter (Redis when REDIS_URL is configured; in-memory
// fallback in dev/test). This makes the per-userId MFA throttle safe across
// multiple API instances — an in-memory Map per process would let an
// attacker multiply the attempt budget by the instance count. The key is
// scoped by user id only; it carries no secrets. Fail-safe is preserved:
// enforceRateLimit degrades to its in-memory store if Redis is unreachable.
async function loginMfaIsRateLimited(userId: string): Promise<boolean> {
  const result = await enforceRateLimit({
    key: `mfa-verify:${userId}`,
    max: LOGIN_MFA_ATTEMPT_MAX,
    windowSec: Math.round(LOGIN_MFA_ATTEMPT_WINDOW_MS / 1000),
  });
  return !result.allowed;
}

/** TEST-ONLY rate-limit reset — exported for the contract tests. */
export async function __resetLoginMfaRateLimiterForTests(): Promise<void> {
  await clearAllRateLimitBuckets();
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

/**
 * PHASE 11 §3 Batch B — genuinely GLOBAL platform auth events: login,
 * registration, password reset, MFA gate. None of these carry a proven
 * Workspace/Organization subject at this layer (pre-session, or the user's
 * own account) → routed through `emitPlatformAudit`, never a fabricated
 * tenant scope.
 */
function auditAuthEvent(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  const outcome =
    params.outcome === "failure" ? "error" : params.outcome === "blocked" ? "denied" : "success";
  const reason = params.metadata?.["reason"];
  void emitPlatformAudit({
    action: params.action,
    outcome,
    denialReason: outcome === "denied" ? (typeof reason === "string" ? reason : params.action) : null,
    sourceApp: "API",
    actorUserId: params.userId,
    resourceType: "user_auth",
    resourceId: params.resourceId ?? params.userId ?? null,
    correlationId: req.id,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
  }).catch(() => null);
}

function fireLoginCompletedAnalytics(
  userId: string,
  req?: FastifyRequest,
  metadata?: Record<string, unknown>
): void {
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

function fireRegisterCompletedAnalytics(
  userId: string,
  req?: FastifyRequest,
  metadata?: Record<string, unknown>
): void {
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

export async function authRoutes(app: FastifyInstance) {
  // Phase P2.0 — read once at route-registration time (after
  // `initSecretsManager` has run). AWS first, env fallback.
  const jwtSecret = getSecret("AUTH_JWT_SECRET");
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }

  function jwtPayloadFromUser(
    user: {
      id: string;
      provider: string;
      email: string | null;
      platformRole?: string | null;
    },
    // PHASE 10 §10.2 — server-verified authentication provenance. REQUIRED at
    // every mint so no session is ambiguous (provider "EMAIL" no longer
    // implies the ceremony).
    authMethod: AuthProvenanceMethod,
  ) {
    return {
      sub: user.id,
      provider: user.provider,
      email: user.email,
      authMethod,
      authAt: Math.floor(Date.now() / 1000),
      ...(user.platformRole === "admin" ? { role: "admin" as const } : {}),
    };
  }

  function maybeSetWebCookie(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string
  ) {
    if (req.headers["x-web-client"] !== "1") {
      return;
    }

    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const isProductionDomain =
      host.includes("proovra.com") || origin.includes("proovra.com");

    const cookieOpts = isProductionDomain
      ? {
          httpOnly: true,
          secure: true,
          sameSite: "lax" as const,
          path: "/",
          domain: ".proovra.com",
          maxAge: 60 * 60 * 24 * 30,
        }
      : {
          httpOnly: true,
          secure: false,
          sameSite: "lax" as const,
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
  function setMfaPendingCookie(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ) {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const isProductionDomain =
      host.includes("proovra.com") || origin.includes("proovra.com");
    const cookieOpts = isProductionDomain
      ? {
          httpOnly: true,
          secure: true,
          sameSite: "lax" as const,
          path: "/",
          domain: ".proovra.com",
          maxAge: MFA_PENDING_TTL_SECONDS,
        }
      : {
          httpOnly: true,
          secure: false,
          sameSite: "lax" as const,
          path: "/",
          domain: undefined,
          maxAge: MFA_PENDING_TTL_SECONDS,
        };
    reply.setCookie("proovra_mfa_pending", token, cookieOpts);
  }

  function clearMfaPendingCookie(req: FastifyRequest, reply: FastifyReply) {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const isProductionDomain =
      host.includes("proovra.com") || origin.includes("proovra.com");
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
  // ---------------------------------------------------------------------------
  async function gateLoginWithMfa(
    req: FastifyRequest,
    reply: FastifyReply,
    user: {
      id: string;
      provider: string;
      email: string | null;
      platformRole?: string | null;
    },
    loginMethod: string,
  ): Promise<{ mfaIssued: boolean }> {
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
    let decision: Awaited<ReturnType<typeof resolveLoginMfaEnforcement>>;
    try {
      decision = await resolveLoginMfaEnforcement({
        userId: user.id,
      });
    } catch (err) {
      req.log.warn(
        {
          requestId: req.id,
          userId: user.id,
          errorMessage:
            err instanceof Error ? err.message : "mfa_enforcement_failed",
        },
        "auth.mfa_gate_unreachable",
      );
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
        message:
          "Your organization requires multi-factor authentication. Please enroll an authenticator to continue.",
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
    const pendingToken = signMfaPendingToken(
      jwtPayloadFromUser(user, "PASSWORD"),
      jwtSecret as string,
      challenge.jti,
    );
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
      const gate = await gateLoginWithMfa(
        req,
        reply,
        user,
        body.code ? "google_oauth_code" : "google_id_token",
      );
      if (gate.mfaIssued) return;

      const token = signJwt(jwtPayloadFromUser(user, "SOCIAL_OAUTH"), jwtSecret, 60 * 60 * 24 * 30);

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

      // Session-inventory parity (2026-07-16). OAuth logins previously
      // set the session cookie WITHOUT writing an AuthenticatedSession
      // row, so `/settings/security` showed "No active sessions found"
      // for Google users while they were signed in. Recording happens
      // AFTER the MFA gate (an mfa-required response returns early
      // above, so an incomplete login never creates a session row) and
      // uses the SAME canonical helper as the email-password path —
      // one session model for every provider.
      await recordSessionFromSignedToken(req, user, token);
      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user: toAuthUserProjection(user) });
    } catch (err) {
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
      const gate = await gateLoginWithMfa(
        req,
        reply,
        user,
        body.code ? "apple_oauth_code" : "apple_id_token",
      );
      if (gate.mfaIssued) return;

      const token = signJwt(jwtPayloadFromUser(user, "SOCIAL_OAUTH"), jwtSecret, 60 * 60 * 24 * 30);

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

      // Session-inventory parity (2026-07-16) — same rationale as the
      // Google path above: record via the canonical helper after the MFA
      // gate so Apple sessions appear in the user's session inventory.
      await recordSessionFromSignedToken(req, user, token);
      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user: toAuthUserProjection(user) });
    } catch (err) {
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
    // Per-IP register rate limit. Mirrors login limit but tighter
    // (registration is even more abuse-prone — it creates User rows).
    const rl = await enforceRateLimit({
      key: `auth:email-register:ip:${readClientIp(req)}`,
      max: AUTH_REGISTER_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
    });
    if (!rl.allowed) {
      auditAuthEvent(req, {
        userId: null,
        action: "auth.email_register",
        outcome: "blocked",
        severity: "warning",
        metadata: { reason: "rate_limited", scope: "ip" },
      });
      return replyRateLimited(reply, rl.resetAtMs);
    }

    const body = EmailRegisterBody.parse(req.body);

    let user;
    try {
      user = await registerWithEmailPassword({
        email: body.email,
        password: body.password,
        displayName: body.displayName ?? null,
      });
    } catch (err) {
      if (err instanceof EmailAlreadyExistsError) {
        auditAuthEvent(req, {
          userId: null,
          action: "auth.email_register",
          outcome: "failure",
          severity: "info",
          metadata: { reason: "email_already_exists", email: body.email },
        });
        return reply.code(409).send({
          error: {
            code: "EMAIL_ALREADY_EXISTS",
            message: "An account already exists for this email.",
            timestamp: new Date().toISOString(),
          },
        });
      }
      throw err;
    }

    // EV4 — email registrations no longer issue a session. The
    // user must prove ownership of the inbox via the verification
    // email; only the verify endpoint mints a JWT. Google/Apple
    // routes above are unaffected (OAuth pre-verifies upstream).
    const toEmail = user.email ?? body.email;
    const dispatch = await dispatchVerificationEmail({
      userId: user.id,
      toEmail,
    });
    if (!dispatch.delivered) {
      auditAuthEvent(req, {
        userId: user.id,
        action: "auth.email_verification_send",
        outcome: "failure",
        severity: "warning",
        metadata: { email: toEmail, error: dispatch.error },
      });
    }

    auditAuthEvent(req, {
      userId: user.id,
      action: "auth.email_register",
      outcome: "success",
      resourceId: user.id,
      metadata: {
        provider: user.provider,
        email: user.email,
        displayName: body.displayName ?? null,
        verificationSent: dispatch.delivered,
      },
    });

    fireRegisterCompletedAnalytics(user.id, req, {
      provider: user.provider,
      method: "email_password",
    });

    return reply.code(201).send({
      verificationSent: dispatch.delivered,
      email: toEmail,
    });
  });

  // Public, unauthenticated availability check for the register page.
  // Returns only { available: boolean } — never names, IDs, providers,
  // or any other user metadata. Rate-limited per IP to make scripted
  // enumeration uneconomical. Format errors return { available: false,
  // reason: "INVALID_FORMAT" } so the UI can distinguish them from a
  // real existence hit.
  app.get("/v1/auth/email/availability", async (req, reply) => {
    const rl = await enforceRateLimit({
      key: `auth:email-availability:ip:${readClientIp(req)}`,
      max: AUTH_EMAIL_AVAILABILITY_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
    });
    if (!rl.allowed) {
      return replyRateLimited(reply, rl.resetAtMs);
    }

    const query = (req.query ?? {}) as Record<string, unknown>;
    const emailRaw = typeof query.email === "string" ? query.email : "";

    const parsed = z.string().email().safeParse(emailRaw);
    if (!parsed.success) {
      return reply.code(200).send({ available: false, reason: "INVALID_FORMAT" });
    }

    const available = await isEmailAvailableForRegistration(parsed.data);
    if (available) {
      return reply.code(200).send({ available: true });
    }
    return reply.code(200).send({ available: false, reason: "EMAIL_ALREADY_EXISTS" });
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
        .send({
          error: {
            code: "RATE_LIMITED",
            message:
              "Too many sign-in attempts. Wait a minute and try again.",
            timestamp: new Date().toISOString(),
          },
        });
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

      /*
       * ONE ANSWER FOR BOTH FAILURES.
       *
       * Unknown email and wrong password arrive here through the same branch
       * and leave through this same response, byte for byte. That is the
       * anti-enumeration contract and it is unchanged — `loginWithEmailPassword`
       * returns null for "no such account", "account has no password" and
       * "password did not match" alike, and this route never learns which.
       *
       * What changed is the SHAPE. It used to answer `{ message:
       * "invalid_credentials" }`, which carries no `error.code`, so the web
       * client could not recognise it and fell back to bucketing by HTTP
       * status. The 401 bucket means "your session expired" — correct
       * everywhere inside the app, and actively wrong on the sign-in page,
       * where it told a person who had simply mistyped their password that
       * their session had expired and they should sign in again. They were
       * signing in.
       *
       * The code is the canonical `INVALID_CREDENTIALS` the platform's own
       * ErrorCode enum already defines at 401, and the message is the safe
       * sentence a person can act on. It names neither the email nor the
       * password as the thing that was wrong, because the server does not
       * know and must not appear to.
       */
      return reply.code(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Email or password is incorrect.",
          timestamp: new Date().toISOString(),
        },
      });
    }

    // EV4 — verify gate: run AFTER credential check (response shape
    // identical to wrong-password) but BEFORE MFA (don't fingerprint
    // MFA status on unverified accounts).
    if (!user.emailVerifiedAt) {
      auditAuthEvent(req, {
        userId: user.id,
        action: "auth.email_login",
        outcome: "failure",
        severity: "info",
        metadata: {
          email: body.email,
          reason: "email_not_verified",
        },
      });
      return reply.code(403).send({
        error: {
          code: "EMAIL_NOT_VERIFIED",
          message: "Please verify your email address before signing in.",
          timestamp: new Date().toISOString(),
        },
      });
    }

    // R8.1.2 — second-factor gate. Email/password is the primary
    // attack surface for credential stuffing; MFA matters most here.
    const gate = await gateLoginWithMfa(req, reply, user, "email_password");
    if (gate.mfaIssued) return;

    const token = signJwt(jwtPayloadFromUser(user, "PASSWORD"), jwtSecret, 60 * 60 * 24 * 30);
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
    return reply.code(200).send({ token, user: toAuthUserProjection(user) });
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
      // PHASE 11 — /reset-password is a nav path (query-carried token, not a
      // resource id), composed via the canonical internalNavPath + the ONE
      // absolute-internal-URL builder (same pattern as
      // email-verification.service.ts's buildVerifyUrl).
      const resetUrl = absoluteInternalUrl(
        webBase,
        internalNavPath(`/reset-password?token=${encodeURIComponent(result.rawToken)}`),
      );

      try {
        const emailService = getEmailService();
        await emailService.sendPasswordResetEmail(body.email, resetUrl);
      } catch {
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
    } catch {
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

  // EV4 — email verification: consume the link, auto-sign-in.
  // Business logic lives in email-verification.service.ts.
  app.post("/v1/auth/email/verify", async (req, reply) => {
    const rl = await enforceRateLimit({
      key: `auth:email-verify:ip:${readClientIp(req)}`,
      max: AUTH_EMAIL_VERIFY_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
    });
    if (!rl.allowed) {
      return replyRateLimited(reply, rl.resetAtMs);
    }

    const parsed = z.object({ token: z.string().min(1).max(256) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Missing or malformed verification token.",
          timestamp: new Date().toISOString(),
        },
      });
    }

    const result = await confirmVerificationToken(parsed.data.token);
    if (!result.ok) {
      auditAuthEvent(req, {
        userId: null,
        action: "auth.email_verification_confirm",
        outcome: "failure",
        severity: "info",
        metadata: { reason: result.reason },
      });
      return reply.code(400).send({
        error: {
          code: "INVALID_OR_EXPIRED",
          message: "Verification link is invalid or has expired.",
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Re-fetch the canonical row (the consume helper returns a
    // narrow projection); JWT payload + session inventory need it.
    const fullUser = await prisma.user.findUnique({ where: { id: result.user.id } });
    if (!fullUser) {
      return reply.code(500).send({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Verification succeeded but the account could not be loaded.",
          timestamp: new Date().toISOString(),
        },
      });
    }

    // §10.2 correction — email-verification proves EMAIL POSSESSION, not a
    // password credential for this session; classify MAGIC_LINK (fails closed
    // for SSO-required Organizations; independently-allowed Personal use
    // unchanged).
    const token = signJwt(jwtPayloadFromUser(fullUser, "MAGIC_LINK"), jwtSecret, 60 * 60 * 24 * 30);
    await recordSessionFromSignedToken(req, fullUser, token);
    maybeSetWebCookie(req, reply, token);

    auditAuthEvent(req, {
      userId: fullUser.id,
      action: "auth.email_verification_confirm",
      outcome: "success",
      resourceId: fullUser.id,
      metadata: { provider: fullUser.provider, email: fullUser.email },
    });

    return reply.code(200).send({ token, user: toAuthUserProjection(fullUser) });
  });

  // EV4 — email verification: resend the link. Always returns 200
  // `{ ok: true }` so the surface cannot be used for enumeration.
  app.post("/v1/auth/email/resend-verification", async (req, reply) => {
    const rl = await enforceRateLimit({
      key: `auth:email-resend:ip:${readClientIp(req)}`,
      max: AUTH_EMAIL_RESEND_RATE_LIMIT_PER_IP_PER_MIN,
      windowSec: AUTH_RATE_LIMIT_WINDOW_SEC,
    });
    if (!rl.allowed) {
      return replyRateLimited(reply, rl.resetAtMs);
    }

    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(200).send({ ok: true });
    }

    const spec = await processResendVerification(parsed.data.email);
    auditAuthEvent(req, {
      userId: spec.userId,
      action: "auth.email_verification_resend",
      outcome: spec.outcome,
      severity: spec.severity,
      metadata: {
        email: parsed.data.email,
        ...(spec.reason ? { reason: spec.reason } : {}),
        ...(spec.error ? { error: spec.error } : {}),
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
    const cookiePending =
      (req.cookies as { proovra_mfa_pending?: string } | undefined)
        ?.proovra_mfa_pending ?? null;
    const rawBody =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const candidateBody = {
      mfaPendingToken:
        typeof rawBody.mfaPendingToken === "string"
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
      pendingPayload = verifyMfaPendingTokenSignature(
        body.mfaPendingToken,
        jwtSecret,
      );
    } catch (err) {
      clearMfaPendingCookie(req, reply);
      const reason =
        err instanceof Error ? err.message : "pending_token_invalid";
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
    const challengeJti =
      typeof pendingPayload.sid === "string" ? pendingPayload.sid : null;
    if (!challengeJti) {
      // Should never happen — signMfaPendingToken always sets sid.
      clearMfaPendingCookie(req, reply);
      return reply.code(401).send({ message: "mfa_pending_invalid" });
    }
    if (await loginMfaIsRateLimited(userId)) {
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
    let verifyMethod: "totp" | "recovery_code" = "totp";
    if (body.code) {
      verifyMethod = "totp";
      const r = await verifyActiveTotp({
        userId,
        code: body.code,
      });
      verifyOk = r.ok;
    } else if (body.recoveryCode) {
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
      const msg =
        consume.reason === "expired"
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
    const token = signJwt(
      {
        // §10.3 correction — MFA AUGMENTS the primary method (here PASSWORD —
        // the MFA gate is reached only from email/password login), it does not
        // replace it. Preserve PASSWORD provenance + record mfaAt.
        ...jwtPayloadFromUser(
          {
            id: user.id,
            provider: user.provider,
            email: user.email,
            platformRole: user.platformRole,
          },
          "PASSWORD",
        ),
        mfaAt: Math.floor(Date.now() / 1000),
      },
      jwtSecret,
      60 * 60 * 24 * 30,
    );

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
    // Session-inventory parity (2026-07-16). This is the completion path
    // for EVERY MFA-enrolled login (any provider): the primary-credential
    // handlers return early at their MFA gate, so this handler is where
    // the real session is issued. It previously set the cookie without
    // writing an AuthenticatedSession row, leaving MFA users with an
    // empty session list. Same canonical helper as every other path.
    await recordSessionFromSignedToken(req, user, token);
    clearMfaPendingCookie(req, reply);
    maybeSetWebCookie(req, reply, token);
    return reply.code(200).send({ token, user: toAuthUserProjection(user) });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    let userId: string | null = null;

    try {
      const authHeader = req.headers.authorization ?? "";
      const bearer = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";

      if (bearer) {
        const payload = verifyJwt(bearer, jwtSecret);
        userId = payload.sub;
      }
    } catch {
      // noop
    }

    if (req.headers["x-web-client"] === "1") {
      const host = req.headers.host ?? "";
      const origin = req.headers.origin ?? "";
      const isProductionDomain =
        host.includes("proovra.com") || origin.includes("proovra.com");

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

  app.get("/v1/auth/me", { preHandler: requireAuth }, async (req: FastifyRequest) => {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) return { user: null };

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
        ...(user.platformRole === "admin" ? { role: "admin" as const } : {}),
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
  app.get("/v1/auth/session-light", async (req) => {
    try {
      const authHeader = req.headers.authorization ?? "";
      const bearer = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
      const cookieToken =
        (req.cookies as { proovra_session?: string } | undefined)
          ?.proovra_session ?? null;
      const token = bearer || cookieToken;
      if (!token) return { authenticated: false };

      const payload = verifyJwt(token, jwtSecret);
      // Pending MFA tokens are NOT a session — they only authorize
      // the verify-mfa endpoint.
      if (payload.mfa === "pending") return { authenticated: false };

      // Confirm the session is not on the revocation deny list.
      // We don't fail open on a registry read error — the boolean
      // collapses to false.
      const sid = typeof payload.sid === "string" ? payload.sid : null;
      const iat = typeof payload.iat === "number" ? payload.iat : null;
      try {
        const { isSessionRevoked, hashSessionId } = await import(
          "../services/identity-security/session-revocation.service.js"
        );
        const revoked = await isSessionRevoked({
          userId: payload.sub,
          sessionIdHash: sid ? hashSessionId(sid) : null,
          iat,
        });
        if (revoked) return { authenticated: false };
      } catch {
        return { authenticated: false };
      }
      return { authenticated: true };
    } catch {
      // Invalid signature, expired token, malformed payload —
      // collapse to false. NEVER expose the specific reason.
      return { authenticated: false };
    }
  });
}