/**
 * Phase R8.2 — Real SAML Service Provider routes.
 *
 *   GET  /v1/auth/saml/:connectionId/login     — HTTP-Redirect binding initiation
 *   POST /v1/auth/saml/acs                     — HTTP-POST binding ACS handler
 *   GET  /v1/auth/saml/metadata/:connectionId  — SP metadata XML (for IdP config)
 *
 * Hard rules:
 *   - Unsigned assertions are ALWAYS rejected (saml-assertion.service.ts).
 *   - IdP certificate is pinned from SsoConnection.samlCertificate; KeyInfo
 *     in the assertion is IGNORED.
 *   - Replay protection: SsoCallbackAttempt rows via persistSamlCallbackAttempt;
 *     consumeCallbackAttempt atomically flips PENDING → CONSUMED.
 *   - InResponseTo MUST match the stored AuthnRequest ID.
 *   - Audience restriction enforced against the SP entityID.
 *   - MFA enforcement runs AFTER assertion validation via
 *     resolveLoginMfaEnforcement (same path as OIDC).
 *   - The cookie shape MUST match the existing auth route's cookie
 *     (proovra_session, httpOnly, secure, sameSite: lax, 30-day maxAge).
 *   - No raw assertion XML, NameID, SAML attributes, certificates, or
 *     session tokens are ever logged.
 *   - No open redirects — every redirectAfter is validated against
 *     isSafeRedirectAfter before being written to the DB and at consume.
 *   - This file DOES NOT modify sso-auth.routes.ts or auth.routes.ts.
 *     It is an additive surface registered separately in server.ts.
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
import { resolveLoginMfaEnforcement } from "../services/security/login-mfa-enforcement.service.js";
import {
  createMfaPendingChallenge,
} from "../services/security/mfa.service.js";
import {
  validateSamlResponse,
  SamlAssertionError,
} from "../services/security/saml-assertion.service.js";
import {
  handleSamlAssertion,
  SamlMappingError,
} from "../services/security/saml-user-mapping.service.js";
// SAML admin endpoints are Enterprise-only — gate resolver imported
// from a shared service to keep this file within the R8 baseline.
import { resolveSamlConnectionEnterpriseGate } from "../services/enterprise-gate-resolvers.service.js";
import {
  buildSamlAuthnRequest,
} from "../services/security/saml-authn-request.service.js";
import {
  parseSamlMetadata,
  SamlMetadataError,
} from "../services/security/saml-metadata.service.js";
import {
  parseCertExpiry,
  getCertExpiryStatus,
  emitCertExpiryWarningIfNeeded,
} from "../services/security/saml-cert.service.js";
import { SAML_FAILURE_CATEGORY_LABELS } from "../services/security/saml-assertion.service.js";
import {
  consumeCallbackAttempt,
  markCallbackFailed,
  noteSsoFailure,
  noteSsoSuccess,
  persistSamlCallbackAttempt,
} from "../services/access-control/sso-hardening.service.js";
import { recordAuthenticatedSession } from "../services/access-control/session-inventory.service.js";
import { detectAndScoreSession } from "../services/access-control/suspicious-session.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { bump } from "../services/ops/metrics.service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAML_LOGIN_TTL_SECONDS = 10 * 60; // 10 minutes — matches OIDC TTL
const SAML_DEFAULT_NAME_ID_FORMAT =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

// ---------------------------------------------------------------------------
// Helpers (mirror sso-auth.routes.ts helpers exactly for session consistency)
// ---------------------------------------------------------------------------

function ipPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
  }
  return ip.slice(0, 10) + "…";
}

function uaPreview(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  if (typeof raw !== "string") return null;
  return raw.trim().slice(0, 120);
}

function deviceIdHash(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  const lang = req.headers["accept-language"];
  if (typeof ua !== "string" || ua.length === 0) return null;
  const raw = `${ua}|${typeof lang === "string" ? lang : ""}`;
  const secret =
    process.env["IDENTITY_SECURITY_HASH_SECRET"] || "phase26-dev";
  return createHash("sha256")
    .update(secret + ":" + raw)
    .digest("hex");
}

function sanitiseRedirectAfter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return null;
  return trimmed;
}

/**
 * Bounce the user to /auth?saml_error=… with a sanitised reason code.
 * No raw assertion content, NameID, or IdP error text is passed through.
 */
function bounceToSamlError(
  reply: FastifyReply,
  reason: string,
  redirectAfter?: string | null,
): void {
  const params = new URLSearchParams();
  params.set("saml_error", reason.slice(0, 64));
  if (redirectAfter) params.set("redirect_after", redirectAfter);
  reply.code(302).redirect(`/auth?${params.toString()}`);
}

