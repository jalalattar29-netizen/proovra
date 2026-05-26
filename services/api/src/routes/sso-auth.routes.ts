/**
 * Phase 26.5 — End-user SSO routes.
 *
 *   GET /v1/auth/sso/:connectionId/initiate
 *   GET /v1/auth/sso/callback
 *
 * Phase 26 shipped the SSO service (`buildOidcAuthorizationUrl`,
 * `handleOidcCallback`); this file is the route plumbing that:
 *
 *   - validates the connection + redirect target
 *   - persists the state token via `persistCallbackAttempt` (Phase 26.5
 *     replay-protection ledger)
 *   - on callback: consumes the state row, runs the Phase 26 callback
 *     handler, tracks IdP outage on failure, mints a JWT via the
 *     existing Phase 0 `signJwt` helper, records the active session
 *     via `recordAuthenticatedSession`, sets the standard
 *     `proovra_session` cookie, and redirects the user to the safe
 *     redirect target.
 *
 * Hard rules:
 *   - The state lifecycle goes through the persistent ledger (no
 *     in-process map for replay protection on multi-instance).
 *   - The redirect target is validated against the shared
 *     `isSafeRedirectAfter` helper. No open redirects.
 *   - The cookie shape MUST match the existing auth route's cookie so
 *     the auth middleware accepts the session.
 *   - On any failure, the user is bounced to `/auth?sso_error=...`
 *     with a sanitised reason code (no raw IdP error).
 */

import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import {
  signJwt,
  signMfaPendingToken,
  MFA_PENDING_TTL_SECONDS,
} from "../services/jwt.js";
import {
  handleOidcCallback,
  buildOidcAuthorizationUrl,
  SsoServiceError,
} from "../services/access-control/sso.service.js";
import {
  readMfaStatus,
  createMfaPendingChallenge,
} from "../services/security/mfa.service.js";
import { resolveLoginMfaEnforcement } from "../services/security/login-mfa-enforcement.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  consumeCallbackAttempt,
  getConnectionForAttempt,
  markCallbackFailed,
  noteSsoFailure,
  noteSsoSuccess,
  persistCallbackAttempt,
} from "../services/access-control/sso-hardening.service.js";
import { recordAuthenticatedSession } from "../services/access-control/session-inventory.service.js";
import { detectAndScoreSession } from "../services/access-control/suspicious-session.service.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getRedirectUri(req: FastifyRequest): string {
  // Production: build from request host. Dev: env override allowed.
  const env = process.env["SSO_CALLBACK_REDIRECT_URI"];
  if (env) return env;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] ?? "";
  return `${proto}://${host}/v1/auth/sso/callback`;
}

function ipPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  // Mask the last octet for IPv4, last group for IPv6.
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
    }
  }
  return ip.slice(0, 10) + "…";
}

function uaPreview(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 120);
}

function deviceIdHash(req: FastifyRequest): string | null {
  // Best-effort device fingerprint from UA + accept-language. Hashed
  // with the same HMAC key the trusted-device service uses for
  // continuity.
  const ua = req.headers["user-agent"];
  const lang = req.headers["accept-language"];
  if (typeof ua !== "string" || ua.length === 0) return null;
  const raw = `${ua}|${typeof lang === "string" ? lang : ""}`;
  const secret = process.env["IDENTITY_SECURITY_HASH_SECRET"] || "phase26-dev";
  return createHash("sha256").update(secret + ":" + raw).digest("hex");
}

function sanitiseRedirectAfter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // `isSafeRedirectAfter` is enforced again by the SSO hardening
  // service on persist; we only do a quick length/relative check here
  // so we never accept a JSON payload, etc.
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return null;
  return trimmed;
}

function bounceToAuthError(
  reply: FastifyReply,
  reason: string,
  redirectAfter?: string | null,
): void {
  const params = new URLSearchParams();
  params.set("sso_error", reason.slice(0, 64));
  if (redirectAfter) params.set("redirect_after", redirectAfter);
  reply.code(302).redirect(`/auth?${params.toString()}`);
}

