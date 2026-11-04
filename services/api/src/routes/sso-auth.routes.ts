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
 *   - On any failure, the user is bounced to the web `/login?sso_error=...`
 *     with a sanitised reason code (no raw IdP error).
 */

import {
  MFA_ENROLLMENT_TTL_SECONDS,
  setMfaEnrollmentCookie,
  signMfaEnrollmentToken,
} from "../services/auth/mfa-enrollment-session.js";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isProovraProductionRequest } from "../http/cors-origin-policy.js";
import { getSecret } from "../config/runtime-secrets.js";
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
  oidcClientSecretAvailable,
  SsoServiceError,
} from "../services/access-control/sso.service.js";
import {
  createMfaPendingChallenge,
} from "../services/security/mfa.service.js";
import { resolveLoginMfaEnforcement } from "../services/security/login-mfa-enforcement.service.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import {
  consumeCallbackAttempt,
  getConnectionForAttempt,
  markCallbackFailed,
  noteSsoFailure,
  noteSsoSuccess,
  persistCallbackAttempt,
} from "../services/access-control/sso-hardening.service.js";
import {
  recordAuthenticatedSession,
  requestDeviceIdHash,
} from "../services/access-control/session-inventory.service.js";
import { organizationIdForPolicy } from "../services/identity/org-security-policy.service.js";
import { completeSsoSession } from "../services/identity/sso-session-completion.service.js";
import { resolveOrganizationPolicy } from "../services/identity/org-security-policy.service.js";
// PHASE 11 — canonical safe-destination helper + internal URL builder.
// Used ONLY to validate/compose the post-login destination string; the
// state/nonce/replay-protection logic above is untouched.
import {
  safeIntendedDestination,
  absoluteInternalUrl,
  internalNavPath,
  ssoProviderProtocol,
  type SsoProvider,
} from "@proovra/shared";
import { domainFromEmail } from "../services/organization/organization-domain.service.js";
// PHASE 12B — the federation READINESS projection (operator session, not the
// IdP) composes the canonical authorization primitive.
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
// 2026-10-28 — the redirect URI shared with the IDP_REAUTH step-up round trip
// (the IdP compares it byte for byte at the code exchange).
import {
  oidcRedirectUri as getRedirectUri,
  signInErrorUrl,
  webPageUrl,
} from "../services/access-control/sso-endpoints.js";
import {
  clearSsoBrowserBinding,
  setSsoBrowserBinding,
  ssoBrowserBindingMatches,
} from "../services/access-control/sso-browser-binding.js";
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { mintedSessionClaims } from "../services/jwt.js";
import {
  completeOidcIdpStepUp,
  isStepUpIdpState,
} from "../services/identity-security/step-up-idp-flow.js";
import {
  isNativeCodeChallenge,
  isNativeCodeVerifier,
  isNativeSsoState,
  issueNativeSsoCode,
  nativeSsoErrorUrl,
  recordNativeSsoChallenge,
  redeemNativeSsoCode,
} from "../services/access-control/sso-native-handoff.service.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SSO_LOGIN_RATE_LIMIT_PER_MIN = 30;

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
  return requestDeviceIdHash(req.headers);
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

/**
 * PHASE 11 — `redirectAfter` (sourced from the persisted SsoCallbackAttempt
 * row) is re-validated through the canonical `safeIntendedDestination`
 * helper before it is ever written into the bounce URL's query string, so a
 * tampered/replayed value can never carry an open-redirect target. This is
 * defense-in-depth: the hardening service already validates on persist.
 */
function bounceToAuthError(
  reply: FastifyReply,
  reason: string,
  redirectAfter?: string | null,
): void {
  const destination = redirectAfter ? safeIntendedDestination(redirectAfter) : "/";
  reply.code(302).redirect(signInErrorUrl("sso_error", reason, destination));
}

/**
 * PHASE 11 — resolve the post-login destination for a successful OIDC
 * session. An explicit `redirectAfter` is validated through the canonical
 * `safeIntendedDestination` helper (never an open redirect); absent a
 * destination we default to the workspace home, unchanged from prior
 * behaviour.
 */