/**
 * Sets the proovra_session cookie with the same options as sso-auth.routes.ts
 * and auth.routes.ts so the auth middleware accepts the session.
 */
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
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
  reply.clearCookie("proovra_session", { path: "/", domain: ".proovra.com" });
  reply.clearCookie("proovra_session", { path: "/" });
  reply.setCookie("proovra_session", token, opts);
}

/**
 * Builds the SP entityID for a given connection.
 * Canonical form: {apiBaseUrl}/saml/sp/{connectionId}
 */
function buildSpEntityId(connectionId: string): string {
  const base =
    process.env["API_BASE_URL"] ?? "https://api.proovra.com";
  return `${base.replace(/\/$/, "")}/saml/sp/${connectionId}`;
}

/**
 * Builds the ACS (AssertionConsumerService) URL.
 * HTTP-POST binding endpoint that the IdP will POST the SAMLResponse to.
 */
function buildAcsUrl(req: FastifyRequest): string {
  const env = process.env["SAML_ACS_URL"];
  if (env) return env;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] ?? "";
  return `${proto}://${host}/v1/auth/saml/acs`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function samlAuthRoutes(app: FastifyInstance): Promise<void> {
  const jwtSecret = process.env["AUTH_JWT_SECRET"];
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  const samlEnabled = process.env["SAML_ENABLED"] !== "false";

  // -------------------------------------------------------------------------
  // GET /v1/auth/saml/:connectionId/login
  //
  // HTTP-Redirect binding initiation. Builds an AuthnRequest, persists the
  // state (RelayState) in SsoCallbackAttempt for replay protection, and
  // redirects the user's browser to the IdP SSO URL.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/auth/saml/:connectionId/login",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply
          .code(503)
          .send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const q = z
        .object({ redirectAfter: z.string().max(400).optional() })
        .parse(req.query ?? {});

      // Look up the SAML connection — must be ACTIVE with cert configured
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          teamId: true,
          status: true,
          provider: true,
          samlSsoUrl: true,
          samlCertificate: true,
          samlNameIdFormat: true,
          samlEntityId: true,
        },
      });

      if (!conn || conn.status !== "ACTIVE") {
        return bounceToSamlError(reply, "saml_connection_unavailable");
      }
      if (
        !conn.samlSsoUrl ||
        !conn.samlCertificate
      ) {
        return bounceToSamlError(reply, "saml_not_configured");
      }

      const spEntityId =
        conn.samlEntityId || buildSpEntityId(conn.id);
      const acsUrl = buildAcsUrl(req);
      const nameIdFormat = conn.samlNameIdFormat ?? SAML_DEFAULT_NAME_ID_FORMAT;

      try {
        // Build AuthnRequest
        const { requestId, redirectUrl, relayState } = buildSamlAuthnRequest({
          connectionId: conn.id,
          spEntityId,
          acsUrl,
          idpSsoUrl: conn.samlSsoUrl,
          nameIdFormat,
          forceAuthn: false,
        });

        // Persist state for replay protection
        const persist = await persistSamlCallbackAttempt(
          {
            teamId: conn.teamId,
            ssoConnectionId: conn.id,
            relayStateRaw: relayState,
            samlAuthnRequestId: requestId,
            redirectAfter: sanitiseRedirectAfter(q.redirectAfter),
            ipPreview: ipPreview(req),
            uaPreview: uaPreview(req),
            ttlSeconds: SAML_LOGIN_TTL_SECONDS,
          },
          prisma,
        );

        if (!persist.ok) {
          return bounceToSamlError(reply, "saml_state_persist_failed");
        }

        bump("saml_login_initiated_total");
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: "saml_login_started",
          severity: "INFO",
          details: {
            connectionId: conn.id,
            provider: conn.provider,
          },
        });

        // HTTP-Redirect binding: 302 to IdP with SAMLRequest + RelayState
        return reply.code(302).redirect(redirectUrl);
      } catch (err) {
        await noteSsoFailure(
          { connectionId: conn.id, reason: "saml_initiate_failed" },
          prisma,
        );
        return bounceToSamlError(reply, "saml_initiate_failed");
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/saml/acs
  //
  // HTTP-POST binding Assertion Consumer Service. The IdP POSTs the
  // base64-encoded SAMLResponse and the RelayState here.
  //
  // Body: application/x-www-form-urlencoded
  //   SAMLResponse = <base64-encoded XML>
  //   RelayState   = <opaque string from initiation>
  //
  // Flow:
  //   1. Parse + validate body.
  //   2. Consume SsoCallbackAttempt by RelayState (replay protection).
  //   3. Look up SsoConnection via attempt.ssoConnectionId.
  //   4. Validate SAMLResponse XML + signature.
  //   5. Verify InResponseTo matches stored samlAuthnRequestId.
  //   6. Map assertion to internal user (JIT provision if needed).
  //   7. Resolve MFA enforcement.
  //   8. Mint JWT + set proovra_session cookie + redirect.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/auth/saml/acs",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply
          .code(503)
          .send({ error: { code: "saml_disabled" } });
      }

      // Parse form body — set by the global x-www-form-urlencoded parser
      const body = req.body as Record<string, string> | undefined;
      const samlResponseRaw = body?.["SAMLResponse"];
      const relayStateRaw = body?.["RelayState"];

      if (!samlResponseRaw || typeof samlResponseRaw !== "string") {
        return reply
          .code(400)
          .send({ error: { code: "saml_missing_response" } });
      }

      // -----------------------------------------------------------------------
      // Step 2: Consume SsoCallbackAttempt by RelayState
      // -----------------------------------------------------------------------
      if (!relayStateRaw || typeof relayStateRaw !== "string") {
        // No RelayState — we can't correlate to an AuthnRequest.
        // Reject: we require InResponseTo correlation.
        return bounceToSamlError(reply, "saml_missing_relay_state");
      }

      const consume = await consumeCallbackAttempt(
        { stateRaw: relayStateRaw },
        prisma,
      );
      if (!consume.ok) {
        // Expired or replayed — security event already emitted by hardening service
        bump("saml_relay_state_invalid_total");
        return bounceToSamlError(reply, `saml_${consume.reason.toLowerCase()}`);
      }
      // TypeScript narrows consume to { ok: true; attempt: DbAttempt } here
      const attempt = consume.attempt;

      // -----------------------------------------------------------------------
      // Step 3: Look up SsoConnection
      // -----------------------------------------------------------------------
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: attempt.ssoConnectionId },
        select: {
          id: true,
          teamId: true,
          status: true,
          provider: true,
          samlSsoUrl: true,
          samlCertificate: true,
          // R8.2.1 — include rotation cert so both are tried during rotation window
          samlCertificateNext: true,
          samlNameIdFormat: true,
          samlEntityId: true,
          samlAttributeMapping: true,
          allowedEmailDomains: true,
          jitDefaultRole: true,
          // R8.2.1 — SCIM-managed JIT gate
          samlScimManaged: true,
        },
      });

      if (!conn || conn.status !== "ACTIVE") {
        await markCallbackFailed(
          { attemptId: attempt.id, reason: "connection_unavailable" },
          prisma,
        );
        return bounceToSamlError(
          reply,
          "saml_connection_unavailable",
          attempt.redirectAfter,
        );
      }

      if (!conn.samlCertificate) {
        await markCallbackFailed(
          { attemptId: attempt.id, reason: "cert_not_configured" },
          prisma,
        );
        return bounceToSamlError(
          reply,
          "saml_not_configured",
          attempt.redirectAfter,
        );
      }

      const spEntityId =
        conn.samlEntityId || buildSpEntityId(conn.id);

      try {
        // ---------------------------------------------------------------
        // Step 4: Validate SAMLResponse (XML signature + conditions)
        // ---------------------------------------------------------------
        const assertion = validateSamlResponse({
          samlResponseBase64: samlResponseRaw,
          idpCertificate: conn.samlCertificate,
          // R8.2.1 — rotation cert (null if not set)
          idpCertificateNext: conn.samlCertificateNext ?? null,
          spEntityId,
          expectedInResponseTo: attempt.samlAuthnRequestId ?? undefined,
          allowedClockSkewSeconds: 60,
        });

        // ---------------------------------------------------------------
        // Step 5: InResponseTo correlation already validated inside
        // validateSamlResponse when expectedInResponseTo is provided.
        // Double-check here for defense in depth.
        // ---------------------------------------------------------------
        if (
          attempt.samlAuthnRequestId &&
          assertion.inResponseTo !== attempt.samlAuthnRequestId
        ) {
          throw new SamlAssertionError(
            "SAML_IN_RESPONSE_TO_MISMATCH",
            "InResponseTo does not match stored AuthnRequest ID.",
          );
        }

        // ---------------------------------------------------------------
        // Step 6: Map assertion to internal user
        // ---------------------------------------------------------------
        const attributeMapping = conn.samlAttributeMapping as
          | { email?: string; name?: string; externalId?: string }
          | null;

        const result = await handleSamlAssertion(
          {
            teamId: conn.teamId,
            connectionId: conn.id,
            provider: conn.provider,
            assertion,
            allowedEmailDomains: conn.allowedEmailDomains,
            jitDefaultRole: conn.jitDefaultRole,
            attributeMapping,
            // R8.2.1 — SCIM-managed JIT gate
            scimManaged: conn.samlScimManaged,
          },
          prisma,
        );

        // Mark connection used
        await prisma.ssoConnection.update({
          where: { id: conn.id },
          data: { lastUsedAtUtc: new Date() },
        });
        await noteSsoSuccess(conn.id, prisma);

        // ---------------------------------------------------------------
        // Step 7: Resolve MFA enforcement (same path as OIDC).
        // resolveLoginMfaEnforcement reads the user's MFA status and all
        // applicable org policies internally — no pre-fetching needed.
        // ---------------------------------------------------------------
        const decision = await resolveLoginMfaEnforcement({
          userId: result.userId,
        });

        if (
          decision.outcome === "MFA_REQUIRED" ||
          decision.outcome === "ENROLLMENT_REQUIRED"
        ) {
          // Issue pending-MFA token + cookie; redirect to challenge page
          const challenge = await createMfaPendingChallenge({
            userId: result.userId,
            purpose: "LOGIN",
            ipAddress: req.ip ?? null,
            userAgent: uaPreview(req),
            metadata: { loginMethod: "sso_saml" },
          });
          const pendingToken = signMfaPendingToken(
            {
              sub: result.userId,
              provider: "EMAIL",
              email: result.email,
            },
            jwtSecret,
            challenge.jti,
          );

          const host = req.headers["host"] ?? "";
          const origin = req.headers["origin"] ?? "";
          const productionDomain =
            process.env["SSO_COOKIE_DOMAIN"] ||
            (host.includes("proovra.com") || origin.includes("proovra.com")
              ? ".proovra.com"
              : undefined);
          const secure =
            process.env["SSO_COOKIE_SECURE"] === "true" || !!productionDomain;

          reply.setCookie("proovra_mfa_pending", pendingToken, {
            httpOnly: true,
            secure,
            sameSite: "lax",
            path: "/",
            domain: productionDomain,
            maxAge: MFA_PENDING_TTL_SECONDS,
          });

          if (decision.policyLevel && decision.policyTeamId) {
            safeEmitSecurityEvent({
              teamId: decision.policyTeamId,
              eventType: "org_mfa_policy_enforced",
              severity: "INFO",
              details: {
                actorUserId: result.userId,
                loginMethod: "sso_saml",
                policyLevel: decision.policyLevel,
              },
            });
          }

          void appendPlatformAuditLog({
            userId: result.userId,
            action: "auth.mfa_challenge_issued",
            category: "auth",
            severity: "info",
            source: "api_saml_acs",
            outcome: "success",
            resourceType: "user_auth",
            resourceId: result.userId,
            requestId: req.id,
            metadata: {
              loginMethod: "sso_saml",
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

        // ---------------------------------------------------------------
        // Step 8: Mint JWT + session + cookie + redirect
        // ---------------------------------------------------------------
        const sid = randomBytes(16).toString("base64url");
        const ttlSeconds = 60 * 60 * 24 * 30; // 30 days
        const issuedAt = Math.floor(Date.now() / 1000);
        const exp = issuedAt + ttlSeconds;
        const payload = {
          sub: result.userId,
          provider: "EMAIL", // SAML-provisioned users use EMAIL provider; IdP link is in ExternalIdentityMapping
          email: result.email,
          sid,
          iat: issuedAt,
          exp,
        };
        const token = signJwt(payload, jwtSecret, ttlSeconds);

        const session = await recordAuthenticatedSession(
          {
            userId: result.userId,
            teamId: conn.teamId,
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

        await detectAndScoreSession(
          { teamId: conn.teamId, sessionId: session.id },
          prisma,
        ).catch(() => null);

        bump("saml_login_succeeded_total");
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: "saml_login_succeeded",
          severity: "INFO",
          details: {
            connectionId: conn.id,
            userId: result.userId,
            provider: conn.provider,
            nameIdHash: assertion.nameIdHash,
            isNewlyProvisioned: result.isNewlyProvisioned,
          },
        });

        void appendPlatformAuditLog({
          userId: result.userId,
          action: "auth.saml_login_succeeded",
          category: "auth",
          severity: "info",
          source: "api_saml_acs",
          outcome: "success",
          resourceType: "user_auth",
          resourceId: result.userId,
          requestId: req.id,
          metadata: {
            loginMethod: "sso_saml",
            connectionId: conn.id,
            provider: conn.provider,
            isNewlyProvisioned: result.isNewlyProvisioned,
          },
          ipAddress: req.ip,
          userAgent: uaPreview(req),
        }).catch(() => null);

        setSessionCookie(req, reply, token);
        const redirectTarget = attempt.redirectAfter ?? "/home";
        return reply.code(302).redirect(redirectTarget);
      } catch (err) {
        const reason =
          err instanceof SamlAssertionError
            ? err.code.toLowerCase()
            : err instanceof SamlMappingError
              ? err.code.toLowerCase()
              : "saml_acs_failed";

        await markCallbackFailed(
          { attemptId: attempt.id, reason: reason.slice(0, 64) },
          prisma,
        );
        await noteSsoFailure(
          { connectionId: conn.id, reason },
          prisma,
        );

        bump("saml_login_failure_total");
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: err instanceof SamlAssertionError
            ? "saml_assertion_rejected"
            : "saml_login_failed",
          severity: err instanceof SamlAssertionError ? "HIGH" : "WARNING",
          details: {
            connectionId: conn.id,
            reason,
          },
        });

        return bounceToSamlError(reply, reason, attempt.redirectAfter);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/auth/saml/metadata/:connectionId
  //
  // Returns the SP metadata XML for this connection so IdP administrators
  // can configure the connection on their IdP side. This is a public,
  // unauthenticated endpoint — it only exposes the SP's entityID and ACS URL.
  //
  // Does NOT expose the IdP certificate or any private material.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/auth/saml/metadata/:connectionId",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply
          .code(503)
          .send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          status: true,
          samlEntityId: true,
          samlNameIdFormat: true,
          // R8.2.2 — reflect signing status honestly in metadata
          samlSignRequests: true,
        },
      });

      if (!conn || conn.status === "REVOKED") {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const spEntityId =
        conn.samlEntityId || buildSpEntityId(conn.id);
      const acsUrl = buildAcsUrl(req);
      const nameIdFormat =
        conn.samlNameIdFormat ?? SAML_DEFAULT_NAME_ID_FORMAT;

      // R8.2.2 — honest AuthnRequestsSigned: reflect the stored flag.
      // NOTE: request signing is schema-supported but NOT YET implemented
      // in buildSamlAuthnRequest (no SP private key wiring exists).
      // This field is always false until R8.3 wires SP signing. We expose
      // the raw flag value so that if/when signing is implemented, the
      // metadata auto-updates without requiring a code change.
      const authnRequestsSigned = conn.samlSignRequests ? "true" : "false";

      // R8.2.2 — include all SP metadata fields per SAML 2.0 metadata spec:
      //   - entityID: the SP's unique identifier
      //   - WantAssertionsSigned: always true (we REQUIRE signed assertions)
      //   - AuthnRequestsSigned: false (unsigned requests, honest status)
      //   - NameIDFormat: the preferred NameID format
      //   - AssertionConsumerService: HTTP-POST binding ACS URL
      //   No private key material is included.
      //   No internal hostnames or non-production URLs.
      const xml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<md:EntityDescriptor`,
        `  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"`,
        `  entityID="${spEntityId}">`,
        `  <md:SPSSODescriptor`,
        `    AuthnRequestsSigned="${authnRequestsSigned}"`,
        `    WantAssertionsSigned="true"`,
        `    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
        `    <md:NameIDFormat>${nameIdFormat}</md:NameIDFormat>`,
        `    <md:AssertionConsumerService`,
        `      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
        `      Location="${acsUrl}"`,
        `      index="0"`,
        `      isDefault="true"/>`,
        `  </md:SPSSODescriptor>`,
        `</md:EntityDescriptor>`,
      ].join("\n");

      return reply
        .code(200)
        .header("Content-Type", "application/xml; charset=UTF-8")
        .header("Cache-Control", "public, max-age=3600")
        .send(xml);
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/saml/:connectionId/ingest-metadata
  //
  // Operator-facing: parses IdP metadata XML (raw body) and updates the
  // SsoConnection with the extracted fields. Requires ACTIVE OWNER/ADMIN.
  //
  // This is a convenience endpoint for the admin UI workflow. The operator
  // can paste the IdP metadata XML and we extract ssoUrl, certificate,
  // entityId, nameIdFormat automatically.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/auth/saml/:connectionId/ingest-metadata",
    {
      config: { requireAuth: true },
    } as never,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply
          .code(503)
          .send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const gate = await resolveSamlConnectionEnterpriseGate(connectionId);
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      // Accept raw XML body or JSON with { metadataXml, metadataUrl }
      let metadataXml: string | null = null;
      const body = req.body as
        | { metadataXml?: string; metadataUrl?: string }
        | string
        | undefined;

      if (typeof body === "string") {
        metadataXml = body;
      } else if (body && typeof body === "object") {
        if (typeof body.metadataXml === "string") {
          metadataXml = body.metadataXml;
        }
      }

      if (!metadataXml || metadataXml.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: { code: "metadata_xml_required" } });
      }
      if (metadataXml.length > 256 * 1024) {
        return reply
          .code(400)
          .send({ error: { code: "metadata_xml_too_large" } });
      }

      const actorUserId = (req as FastifyRequest & { user?: { sub?: string } })
        .user?.sub;
      if (!actorUserId) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }

      // Verify actor is OWNER/ADMIN of this connection's team
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, teamId: true, status: true },
      });
      if (!conn) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const membership = await prisma.teamMember.findFirst({
        where: {
          teamId: conn.teamId,
          userId: actorUserId,
          role: { in: ["OWNER", "ADMIN"] },
          status: "ACTIVE",
        },
      });
      if (!membership) {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      let parsed;
      try {
        parsed = parseSamlMetadata(metadataXml);
      } catch (err) {
        if (err instanceof SamlMetadataError) {
          return reply
            .code(422)
            .send({ error: { code: err.code.toLowerCase() } });
        }
        return reply
          .code(422)
          .send({ error: { code: "metadata_parse_failed" } });
      }

      // R8.2.2 — parse cert expiry (X.509 NotAfter) from the extracted cert.
      // This allows the admin UI and test-connection to surface expiry warnings.
      const certNotAfter = parseCertExpiry(parsed.certificate);

      await prisma.ssoConnection.update({
        where: { id: conn.id },
        data: {
          samlSsoUrl: parsed.ssoUrl,
          samlCertificate: parsed.certificate,
          samlCertFingerprint: parsed.certFingerprint,
          samlNameIdFormat: parsed.nameIdFormat,
          // R8.2.2 — store the IdP's entityID (distinct from the SP entityID).
          // samlEntityId is the SP's entityID and is NOT overwritten here.
          samlIdpEntityId: parsed.entityId,
          // R8.2.2 — store parsed cert expiry (null if not parseable).
          samlCertNotAfter: certNotAfter,
        },
      });

      // R8.2.2 — check cert expiry and emit warning if needed.
      emitCertExpiryWarningIfNeeded({
        teamId: conn.teamId,
        connectionId: conn.id,
        certFingerprint: parsed.certFingerprint,
        certNotAfter,
      });

      safeEmitSecurityEvent({
        teamId: conn.teamId,
        eventType: "saml_metadata_ingested",
        severity: "INFO",
        details: {
          connectionId: conn.id,
          certFingerprint: parsed.certFingerprint,
          // R8.2.2 — include IdP entityID and cert expiry in the event.
          idpEntityId: parsed.entityId,
          certNotAfter: certNotAfter?.toISOString() ?? null,
          actorUserId,
        },
      });

      return reply.code(200).send({
        ok: true,
        extracted: {
          ssoUrl: parsed.ssoUrl,
          certFingerprint: parsed.certFingerprint,
          nameIdFormat: parsed.nameIdFormat,
          // R8.2.2 — return both IdP entityID and cert expiry to the admin UI.
          entityId: parsed.entityId,
          certNotAfter: certNotAfter?.toISOString() ?? null,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/saml/:connectionId/test-connection
  //
  // R8.2.1 — Admin test-connection flow.
  //
  // Validates the current SAML configuration by performing a dry-run parse
  // of the stored IdP metadata fields (ssoUrl, entityId, certificate) and
  // confirming they are internally consistent. Does NOT issue a real session,
  // does NOT redirect the user to the IdP (that would require a browser round
  // trip), and does NOT create an ExternalIdentityMapping.
  //
  // Records the outcome (PASSED/FAILED) and sanitised error code in the
  // SsoConnection row so the admin UI can show health status without polling
  // security events.
  //
  // Requires: authenticated OWNER or ADMIN of the connection's team.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/auth/saml/:connectionId/test-connection",
    { config: { requireAuth: true } } as never,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply.code(503).send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const gate = await resolveSamlConnectionEnterpriseGate(connectionId);
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const actorUserId = (req as FastifyRequest & { user?: { sub?: string } })
        .user?.sub;
      if (!actorUserId) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }

      // Load connection
      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          teamId: true,
          status: true,
          provider: true,
          samlSsoUrl: true,
          samlCertificate: true,
          samlCertificateNext: true,
          samlCertFingerprint: true,
          samlCertNextFingerprint: true,
          samlEntityId: true,
          samlNameIdFormat: true,
          // R8.2.2 — include expiry and IdP entity ID
          samlCertNotAfter: true,
          samlCertNextNotAfter: true,
          samlIdpEntityId: true,
        },
      });

      if (!conn) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // OWNER or ADMIN gate
      const membership = await prisma.teamMember.findFirst({
        where: {
          teamId: conn.teamId,
          userId: actorUserId,
          role: { in: ["OWNER", "ADMIN"] },
          status: "ACTIVE",
        },
      });
      if (!membership) {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      bump("saml_connection_test_total");
      safeEmitSecurityEvent({
        teamId: conn.teamId,
        eventType: "saml_connection_test_started",
        severity: "INFO",
        details: {
          connectionId: conn.id,
          actorUserId,
        },
      });

      // Run preflight checks (entirely local — no IdP round trip needed)
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

      // Check 1: SSO URL configured and plausible
      checks.push({
        name: "sso_url_configured",
        ok: !!conn.samlSsoUrl && conn.samlSsoUrl.startsWith("https://"),
        detail: conn.samlSsoUrl
          ? undefined
          : "samlSsoUrl is not set",
      });

      // Check 2: Primary certificate configured
      checks.push({
        name: "certificate_configured",
        ok: !!conn.samlCertificate && conn.samlCertificate.length > 100,
        detail: conn.samlCertificate
          ? undefined
          : "samlCertificate is not set",
      });

      // Check 3: SP entityID configured
      const spEntityId = conn.samlEntityId || buildSpEntityId(conn.id);
      checks.push({
        name: "entity_id_configured",
        ok: spEntityId.startsWith("https://"),
        detail: undefined,
      });

      // Check 4: Certificate fingerprint is present (indicates cert was parsed)
      checks.push({
        name: "certificate_fingerprint_present",
        ok: !!conn.samlCertFingerprint,
        detail: conn.samlCertFingerprint
          ? undefined
          : "Ingest IdP metadata to populate the certificate fingerprint",
      });

      // Check 5: Cert expiry — warn if expired or expiring within 90 days.
      // R8.2.2: This is a warning check (ok=true) unless already expired.
      const certExpiryStatus = getCertExpiryStatus(
        conn.samlCertNotAfter ? new Date(conn.samlCertNotAfter) : null,
      );
      const certIsExpired = certExpiryStatus === "expired";
      checks.push({
        name: "certificate_not_expired",
        ok: !certIsExpired,
        detail: certIsExpired
          ? `IdP certificate expired on ${conn.samlCertNotAfter?.toISOString() ?? "unknown date"}. Rotate immediately.`
          : certExpiryStatus !== "ok"
            ? `Certificate expires soon (${certExpiryStatus}): ${conn.samlCertNotAfter?.toISOString() ?? "unknown"}`
            : undefined,
      });

      // Emit cert expiry warning if needed (idempotent)
      emitCertExpiryWarningIfNeeded({
        teamId: conn.teamId,
        connectionId: conn.id,
        certFingerprint: conn.samlCertFingerprint,
        certNotAfter: conn.samlCertNotAfter ? new Date(conn.samlCertNotAfter) : null,
      });

      const allPassed = checks.every((c) => c.ok);
      const failedCheck = checks.find((c) => !c.ok);
      const errorCode = failedCheck
        ? failedCheck.name.toUpperCase()
        : null;

      // Record test result in the connection row
      await prisma.ssoConnection.update({
        where: { id: conn.id },
        data: {
          samlLastTestedAt: new Date(),
          samlLastTestStatus: allPassed ? "PASSED" : "FAILED",
          samlLastTestError: errorCode
            ? errorCode.slice(0, 128)
            : null,
        },
      });

      if (allPassed) {
        bump("saml_connection_test_total"); // already bumped above; this tracks success separately via event
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: "saml_connection_test_succeeded",
          severity: "INFO",
          details: {
            connectionId: conn.id,
            actorUserId,
          },
        });

        return reply.code(200).send({
          ok: true,
          status: "PASSED",
          checks,
          certFingerprint: conn.samlCertFingerprint ?? null,
          certNextFingerprint: conn.samlCertNextFingerprint ?? null,
        });
      } else {
        bump("saml_connection_test_failure_total");
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: "saml_connection_test_failed",
          severity: "WARNING",
          details: {
            connectionId: conn.id,
            actorUserId,
            errorCode,
          },
        });

        return reply.code(200).send({
          ok: false,
          status: "FAILED",
          checks,
          errorCode,
          certFingerprint: conn.samlCertFingerprint ?? null,
          certNextFingerprint: conn.samlCertNextFingerprint ?? null,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /v1/auth/saml/:connectionId/certificate-next
  //
  // R8.2.1 — Certificate rotation: set the secondary (next) IdP certificate.
  //
  // After setting, both the primary cert and the next cert are accepted during
  // signature verification on the ACS endpoint, enabling zero-downtime rotation.
  //
  // Body (JSON): { certificate: string (base64-only, no PEM headers) }
  //
  // Requires: authenticated OWNER or ADMIN.
  // -------------------------------------------------------------------------
  app.put(
    "/v1/auth/saml/:connectionId/certificate-next",
    { config: { requireAuth: true } } as never,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply.code(503).send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const gate = await resolveSamlConnectionEnterpriseGate(connectionId);
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const body = z
        .object({
          // Base64-only certificate (no PEM header/footer lines)
          certificate: z.string().min(100).max(8192),
        })
        .parse(req.body);

      const actorUserId = (req as FastifyRequest & { user?: { sub?: string } })
        .user?.sub;
      if (!actorUserId) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }

      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, teamId: true },
      });
      if (!conn) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const membership = await prisma.teamMember.findFirst({
        where: {
          teamId: conn.teamId,
          userId: actorUserId,
          role: { in: ["OWNER", "ADMIN"] },
          status: "ACTIVE",
        },
      });
      if (!membership) {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      // Compute fingerprint for the next cert
      const cleanedNextCert = body.certificate.replace(/\s+/g, "");
      const certDer = Buffer.from(cleanedNextCert, "base64");
      const fingerprint = createHash("sha256")
        .update(certDer)
        .digest("hex");

      // R8.2.2 — parse expiry from the new next cert so expiry warnings work
      const nextCertNotAfter = parseCertExpiry(cleanedNextCert);

      await prisma.ssoConnection.update({
        where: { id: conn.id },
        data: {
          samlCertificateNext: cleanedNextCert,
          samlCertNextFingerprint: fingerprint,
          // R8.2.2 — store next cert expiry for expiry warnings
          samlCertNextNotAfter: nextCertNotAfter,
        },
      });

      // R8.2.2 — emit expiry warning for the next cert if it is already near expiry
      emitCertExpiryWarningIfNeeded({
        teamId: conn.teamId,
        connectionId: conn.id,
        certFingerprint: fingerprint,
        certNotAfter: nextCertNotAfter,
        isNextCert: true,
      });

      bump("saml_certificate_rotation_total");
      safeEmitSecurityEvent({
        teamId: conn.teamId,
        eventType: "saml_certificate_rotated",
        severity: "INFO",
        details: {
          connectionId: conn.id,
          actorUserId,
          certNextFingerprint: fingerprint,
          action: "next_cert_added",
        },
      });

      return reply.code(200).send({
        ok: true,
        certNextFingerprint: fingerprint,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/auth/saml/:connectionId/certificate-next
  //
  // R8.2.1 — Certificate rotation: promote next cert to primary, clear next.
  //
  // Called AFTER the IdP has fully switched to the new certificate. Moves
  // samlCertificateNext → samlCertificate and clears the "next" slot so
  // only the new cert is accepted from that point forward.
  //
  // Requires: authenticated OWNER or ADMIN.
  // -------------------------------------------------------------------------
  app.delete(
    "/v1/auth/saml/:connectionId/certificate-next",
    { config: { requireAuth: true } } as never,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!samlEnabled) {
        return reply.code(503).send({ error: { code: "saml_disabled" } });
      }

      const { connectionId } = z
        .object({ connectionId: z.string().uuid() })
        .parse(req.params);

      const gate = await resolveSamlConnectionEnterpriseGate(connectionId);
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const actorUserId = (req as FastifyRequest & { user?: { sub?: string } })
        .user?.sub;
      if (!actorUserId) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }

      const conn = await prisma.ssoConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          teamId: true,
          samlCertificateNext: true,
          samlCertNextFingerprint: true,
          // R8.2.2 — carry over expiry when promoting
          samlCertNextNotAfter: true,
        },
      });
      if (!conn) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      if (!conn.samlCertificateNext) {
        return reply.code(409).send({ error: { code: "no_next_certificate" } });
      }

      const membership = await prisma.teamMember.findFirst({
        where: {
          teamId: conn.teamId,
          userId: actorUserId,
          role: { in: ["OWNER", "ADMIN"] },
          status: "ACTIVE",
        },
      });
      if (!membership) {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      // Promote: next → primary, compute new primary fingerprint
      const newCertFingerprint = conn.samlCertNextFingerprint;

      await prisma.ssoConnection.update({
        where: { id: conn.id },
        data: {
          samlCertificate: conn.samlCertificateNext,
          samlCertFingerprint: newCertFingerprint,
          // R8.2.2 — carry over the next cert's parsed expiry to the primary slot
          samlCertNotAfter: conn.samlCertNextNotAfter,
          samlCertificateNext: null,
          samlCertNextFingerprint: null,
          // R8.2.2 — clear the next cert's expiry slot
          samlCertNextNotAfter: null,
          rotatedAtUtc: new Date(),
        },
      });

      bump("saml_certificate_rotation_total");
      safeEmitSecurityEvent({
        teamId: conn.teamId,
        eventType: "saml_certificate_rotated",
        severity: "INFO",
        details: {
          connectionId: conn.id,
          actorUserId,
          certFingerprint: newCertFingerprint,
          action: "next_cert_promoted",
        },
      });

      return reply.code(200).send({
        ok: true,
        certFingerprint: newCertFingerprint,
      });
    },
  );
}