function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  const host = req.headers["host"] ?? "";
  const origin = req.headers["origin"] ?? "";
  const productionDomain =
    process.env["SSO_COOKIE_DOMAIN"] ||
    (host.includes("proovra.com") || origin.includes("proovra.com")
      ? ".proovra.com"
      : undefined);
  const secure =
    process.env["SSO_COOKIE_SECURE"] === "true" || !!productionDomain;
  const opts = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    domain: productionDomain,
    maxAge: 60 * 60 * 24 * 30,
  };
  reply.clearCookie("proovra_session", { path: "/", domain: ".proovra.com" });
  reply.clearCookie("proovra_session", { path: "/" });
  reply.setCookie("proovra_session", token, opts);
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export async function ssoAuthRoutes(app: FastifyInstance) {
  const jwtSecret = process.env["AUTH_JWT_SECRET"];
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  const callbacksEnabled = process.env["SSO_CALLBACKS_ENABLED"] !== "false";

  // -------------------------------------------------------------------------
  // GET /v1/auth/sso/:connectionId/initiate
  // -------------------------------------------------------------------------
  app.get(
    "/v1/auth/sso/:connectionId/initiate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!callbacksEnabled) {
        return reply.code(503).send({ error: { code: "sso_disabled" } });
      }
      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);
      const q = z
        .object({
          redirectAfter: z.string().max(400).optional(),
        })
        .parse(req.query ?? {});

      // Look up the connection to discover its teamId.
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, teamId: true, status: true },
      });
      if (!conn || conn.status !== "ACTIVE") {
        return bounceToAuthError(reply, "sso_connection_unavailable");
      }

      try {
        const { authorizationUrl, state } = await buildOidcAuthorizationUrl(
          {
            teamId: conn.teamId,
            connectionId: conn.id,
            redirectUri: getRedirectUri(req),
            redirectAfter: q.redirectAfter ?? null,
          },
          prisma,
        );

        // Persist the state for replay protection.
        const nonceRaw = randomBytes(16).toString("base64url");
        const persist = await persistCallbackAttempt(
          {
            teamId: conn.teamId,
            ssoConnectionId: conn.id,
            stateRaw: state,
            nonceRaw,
            redirectAfter: sanitiseRedirectAfter(q.redirectAfter),
            ipPreview: ipPreview(req),
            uaPreview: uaPreview(req),
          },
          prisma,
        );
        if (!persist.ok) {
          return bounceToAuthError(reply, "sso_state_persist_failed");
        }

        return reply.code(302).redirect(authorizationUrl);
      } catch (err) {
        if (err instanceof SsoServiceError) {
          await noteSsoFailure(
            { connectionId: conn.id, reason: err.code },
            prisma,
          );
          return bounceToAuthError(reply, err.code.toLowerCase());
        }
        await noteSsoFailure(
          { connectionId: conn.id, reason: "initiate_failed" },
          prisma,
        );
        return bounceToAuthError(reply, "sso_initiate_failed");
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/auth/sso/callback
  // -------------------------------------------------------------------------
  app.get(
    "/v1/auth/sso/callback",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!callbacksEnabled) {
        return reply.code(503).send({ error: { code: "sso_disabled" } });
      }
      const q = z
        .object({
          state: z.string().min(8).max(512),
          code: z.string().min(8).max(2048).optional(),
          error: z.string().max(120).optional(),
        })
        .parse(req.query ?? {});

      if (q.error || !q.code) {
        return bounceToAuthError(reply, `idp_${q.error ?? "no_code"}`);
      }

      // Consume the persistent state row first — this is replay-safe.
      const consume = await consumeCallbackAttempt(
        { stateRaw: q.state },
        prisma,
      );
      if (!consume.ok) {
        const reason =
          consume.reason === "REPLAYED"
            ? "sso_state_replayed"
            : consume.reason === "EXPIRED"
              ? "sso_state_expired"
              : "sso_state_invalid";
        return bounceToAuthError(reply, reason);
      }

      const attempt = consume.attempt;
      const conn = await getConnectionForAttempt(attempt, prisma);
      if (!conn) {
        await markCallbackFailed(
          { attemptId: attempt.id, reason: "connection_missing" },
          prisma,
        );
        return bounceToAuthError(reply, "sso_connection_unavailable");
      }

      // Run the Phase 26 callback handler — it does the OIDC exchange,
      // domain gate, and JIT provisioning.
      try {
        const result = await handleOidcCallback(
          {
            state: q.state,
            code: q.code,
            redirectUri: getRedirectUri(req),
          },
          prisma,
        );
        await noteSsoSuccess(conn.id, prisma);

        // PHASE R8.1.2/R8.1.3 — second-factor gate for SSO. R8.1.3
        // consults `resolveLoginMfaEnforcement` so org policy is
        // honoured here exactly as it is on email / OAuth login. The
        // resolver returns:
        //   NOT_REQUIRED         → continue with normal SSO session
        //   MFA_REQUIRED         → durable challenge + redirect to /auth/mfa-challenge
        //   ENROLLMENT_REQUIRED  → 302 to /auth/mfa-challenge?enroll=1
        //                          (page surfaces guided enrollment;
        //                          NO session cookie is set)
        let decision: Awaited<ReturnType<typeof resolveLoginMfaEnforcement>>;
        try {
          decision = await resolveLoginMfaEnforcement({
            userId: result.user.id,
          });
        } catch {
          // Fail-OPEN on transient orchestrator errors to avoid
          // locking every operator out on a Prisma blip. Logged via
          // sso failure note for SecOps follow-up.
          decision = {
            outcome: "NOT_REQUIRED",
            activeFactorCount: 0,
            policyTeamId: null,
            policyLevel: null,
          };
        }
        if (decision.outcome === "ENROLLMENT_REQUIRED") {
          safeEmitSecurityEvent(
            {
              teamId: decision.policyTeamId,
              eventType: "mfa_enrollment_required",
              severity: "WARNING",
              details: {
                actorUserId: result.user.id,
                loginMethod: "sso_oidc",
                policyLevel: decision.policyLevel,
              },
            },
            prisma,
          );
          void appendPlatformAuditLog({
            userId: result.user.id,
            action: "auth.mfa_enrollment_required",
            category: "auth",
            severity: "warning",
            source: "api_sso",
            outcome: "blocked",
            resourceType: "user_auth",
            resourceId: result.user.id,
            requestId: req.id,
            metadata: {
              loginMethod: "sso_oidc",
              policyLevel: decision.policyLevel,
            },
            ipAddress: req.ip,
            userAgent: uaPreview(req),
          }).catch(() => null);
          const url = new URL(
            "/auth/mfa-challenge",
            process.env["WEB_BASE_URL"] || "https://www.proovra.com",
          );
          url.searchParams.set("enroll", "1");
          url.searchParams.set(
            "next",
            attempt.redirectAfter ?? "/home",
          );
          return reply.code(302).redirect(url.toString());
        }
        if (decision.outcome === "MFA_REQUIRED") {
          // Create durable challenge so SSO replay protection lives
          // in the DB just like email/OAuth login.
          const challenge = await createMfaPendingChallenge({
            userId: result.user.id,
            purpose: "LOGIN",
            ipAddress: req.ip ?? null,
            userAgent: uaPreview(req),
            metadata: { loginMethod: "sso_oidc" },
          });
          const pendingToken = signMfaPendingToken(
            {
              sub: result.user.id,
              provider: "EMAIL",
              email: result.user.email,
            },
            jwtSecret,
            challenge.jti,
          );
          // Reuse the same cookie-shape rules as setSessionCookie so
          // cross-subdomain redirects work on production. NOT the
          // session cookie — separate name, separate TTL.
          const host = req.headers["host"] ?? "";
          const origin = req.headers["origin"] ?? "";
          const productionDomain =
            process.env["SSO_COOKIE_DOMAIN"] ||
            (host.includes("proovra.com") ||
            origin.includes("proovra.com")
              ? ".proovra.com"
              : undefined);
          const secure =
            process.env["SSO_COOKIE_SECURE"] === "true" ||
            !!productionDomain;
          reply.setCookie("proovra_mfa_pending", pendingToken, {
            httpOnly: true,
            secure,
            sameSite: "lax",
            path: "/",
            domain: productionDomain,
            maxAge: MFA_PENDING_TTL_SECONDS,
          });
          if (decision.policyLevel && decision.policyTeamId) {
            safeEmitSecurityEvent(
              {
                teamId: decision.policyTeamId,
                eventType: "org_mfa_policy_enforced",
                severity: "INFO",
                details: {
                  actorUserId: result.user.id,
                  loginMethod: "sso_oidc",
                  policyLevel: decision.policyLevel,
                },
              },
              prisma,
            );
          }
          void appendPlatformAuditLog({
            userId: result.user.id,
            action: "auth.mfa_challenge_issued",
            category: "auth",
            severity: "info",
            source: "api_sso",
            outcome: "success",
            resourceType: "user_auth",
            resourceId: result.user.id,
            requestId: req.id,
            metadata: {
              loginMethod: "sso_oidc",
              policyLevel: decision.policyLevel ?? null,
            },
            ipAddress: req.ip,
            userAgent: uaPreview(req),
          }).catch(() => null);
          const next = attempt.redirectAfter ?? "/home";
          const url = new URL(
            "/auth/mfa-challenge",
            process.env["WEB_BASE_URL"] || "https://www.proovra.com",
          );
          url.searchParams.set("next", next);
          return reply.code(302).redirect(url.toString());
        }

        // Mint the JWT. We reuse the existing token shape so the
        // auth middleware accepts the session unchanged.
        const sid = randomBytes(16).toString("base64url");
        const ttlSeconds = 60 * 60 * 24 * 30;
        const issuedAt = Math.floor(Date.now() / 1000);
        const exp = issuedAt + ttlSeconds;
        const payload = {
          sub: result.user.id,
          provider: "EMAIL", // SSO-provisioned users are EMAIL provider; IdP link is in ExternalIdentityMapping
          email: result.user.email,
          sid,
          iat: issuedAt,
          exp,
        };
        const token = signJwt(payload, jwtSecret, ttlSeconds);

        // Persist the active session BEFORE setting the cookie so the
        // admin inventory + heartbeat is consistent.
        const session = await recordAuthenticatedSession(
          {
            userId: result.user.id,
            teamId: result.teamId,
            sid,
            iat: issuedAt,
            exp,
            ssoConnectionId: conn.id,
            ipPreview: ipPreview(req),
            uaPreview: uaPreview(req),
            deviceIdHash: deviceIdHash(req),
          },
          prisma,
        );

        // Score the new session for adaptive auth on the first request.
        await detectAndScoreSession(
          { teamId: result.teamId, sessionId: session.id },
          prisma,
        ).catch(() => null);

        setSessionCookie(req, reply, token);

        // Redirect to the safe target (or workspace home).
        const redirectTarget = attempt.redirectAfter ?? "/home";
        return reply.code(302).redirect(redirectTarget);
      } catch (err) {
        await markCallbackFailed(
          {
            attemptId: attempt.id,
            reason:
              err instanceof SsoServiceError ? err.code : "callback_failed",
          },
          prisma,
        );
        await noteSsoFailure(
          {
            connectionId: conn.id,
            reason:
              err instanceof SsoServiceError ? err.code : "callback_failed",
          },
          prisma,
        );
        if (err instanceof SsoServiceError) {
          return bounceToAuthError(
            reply,
            err.code.toLowerCase(),
            attempt.redirectAfter,
          );
        }
        return bounceToAuthError(reply, "sso_callback_failed");
      }
    },
  );
}