function resolvePostLoginDestination(
  redirectAfter: string | null | undefined,
): string {
  return redirectAfter ? safeIntendedDestination(redirectAfter) : "/home";
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
    (isProovraProductionRequest(host, origin)
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
  // The canonical accessor (secrets cache, then env) — the same key
  // requireAuth verifies with; a direct env read could diverge from it.
  const jwtSecret = getSecret("AUTH_JWT_SECRET");
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  const callbacksEnabled = process.env["SSO_CALLBACKS_ENABLED"] !== "false";

  // -------------------------------------------------------------------------
  // PHASE 12B — GET /v1/auth/sso/readiness
  //
  // The federation READINESS projection the provider console needs and could
  // not previously obtain: is this workspace's Organization enforcing managed
  // identity, which domains are actually DNS-verified (domain binding), and is
  // each connection genuinely live or only half-configured.
  //
  // Every decision is computed SERVER-side from the canonical authorities; the
  // browser renders booleans it is handed. The workspace scope is a CANDIDATE
  // only — `authorizeOrFail` binds the actor's ACTIVE membership and the
  // Organization lifecycle to it, so a supplied id can only cause a denial.
  //
  // SECRET DISCIPLINE: this projection carries NO client secret, NO signing
  // key, NO certificate private material — only configured/not-configured
  // status and a truncated public fingerprint.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/auth/sso/readiness",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .safeParse(req.query ?? {});
      if (!q.success) {
        return reply
          .code(400)
          .send({ error: { code: "validation_error", detail: q.error.flatten() } });
      }
      const actor = await authorizeOrFail(req, reply, {
        teamId: q.data.teamId,
        permission: "identity.external_mapping.read",
        resourceKind: "sso_connection",
        antiEnumeration: true,
      });
      if (!actor) return;

      const organizationId = await organizationIdForPolicy(actor.teamId, prisma);
      let managedIdentityRequired: boolean | null = null;
      let policyProvisioned = false;
      if (organizationId) {
        try {
          const policy = await resolveOrganizationPolicy(actor.teamId, prisma);
          policyProvisioned = policy.applicability === "ORGANIZATION";
          managedIdentityRequired =
            policy.applicability === "ORGANIZATION"
              ? policy.policy.managedIdentityRequired
              : null;
        } catch {
          // Fail closed: an unresolvable policy is NEVER reported as "not
          // enforcing". The console renders an explicit unknown state.
          managedIdentityRequired = null;
          policyProvisioned = false;
        }
      }

      const domains = organizationId
        ? await prisma.organizationDomain.findMany({
            where: { organizationId },
            orderBy: [{ domain: "asc" }],
            take: 100,
            select: { id: true, domain: true, verifiedAt: true },
          })
        : [];

      // DOM-13 — the Organization's connections, from any of its workspaces.
      const connections = await prisma.ssoConnection.findMany({
        where: { organization: { workspaces: { some: { id: actor.teamId } } } },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: 100,
        select: {
          id: true,
          provider: true,
          displayName: true,
          status: true,
          issuerUrl: true,
          clientId: true,
          allowedEmailDomains: true,
          restrictToVerifiedDomains: true,
          samlSignRequests: true,
          // Read only to answer "can the code exchange run". Never projected.
          clientSecretSealed: true,
          // Status-only reads. `samlSpCertificate` / `samlCertificate` hold
          // PUBLIC certificate material; the SP PRIVATE key
          // (`samlSpPrivateKey`) is deliberately NOT selected, and neither is
          // `clientSecret` — nothing secret can reach this projection.
          samlSpCertificate: true,
          samlCertificate: true,
          samlSsoUrl: true,
          samlEntityId: true,
          consecutiveFailureCount: true,
          outageDetectedAtUtc: true,
          lastUsedAtUtc: true,
        },
      });

      const verifiedDomains = domains
        .filter((d) => d.verifiedAt !== null)
        .map((d) => d.domain);

      return reply.code(200).send({
        readiness: {
          teamId: actor.teamId,
          organizationId,
          policyProvisioned,
          managedIdentityRequired,
          domains: domains.map((d) => ({
            id: d.id,
            domain: d.domain,
            verified: d.verifiedAt !== null,
            verifiedAtUtc: d.verifiedAt?.toISOString() ?? null,
          })),
          verifiedDomainCount: verifiedDomains.length,
          connections: connections.map((c) => {
            const isSaml = c.provider === "GENERIC_SAML";
            const blockers: string[] = [];
            if (isSaml) {
              if (!c.samlSsoUrl) blockers.push("IDP_SSO_URL_MISSING");
              if (!c.samlEntityId) blockers.push("SP_ENTITY_ID_MISSING");
              if (!c.samlCertificate) blockers.push("IDP_CERTIFICATE_MISSING");
              if (c.samlSignRequests && !c.samlSpCertificate) {
                blockers.push("SP_CERTIFICATE_MISSING");
              }
            } else {
              if (!c.issuerUrl) blockers.push("ISSUER_URL_MISSING");
              if (!c.clientId) blockers.push("CLIENT_ID_MISSING");
              // IDENT-002 — a stored hash cannot sign in to an IdP.
              if (!oidcClientSecretAvailable(c)) blockers.push("CLIENT_SECRET_UNAVAILABLE");
            }
            if (
              c.restrictToVerifiedDomains &&
              verifiedDomains.length === 0
            ) {
              blockers.push("NO_VERIFIED_DOMAIN");
            }
            if (c.status !== "ACTIVE") blockers.push("NOT_ACTIVE");
            return {
              id: c.id,
              provider: c.provider,
              displayName: c.displayName,
              status: c.status,
              // Server-computed. The client never derives readiness itself.
              ready: blockers.length === 0,
              blockers,
              restrictToVerifiedDomains: c.restrictToVerifiedDomains,
              boundDomains: c.allowedEmailDomains,
              unverifiedBoundDomains: c.allowedEmailDomains.filter(
                (d) => !verifiedDomains.includes(d.toLowerCase()),
              ),
              consecutiveFailureCount: c.consecutiveFailureCount,
              inOutage: c.outageDetectedAtUtc !== null,
              lastUsedAtUtc: c.lastUsedAtUtc?.toISOString() ?? null,
            };
          }),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/sso/discover (IDENT-020)
  //
  // How a person reaches their organization's sign-in from the sign-in page: a
  // connection id is not something they know. Only a DNS-verified domain claimed
  // by exactly one Organization answers, so a typed address cannot steer anyone
  // to another tenant's IdP, and every other address gets the same "no".
  // -------------------------------------------------------------------------
  app.post("/v1/auth/sso/discover", async (req: FastifyRequest, reply: FastifyReply) => {
    const rl = await enforceRateLimit({
      key: `sso:discover:ip:${trustedClientIpKey(req).slice(0, 200)}`,
      max: SSO_LOGIN_RATE_LIMIT_PER_MIN,
      windowSec: 60,
    });
    if (!rl.allowed) return reply.code(429).send({ error: { code: "RATE_LIMITED" } });
    const body = z.object({ email: z.string().max(320) }).safeParse(req.body ?? {});
    const domain = body.success ? domainFromEmail(body.data.email) : null;
    const none = { sso: false as const };
    if (!domain) return reply.code(200).send(none);
    const claims = await prisma.organizationDomain.findMany({
      where: { domain, verifiedAt: { not: null } },
      select: { organizationId: true },
      take: 2,
    });
    if (claims.length !== 1) return reply.code(200).send(none);
    const conn = await prisma.ssoConnection.findFirst({
      where: { organizationId: claims[0]!.organizationId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true, provider: true },
    });
    if (!conn) return reply.code(200).send(none);
    const id = encodeURIComponent(conn.id);
    return reply.code(200).send({
      sso: true as const,
      loginPath:
        ssoProviderProtocol(conn.provider as SsoProvider) === "SAML"
          ? `/v1/auth/saml/${id}/login`
          : `/v1/auth/sso/${id}/initiate`,
    });
  });

  // -------------------------------------------------------------------------
  // MOBILE-002 — POST /v1/auth/sso/native/exchange { code, codeVerifier }
  //
  // The native app's last leg of an SSO sign-in (OIDC or SAML). The code is
  // spent once and only with the verifier whose challenge was recorded before
  // the IdP leg; then the SAME post-IdP steps as the browser callback run — the
  // MFA gate, the session record and completeSsoSession — and the answer has
  // the shape every other sign-in answers with.
  // -------------------------------------------------------------------------
  app.post("/v1/auth/sso/native/exchange", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!callbacksEnabled) {
      return reply.code(503).send({ error: { code: "sso_disabled" } });
    }
    const rl = await enforceRateLimit({
      key: `sso:native-exchange:ip:${trustedClientIpKey(req).slice(0, 200)}`,
      max: SSO_LOGIN_RATE_LIMIT_PER_MIN,
      windowSec: 60,
    });
    if (!rl.allowed) return reply.code(429).send({ error: { code: "RATE_LIMITED" } });

    const body = z
      .object({ code: z.string().min(16).max(128), codeVerifier: z.string().min(43).max(128) })
      .safeParse(req.body ?? {});
    if (!body.success || !isNativeCodeVerifier(body.data.codeVerifier)) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "code and codeVerifier are required." } });
    }
    const redeemed = await redeemNativeSsoCode(prisma, body.data);
    if (!redeemed.ok) {
      req.log.warn({ reason: redeemed.reason }, "sso.native_exchange_refused");
      // One answer for every refusal: a probe learns nothing about the code.
      return reply.code(400).send({ error: { code: "SSO_NATIVE_CODE_INVALID", message: "This sign-in has expired. Start again." } });
    }
    const id = redeemed.identity;
    const loginMethod = id.authMethod === "SAML" ? "sso_saml" : "sso_oidc";

    let decision: Awaited<ReturnType<typeof resolveLoginMfaEnforcement>>;
    try {
      decision = await resolveLoginMfaEnforcement({ userId: id.userId });
    } catch {
      // The browser callback fails open on a transient orchestrator error; so does this.
      decision = { outcome: "NOT_REQUIRED", activeFactorCount: 0, policyTeamId: null, policyLevel: null };
    }
    const provenance = {
      sub: id.userId,
      provider: "EMAIL",
      email: id.email,
      authMethod: id.authMethod,
      authAt: Math.floor(Date.now() / 1000),
      ssoConnId: id.ssoConnectionId,
    } as const;
    const user = { id: id.userId, email: id.email, provider: "EMAIL" };

    if (decision.outcome === "ENROLLMENT_REQUIRED") {
      safeEmitSecurityEvent(
        {
          teamId: decision.policyTeamId,
          eventType: "mfa_enrollment_required",
          severity: "WARNING",
          details: { actorUserId: id.userId, loginMethod, policyLevel: decision.policyLevel },
        },
        prisma,
      );
      // The enrolment refusal every native sign-in already understands (auth.routes.ts gateLoginWithMfa).
      return reply.code(403).send({
        mfaRequired: true,
        mfaEnrollmentRequired: true,
        code: "MFA_ENROLLMENT_REQUIRED",
        mfaEnrollmentToken: signMfaEnrollmentToken(provenance, jwtSecret),
        mfaEnrollmentExpiresInSeconds: MFA_ENROLLMENT_TTL_SECONDS,
        reason: "org_policy_requires_mfa",
        message: "Your organization requires multi-factor authentication. Please enroll an authenticator to continue.",
        user,
      });
    }
    if (decision.outcome === "MFA_REQUIRED") {
      const challenge = await createMfaPendingChallenge({
        userId: id.userId,
        purpose: "LOGIN",
        ipAddress: req.ip ?? null,
        userAgent: uaPreview(req),
        metadata: { loginMethod, client: "native" },
      });
      const mfaPendingToken = signMfaPendingToken(
        {
          ...provenance,
          ...(id.idpContext ? { idpCtx: id.idpContext } : {}),
          ...(id.idpAuthAt ? { idpAuthAt: Math.floor(id.idpAuthAt.getTime() / 1000) } : {}),
        },
        jwtSecret,
        challenge.jti,
      );
      return reply.code(200).send({
        mfaRequired: true,
        mfaPendingToken,
        mfaPendingExpiresInSeconds: MFA_PENDING_TTL_SECONDS,
        user,
      });
    }

    const ttlSeconds = 60 * 60 * 24 * 30;
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = signJwt({ ...provenance, authAt: issuedAt }, jwtSecret, ttlSeconds);
    const { sid, exp } = mintedSessionClaims(token);
    const session = await recordAuthenticatedSession(
      {
        userId: id.userId,
        teamId: id.teamId,
        sid,
        iat: issuedAt,
        exp,
        ssoConnectionId: id.ssoConnectionId,
        ipPreview: ipPreview(req),
        uaPreview: uaPreview(req),
        deviceIdHash: deviceIdHash(req),
        authMethod: id.authMethod,
        authnContext: id.idpContext,
        idpAuthAtUtc: id.idpAuthAt,
      },
      prisma,
    );
    // IDENT-011 — the same completion the browser callback runs; a refusal leaves no session.
    const completion = await completeSsoSession(
      {
        userId: id.userId,
        teamId: id.teamId,
        ssoConnectionId: id.ssoConnectionId,
        source: id.authMethod,
        sessionId: session.id,
        sid,
      },
      prisma,
    );
    if (!completion.allowed) {
      return reply.code(403).send({ error: { code: "SSO_SIGN_IN_REFUSED", reason: completion.reason, message: "Your organization did not allow this sign-in." } });
    }
    void emitTenantAudit({
      action: id.authMethod === "SAML" ? "auth.saml_login_succeeded" : "auth.sso_login_succeeded",
      outcome: "success",
      sourceApp: "SSO",
      actorUserId: id.userId,
      workspaceId: id.teamId,
      resourceType: "user_auth",
      resourceId: id.userId,
      correlationId: req.id,
      metadata: { loginMethod, client: "native", connectionId: id.ssoConnectionId, userAgent: uaPreview(req) },
    }).catch(() => null);
    return reply.code(200).send({ token, user });
  });

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
          // MOBILE-002 — the native app's sign-in: its PKCE challenge (S256).
          native: z.literal("1").optional(),
          codeChallenge: z.string().max(64).optional(),
        })
        .parse(req.query ?? {});
      if (q.native && !isNativeCodeChallenge(q.codeChallenge)) {
        return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "codeChallenge must be an S256 challenge." } });
      }

      // IDENT-014 — public, and each call writes a row and may reach the IdP.
      const rl = await enforceRateLimit({
        key: `sso:initiate:ip:${trustedClientIpKey(req).slice(0, 200)}`,
        max: SSO_LOGIN_RATE_LIMIT_PER_MIN,
        windowSec: 60,
      });
      if (!rl.allowed) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED" } });
      }

      // Look up the connection to discover its teamId.
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, teamId: true, status: true },
      });
      if (!conn || conn.status !== "ACTIVE") {
        return bounceToAuthError(reply, "sso_connection_unavailable");
      }

      try {
        const { authorizationUrl, state, nonce } = await buildOidcAuthorizationUrl(
          {
            teamId: conn.teamId,
            connectionId: conn.id,
            redirectUri: getRedirectUri(req),
            redirectAfter: q.redirectAfter ?? null,
          },
          prisma,
        );

        // The ledger is the only memory of this sign-in, so any instance can
        // finish it.
        const persist = await persistCallbackAttempt(
          {
            teamId: conn.teamId,
            ssoConnectionId: conn.id,
            stateRaw: state,
            nonceRaw: nonce,
            redirectAfter: sanitiseRedirectAfter(q.redirectAfter),
            ipPreview: ipPreview(req),
            uaPreview: uaPreview(req),
          },
          prisma,
        );
        if (!persist.ok) {
          return bounceToAuthError(reply, "sso_state_persist_failed");
        }
        if (q.native && q.codeChallenge) {
          await recordNativeSsoChallenge(prisma, { stateRaw: state, codeChallenge: q.codeChallenge });
        }

        setSsoBrowserBinding(req, reply, state);
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

      // 2026-10-28 — IDP_REAUTH STEP-UP BRANCH. A state minted by the step-up
      // round trip is verified with the same exchange and id_token checks as
      // a sign-in, but it can only APPROVE the one challenge it was bound to:
      // no session, no cookie, no provisioning. Checked before the sign-in
      // error bounce so a cancelled step-up lands on the step-up result page.
      if (await isStepUpIdpState(prisma, q.state)) {
        const target = await completeOidcIdpStepUp(prisma, {
          stateRaw: q.state,
          code: q.code ?? null,
          idpError: q.error ?? null,
          redirectUri: getRedirectUri(req),
        });
        return reply.code(302).redirect(target);
      }

      // MOBILE-002 — an attempt the native app started reports every outcome
      // back to the app (proovra://sso/complete), never to the web sign-in page
      // its system browser would otherwise be left on.
      const native = await isNativeSsoState(prisma, q.state);
      const fail = (reason: string, redirectAfter?: string | null) =>
        native
          ? reply.code(302).redirect(nativeSsoErrorUrl(reason))
          : bounceToAuthError(reply, reason, redirectAfter);

      if (q.error || !q.code) {
        return fail(`idp_${q.error ?? "no_code"}`);
      }

      // IDENT-014 — a callback in a browser that did not start this sign-in is
      // login CSRF. Refused before the state is spent.
      if (!ssoBrowserBindingMatches(req, q.state)) {
        return fail("sso_browser_mismatch");
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
        return fail(reason);
      }

      const attempt = consume.attempt;
      const conn = await getConnectionForAttempt(attempt, prisma);
      if (!conn) {
        await markCallbackFailed(
          { attemptId: attempt.id, reason: "connection_missing" },
          prisma,
        );
        return fail("sso_connection_unavailable");
      }

      // Run the Phase 26 callback handler — it does the OIDC exchange,
      // domain gate, and JIT provisioning.
      try {
        const result = await handleOidcCallback(
          {
            attempt,
            state: q.state,
            code: q.code,
            redirectUri: getRedirectUri(req),
          },
          prisma,
        );
        await noteSsoSuccess(conn.id, prisma);

        // MOBILE-002 — the IdP answer is verified. A native attempt hands the
        // verified identity to the app under a single-use code; the app's
        // exchange runs the MFA gate, the session record and completeSsoSession
        // below's equivalent (sso-native-exchange). No cookie is set here.
        if (native) {
          const target = await issueNativeSsoCode(prisma, {
            stateRaw: q.state,
            identity: {
              userId: result.user.id,
              email: result.user.email ?? null,
              teamId: result.teamId,
              ssoConnectionId: result.connectionId,
              authMethod: "OIDC",
              idpContext: result.idp.acr ?? null,
              idpAuthAt: result.idp.authTime ?? null,
            },
          });
          clearSsoBrowserBinding(reply);
          return reply.code(302).redirect(target ?? nativeSsoErrorUrl("sso_native_handoff_invalid"));
        }

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
          void emitTenantAudit({
            action: "auth.mfa_enrollment_required",
            outcome: "denied",
            denialReason: "mfa_enrollment_required",
            sourceApp: "SSO",
            actorUserId: result.user.id,
            workspaceId: conn.teamId,
            resourceType: "user_auth",
            resourceId: result.user.id,
            correlationId: req.id,
            metadata: {
              loginMethod: "sso_oidc",
              policyLevel: decision.policyLevel,
              ipAddress: req.ip,
              userAgent: uaPreview(req),
            },
          }).catch(() => null);
          setMfaEnrollmentCookie(
            req,
            reply,
            signMfaEnrollmentToken(
              {
                sub: result.user.id,
                provider: "EMAIL",
                email: result.user.email,
                authMethod: "OIDC",
                authAt: Math.floor(Date.now() / 1000),
                ssoConnId: conn.id,
              },
              getSecret("AUTH_JWT_SECRET") as string,
            ),
          );
          // PHASE 11 — canonical destination validation + absolute-internal-URL
          // builder (the MFA enrollment/session logic above is untouched).
          const url = new URL(
            absoluteInternalUrl(
              process.env["WEB_BASE_URL"] || "https://www.proovra.com",
              internalNavPath("/auth/mfa-challenge"),
            ),
          );
          url.searchParams.set("enroll", "1");
          url.searchParams.set(
            "next",
            resolvePostLoginDestination(attempt.redirectAfter),
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
              // 2026-10-28 — carry the VERIFIED SSO provenance through the
              // MFA step so the session minted at /v1/auth/mfa/verify keeps
              // it (it used to collapse to PASSWORD and drop the connection).
              authMethod: "OIDC" as const,
              authAt: Math.floor(Date.now() / 1000),
              ssoConnId: result.connectionId,
              ...(result.idp.acr ? { idpCtx: result.idp.acr } : {}),
              ...(result.idp.authTime
                ? { idpAuthAt: Math.floor(result.idp.authTime.getTime() / 1000) }
                : {}),
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
            (isProovraProductionRequest(host, origin)
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
          void emitTenantAudit({
            action: "auth.mfa_challenge_issued",
            outcome: "success",
            sourceApp: "SSO",
            actorUserId: result.user.id,
            workspaceId: conn.teamId,
            resourceType: "user_auth",
            resourceId: result.user.id,
            correlationId: req.id,
            metadata: {
              loginMethod: "sso_oidc",
              policyLevel: decision.policyLevel ?? null,
              ipAddress: req.ip,
              userAgent: uaPreview(req),
            },
          }).catch(() => null);
          // PHASE 11 — canonical destination validation + absolute-internal-URL
          // builder (the MFA challenge/session logic above is untouched).
          const next = resolvePostLoginDestination(attempt.redirectAfter);
          const url = new URL(
            absoluteInternalUrl(
              process.env["WEB_BASE_URL"] || "https://www.proovra.com",
              internalNavPath("/auth/mfa-challenge"),
            ),
          );
          url.searchParams.set("next", next);
          return reply.code(302).redirect(url.toString());
        }

        // Mint the JWT. We reuse the existing token shape so the
        // auth middleware accepts the session unchanged.
        const ttlSeconds = 60 * 60 * 24 * 30;
        const issuedAt = Math.floor(Date.now() / 1000);
        const payload = {
          sub: result.user.id,
          provider: "EMAIL", // SSO-provisioned users are EMAIL provider; IdP link is in ExternalIdentityMapping
          // PHASE 10 §10.2 — server-verified OIDC provenance (set only AFTER
          // token/issuer/audience/nonce/state validation above).
          authMethod: "OIDC" as const,
          authAt: issuedAt,
          // §10.2 — ORG-BOUND SSO satisfaction: the exact verified connection.
          ssoConnId: result.connectionId,
          email: result.user.email,
        };
        const token = signJwt(payload, jwtSecret, ttlSeconds);
        // 2026-10-28 — key the inventory row and the Organization session
        // context by the sid the token ACTUALLY carries (`signJwt` assigns
        // its own; a pre-generated value never reached the token).
        const { sid, exp } = mintedSessionClaims(token);

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
            // 2026-10-28 — the assurance the verified id_token asserted
            // (`acr`, `auth_time`); never the token itself.
            authMethod: "OIDC",
            authnContext: result.idp.acr,
            idpAuthAtUtc: result.idp.authTime,
          },
          prisma,
        );

        // IDENT-011 — the same completion the MFA routes run: scored, managed
        // provisioning, and the Organization context under its session limit,
        // before any cookie. A refusal leaves no session.
        const completion = await completeSsoSession(
          {
            userId: result.user.id,
            teamId: result.teamId,
            ssoConnectionId: conn.id,
            source: "OIDC",
            sessionId: session.id,
            sid,
          },
          prisma,
        );
        if (!completion.allowed) {
          return bounceToAuthError(reply, completion.reason, attempt.redirectAfter);
        }

        setSessionCookie(req, reply, token);
        clearSsoBrowserBinding(reply);

        // PHASE 11 — canonical safe-destination validation before redirect
        // (or workspace home). IDENT-003 — on the web host: this route is not.
        const redirectTarget = resolvePostLoginDestination(attempt.redirectAfter);
        return reply.code(302).redirect(webPageUrl(redirectTarget));
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
          return fail(
            err.code === "SSO_SEAT_LIMIT_REACHED"
              ? "seat_limit_reached"
              : err.code === "SSO_SEAT_CONTENTION"
                ? "seat_contention"
                : err.code.toLowerCase(),
            attempt.redirectAfter,
          );
        }
        return fail("sso_callback_failed");
      }
    },
  );
}
