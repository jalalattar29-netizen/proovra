/**
 * Phase 26 — Enterprise SSO foundations.
 *
 * Implements:
 *   - SsoConnection CRUD (create / list / update status / revoke)
 *   - OIDC initiate (returns the authorization URL the browser
 *     redirects to)
 *   - OIDC callback (exchanges code, fetches userinfo, validates
 *     against allowed_email_domains, JIT-provisions TeamMember when
 *     configured)
 *   - Auditability + metric integration
 *
 * Hard rules:
 *   - Client secrets are HASHED on insert and the plaintext is
 *     returned ONCE; rotation always re-hashes.
 *   - OIDC discovery doc is fetched on first use and cached in-memory
 *     for the process lifetime (cheap re-fetch on miss).
 *   - JIT provisioning ALWAYS goes through `linkExternalIdentity` so
 *     the Phase 17 ExternalIdentityMapping table is the canonical
 *     subject-to-user pointer.
 *   - We NEVER log the raw `code`, ID-token, or client secret.
 *
 * What is NOT in Phase 26 (deferred to Phase 27):
 *   - SAML protocol wiring (we accept SAML metadata blobs into the
 *     schema but do not parse / consume them).
 *   - Refresh-token handling for ongoing IdP session linkage.
 *   - Hardware-key bound sessions.
 */

import { createHash, randomBytes } from "node:crypto";

// P0 remediation (2026-07-21) — the enterprise OIDC SSO path must
// cryptographically validate the id_token (JWKS signature, issuer,
// audience, expiry, nonce) instead of trusting the userinfo endpoint
// alone. Same library the consumer Google/Apple login already uses.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type {
  PrismaClient,
  SsoConnection as DbConnection,
  ExternalIdentityProvider,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  SSO_PROVIDERS,
  SsoConnectionCreateInputSchema,
  emailMatchesAllowedDomains,
  evaluateJitProvisioning,
  isAllowedSsoConnectionTransition,
  ssoProviderProtocol,
  type JitProvisioningDecision,
  type JitProvisioningPolicy,
  type SsoConnectionCreateInput,
  type SsoConnectionStatus,
  type SsoProvider,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// Phase 3 — Enterprise Identity: shared SSO login enforcement point
// (enterprise-only + organization-workspace + verified-domain).
import { enforceSsoLoginPolicy } from "./sso-login-policy.service.js";
// P0 remediation (2026-07-21) — canonical guard for linking an IdP-asserted
// email to a PRE-EXISTING User (cross-tenant account-takeover fix).
import { evaluateExistingAccountLink } from "../security/enterprise-account-linking.service.js";
// PHASE 3 (2026-07-21) — canonical membership orchestrator.
import { provisionMembership } from "../identity/membership-provisioning.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class SsoServiceError extends Error {
  constructor(
    public readonly code:
      | "SSO_CONNECTION_NOT_FOUND"
      | "SSO_CONNECTION_REVOKED"
      | "SSO_INVALID_PROVIDER"
      | "SSO_INVALID_STATE"
      | "SSO_INVALID_TRANSITION"
      | "SSO_DISCOVERY_FAILED"
      | "SSO_CODE_EXCHANGE_FAILED"
      | "SSO_EMAIL_DOMAIN_NOT_ALLOWED"
      | "SSO_JIT_DISABLED"
      | "SSO_OIDC_USERINFO_INVALID"
      // Phase 3 — Enterprise Identity login-policy denials.
      | "SSO_NOT_ENTERPRISE"
      | "SSO_WORKSPACE_PERSONAL"
      | "SSO_DOMAIN_NOT_VERIFIED"
      // P0 remediation (2026-07-21) — id_token cryptographic validation
      // failures and unsafe existing-account link denials.
      | "SSO_OIDC_TOKEN_INVALID"
      | "SSO_ACCOUNT_LINK_DENIED"
      // Phase 3 — policy-update guard: cannot enable verified-domain
      // restriction when the owning org has zero verified domains.
      | "SSO_NO_VERIFIED_DOMAINS"
      // Phase 3 — a supplied SP private key was not a plausible PEM.
      | "SSO_INVALID_SP_KEY",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "SsoServiceError";
  }
}

// -----------------------------------------------------------------------------
// Hash helpers
// -----------------------------------------------------------------------------

function hashClientSecret(secret: string): string {
  // Server-side HMAC-SHA256 keyed by the API's master secret. Falls
  // back to a plain SHA-256 in dev environments without the key
  // (still one-way; never the raw secret).
  const key = process.env["AUTH_SECRET"] || process.env["JWT_SECRET"] || "";
  if (key) {
    return createHash("sha256")
      .update(key + ":" + secret)
      .digest("hex");
  }
  return createHash("sha256").update(secret).digest("hex");
}

function previewClientSecret(secret: string): string {
  const tail = secret.slice(-4);
  return `ck-***-${tail}`;
}

/**
 * Phase 3 — SHA-256 fingerprint of a SAML SP private key, hex, lowercase,
 * no colons. This is a ONE-WAY digest surfaced to the admin UI so an
 * operator can confirm WHICH key is installed without the key ever leaving
 * the server. It is NOT reversible and is safe to display. Normalises
 * whitespace/newlines so the same PEM produces a stable fingerprint.
 */
function fingerprintSpKey(pem: string): string {
  const normalized = pem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

// -----------------------------------------------------------------------------
// Projection — operator-safe; never echoes secrets.
// -----------------------------------------------------------------------------

export type SsoConnectionProjection = {
  id: string;
  teamId: string;
  provider: SsoProvider;
  displayName: string;
  status: SsoConnectionStatus;
  issuerUrl: string | null;
  clientId: string | null;
  clientSecretPreview: string | null;
  allowedEmailDomains: ReadonlyArray<string>;
  jitDefaultRole: "MEMBER" | "VIEWER" | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  rotatedAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  // -------------------------------------------------------------------------
  // Phase 3 — SAML SP signing + verified-domain policy STATUS.
  //
  // SECURITY: the SP private key is NEVER projected. We expose only:
  //   - whether AuthnRequest signing is enabled,
  //   - whether a per-connection key is installed and its SHA-256 fingerprint,
  //   - whether the platform-wide env key is available as a fallback source,
  //   - the effective signing-key source ("stored" | "env" | "none"),
  //   - whether verified-domain restriction is on.
  // -------------------------------------------------------------------------
  samlSignRequests: boolean;
  restrictToVerifiedDomains: boolean;
  samlSpKeyConfigured: boolean;
  samlSpKeyFingerprint: string | null;
  samlSpEnvKeyAvailable: boolean;
  samlSpSigningKeySource: "stored" | "env" | "none";
  samlSpCertificateConfigured: boolean;
};

function envSpKeyAvailable(): boolean {
  const envKey = process.env["SAML_SP_PRIVATE_KEY"];
  return !!(envKey && envKey.trim().length > 0);
}

function projectConnection(row: DbConnection): SsoConnectionProjection {
  const storedKey =
    typeof row.samlSpPrivateKey === "string" &&
    row.samlSpPrivateKey.trim().length > 0
      ? row.samlSpPrivateKey
      : null;
  const envAvailable = envSpKeyAvailable();
  const signingKeySource: "stored" | "env" | "none" = storedKey
    ? "stored"
    : envAvailable
      ? "env"
      : "none";
  return {
    id: row.id,
    teamId: row.teamId,
    provider: row.provider as SsoProvider,
    displayName: row.displayName,
    status: row.status as SsoConnectionStatus,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecretPreview: row.clientSecretPreview,
    allowedEmailDomains: row.allowedEmailDomains,
    jitDefaultRole:
      row.jitDefaultRole === "MEMBER" || row.jitDefaultRole === "VIEWER"
        ? row.jitDefaultRole
        : null,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAtUtc: row.lastUsedAtUtc?.toISOString() ?? null,
    rotatedAtUtc: row.rotatedAtUtc?.toISOString() ?? null,
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    // Phase 3 — status only; NEVER the key material.
    samlSignRequests: row.samlSignRequests,
    restrictToVerifiedDomains: row.restrictToVerifiedDomains,
    samlSpKeyConfigured: storedKey !== null,
    samlSpKeyFingerprint: storedKey ? fingerprintSpKey(storedKey) : null,
    samlSpEnvKeyAvailable: envAvailable,
    samlSpSigningKeySource: signingKeySource,
    samlSpCertificateConfigured:
      typeof row.samlSpCertificate === "string" &&
      row.samlSpCertificate.trim().length > 0,
  };
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

const PROVIDER_SET = new Set<string>(SSO_PROVIDERS);

export async function listSsoConnections(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<SsoConnectionProjection>> {
  const rows = await client.ssoConnection.findMany({
    where: { teamId: input.teamId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  return rows.map(projectConnection);
}

export async function getSsoConnection(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<SsoConnectionProjection | null> {
  const row = await client.ssoConnection.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  return row ? projectConnection(row) : null;
}

export type CreateSsoConnectionResult = {
  projection: SsoConnectionProjection;
  /** The raw client secret. Returned ONCE and never persisted in plaintext. */
  clientSecretOnce: string | null;
};

export async function createSsoConnection(
  input: SsoConnectionCreateInput & { actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<CreateSsoConnectionResult> {
  // Re-validate via the shared schema; routes already validate but
  // belt-and-braces.
  const parsed = SsoConnectionCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new SsoServiceError("SSO_INVALID_PROVIDER", {
      detail: parsed.error.flatten(),
    });
  }
  if (!PROVIDER_SET.has(input.provider)) {
    throw new SsoServiceError("SSO_INVALID_PROVIDER");
  }

  const clientSecretRaw = input.clientSecret ?? null;
  const data = {
    teamId: input.teamId,
    provider: input.provider as ExternalIdentityProvider,
    displayName: input.displayName.slice(0, 180),
    status: "PENDING",
    issuerUrl: input.issuerUrl ?? null,
    clientId: input.clientId ?? null,
    clientSecretHash: clientSecretRaw
      ? hashClientSecret(clientSecretRaw)
      : null,
    clientSecretPreview: clientSecretRaw
      ? previewClientSecret(clientSecretRaw)
      : null,
    ...(input.samlMetadataJson != null
      ? {
          samlMetadataJson:
            input.samlMetadataJson as prismaPkg.Prisma.InputJsonValue,
        }
      : {}),
    allowedEmailDomains: input.allowedEmailDomains ?? [],
    jitDefaultRole: input.jitDefaultRole ?? null,
    notes: input.notes ?? null,
    createdByUserId: input.actorUserId,
  };

  const row = await client.ssoConnection.create({ data });

  bump("sso_connection_created_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "sso_connection_created",
    severity: "WARNING",
    details: {
      connectionId: row.id,
      provider: input.provider,
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit({
    action: "sso.connection.create",
    outcome: "success",
    sourceApp: "SSO",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "sso_connection",
    resourceId: row.id,
    metadata: { provider: input.provider },
  }, client);

  return {
    projection: projectConnection(row),
    clientSecretOnce: clientSecretRaw,
  };
}

export async function transitionSsoConnection(
  input: {
    teamId: string;
    id: string;
    nextStatus: SsoConnectionStatus;
    actorUserId: string;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<SsoConnectionProjection> {
  const row = await client.ssoConnection.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!row) throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
  const from = row.status as SsoConnectionStatus;
  if (!isAllowedSsoConnectionTransition(from, input.nextStatus)) {
    throw new SsoServiceError("SSO_INVALID_TRANSITION", {
      from,
      to: input.nextStatus,
    });
  }
  const now = new Date();
  const updated = await client.ssoConnection.update({
    where: { id: row.id },
    data: {
      status: input.nextStatus,
      revokedAtUtc: input.nextStatus === "REVOKED" ? now : null,
      revokedByUserId:
        input.nextStatus === "REVOKED" ? input.actorUserId : null,
      revokedReason:
        input.nextStatus === "REVOKED" ? input.reason ?? null : null,
    },
  });
  if (input.nextStatus === "REVOKED") {
    bump("sso_connection_revoked_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "sso_connection_revoked",
      severity: "WARNING",
      details: {
        connectionId: row.id,
        provider: row.provider,
        actorUserId: input.actorUserId,
      },
    });
  } else {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "sso_connection_updated",
      severity: "INFO",
      details: {
        connectionId: row.id,
        from,
        to: input.nextStatus,
        actorUserId: input.actorUserId,
      },
    });
  }
  await emitTenantAudit({
    action: "sso.connection.transition",
    outcome: "success",
    sourceApp: "SSO",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "sso_connection",
    resourceId: row.id,
    metadata: { from, to: input.nextStatus },
  }, client);
  return projectConnection(updated);
}

// -----------------------------------------------------------------------------
// Phase 3 — SAML SP signing + verified-domain policy update.
//
// An enterprise ORG admin can, on an existing connection:
//   - enable/disable AuthnRequest signing (samlSignRequests),
//   - enable/disable verified-domain restriction (restrictToVerifiedDomains),
//   - install/rotate/clear the per-connection SP signing key + certificate.
//
// SECURITY (hard rules enforced here):
//   - The private key is ACCEPTED for storage but NEVER returned; the
//     projection exposes only status + a SHA-256 fingerprint.
//   - The key material is NEVER logged and NEVER placed in the audit payload
//     or the security-event details.
//   - Enabling restrictToVerifiedDomains is REJECTED when the owning org has
//     zero verified OrganizationDomain rows (guard, failure-closed).
// -----------------------------------------------------------------------------

export type UpdateSsoConnectionPolicyInput = {
  teamId: string;
  id: string;
  actorUserId: string;
  /** Enable/disable AuthnRequest signing. Omit to leave unchanged. */
  samlSignRequests?: boolean;
  /** Enable/disable verified-domain restriction. Omit to leave unchanged. */
  restrictToVerifiedDomains?: boolean;
  /**
   * Per-connection SP signing private key (PEM). When a non-empty string is
   * supplied it is stored and rotatedAtUtc is stamped. An explicit empty
   * string CLEARS the stored key (falls back to the env source). Omit
   * (undefined) to leave the current key untouched. NEVER echoed back.
   */
  samlSpPrivateKey?: string | null;
  /**
   * Per-connection SP certificate (base64, no PEM header/footer) advertised
   * in SP metadata. Empty string clears; omit to leave untouched.
   */
  samlSpCertificate?: string | null;
};

function looksLikePrivateKeyPem(pem: string): boolean {
  // Accept PKCS#8 or PKCS#1 PEM. We do not parse the key (no key material in
  // logs); we only sanity-check the envelope so we never store garbage.
  return (
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem) &&
    /-----END (?:RSA |EC )?PRIVATE KEY-----/.test(pem)
  );
}

async function countVerifiedDomainsForOrg(
  organizationId: string | null,
  client: PrismaClient,
): Promise<number> {
  if (!organizationId) return 0;
  return client.organizationDomain.count({
    where: { organizationId, verifiedAt: { not: null } },
  });
}

export async function updateSsoConnectionPolicy(
  input: UpdateSsoConnectionPolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<SsoConnectionProjection> {
  const row = await client.ssoConnection.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!row) throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
  if (row.status === "REVOKED") {
    throw new SsoServiceError("SSO_INVALID_STATE", { reason: "revoked" });
  }

  // Guard: enabling verified-domain restriction requires at least one verified
  // OrganizationDomain on the owning org. Failure-closed.
  if (input.restrictToVerifiedDomains === true) {
    const team = await client.team.findUnique({
      where: { id: input.teamId },
      select: { organizationId: true },
    });
    const verifiedCount = await countVerifiedDomainsForOrg(
      team?.organizationId ?? null,
      client,
    );
    if (verifiedCount === 0) {
      throw new SsoServiceError("SSO_NO_VERIFIED_DOMAINS");
    }
  }

  // Validate + normalise supplied key material (never logged).
  const now = new Date();
  const data: prismaPkg.Prisma.SsoConnectionUpdateInput = {};
  const changed: string[] = [];

  if (typeof input.samlSignRequests === "boolean") {
    data.samlSignRequests = input.samlSignRequests;
    changed.push("samlSignRequests");
  }
  if (typeof input.restrictToVerifiedDomains === "boolean") {
    data.restrictToVerifiedDomains = input.restrictToVerifiedDomains;
    changed.push("restrictToVerifiedDomains");
  }
  if (input.samlSpPrivateKey !== undefined) {
    if (input.samlSpPrivateKey === null || input.samlSpPrivateKey === "") {
      data.samlSpPrivateKey = null;
      changed.push("samlSpPrivateKey:cleared");
    } else {
      const pem = input.samlSpPrivateKey;
      if (!looksLikePrivateKeyPem(pem)) {
        throw new SsoServiceError("SSO_INVALID_SP_KEY");
      }
      data.samlSpPrivateKey = pem;
      data.rotatedAtUtc = now;
      // NOTE: only the fingerprint is ever surfaced — never the key.
      changed.push("samlSpPrivateKey:rotated");
    }
  }
  if (input.samlSpCertificate !== undefined) {
    data.samlSpCertificate =
      input.samlSpCertificate === null || input.samlSpCertificate === ""
        ? null
        : input.samlSpCertificate.slice(0, 8192);
    changed.push("samlSpCertificate");
  }

  if (changed.length === 0) {
    // Nothing to do — return the current projection unchanged.
    return projectConnection(row);
  }

  const updated = await client.ssoConnection.update({
    where: { id: row.id },
    data,
  });

  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "sso_connection_updated",
    severity: "WARNING",
    details: {
      connectionId: row.id,
      provider: row.provider,
      actorUserId: input.actorUserId,
      // Only field NAMES — never values, never key material.
      changed,
    },
  });
  await emitTenantAudit({
    action: "sso.connection.policy_update",
    outcome: "success",
    sourceApp: "SSO",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "sso_connection",
    resourceId: row.id,
    // Field names only. The key/cert VALUES never enter the audit payload.
    metadata: { changed },
  }, client);

  return projectConnection(updated);
}

// -----------------------------------------------------------------------------
// OIDC initiate
//
// Returns the authorization URL the browser should redirect to + the
// state token the callback must echo back. Phase 26 stores the state
// in a short-lived in-process map; production deploys can swap in
// a Redis-backed store later.
// -----------------------------------------------------------------------------

type OidcStateRecord = {
  connectionId: string;
  teamId: string;
  nonce: string;
  redirectAfter: string | null;
  expiresAtMs: number;
};

const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const oidcStateStore = new Map<string, OidcStateRecord>();

function purgeExpiredOidcState() {
  const now = Date.now();
  for (const [k, v] of oidcStateStore) {
    if (v.expiresAtMs < now) oidcStateStore.delete(k);
  }
}

export async function buildOidcAuthorizationUrl(
  input: {
    teamId: string;
    connectionId: string;
    redirectUri: string;
    redirectAfter?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ authorizationUrl: string; state: string }> {
  const conn = await client.ssoConnection.findFirst({
    where: {
      id: input.connectionId,
      teamId: input.teamId,
      status: "ACTIVE",
    },
  });
  if (!conn) throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
  if (ssoProviderProtocol(conn.provider as SsoProvider) !== "OIDC") {
    throw new SsoServiceError("SSO_INVALID_PROVIDER");
  }
  if (!conn.issuerUrl || !conn.clientId) {
    throw new SsoServiceError("SSO_INVALID_PROVIDER");
  }
  const discovery = await fetchOidcDiscovery(conn.issuerUrl);
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  purgeExpiredOidcState();
  oidcStateStore.set(state, {
    connectionId: conn.id,
    teamId: conn.teamId,
    nonce,
    redirectAfter: input.redirectAfter ?? null,
    expiresAtMs: Date.now() + OIDC_STATE_TTL_MS,
  });
  bump("sso_login_total");
  safeEmitSecurityEvent({
    teamId: conn.teamId,
    eventType: "sso_login_started",
    severity: "INFO",
    details: { connectionId: conn.id, provider: conn.provider },
  });
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", conn.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return { authorizationUrl: url.toString(), state };
}

// -----------------------------------------------------------------------------
// OIDC discovery cache
// -----------------------------------------------------------------------------

type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  // P0 remediation — required for id_token validation. `issuer` is the
  // canonical `iss` value the id_token must carry; `jwks_uri` is where
  // the IdP publishes its signing keys.
  issuer: string;
  jwks_uri: string;
};

const oidcDiscoveryCache = new Map<string, OidcDiscovery>();

// One remote JWKS resolver per jwks_uri (jose caches + re-fetches keys
// internally, honouring cache headers and kid rotation).
const oidcJwksCache = new Map<string, JWTVerifyGetKey>();

function jwksForUri(jwksUri: string): JWTVerifyGetKey {
  const cached = oidcJwksCache.get(jwksUri);
  if (cached) return cached;
  const resolver = createRemoteJWKSet(new URL(jwksUri));
  oidcJwksCache.set(jwksUri, resolver);
  return resolver;
}

async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const cached = oidcDiscoveryCache.get(issuerUrl);
  if (cached) return cached;
  let res: Response;
  try {
    res = await fetch(issuerUrl, { method: "GET" });
  } catch {
    throw new SsoServiceError("SSO_DISCOVERY_FAILED");
  }
  if (!res.ok) {
    throw new SsoServiceError("SSO_DISCOVERY_FAILED", { status: res.status });
  }
  const json = (await res.json()) as Partial<OidcDiscovery>;
  if (
    !json.authorization_endpoint ||
    !json.token_endpoint ||
    !json.userinfo_endpoint ||
    // P0 remediation — a discovery document without issuer + jwks_uri
    // cannot support id_token validation; fail closed at discovery.
    !json.issuer ||
    !json.jwks_uri
  ) {
    throw new SsoServiceError("SSO_DISCOVERY_FAILED", {
      reason: "missing_endpoint",
    });
  }
  const discovery: OidcDiscovery = {
    authorization_endpoint: json.authorization_endpoint,
    token_endpoint: json.token_endpoint,
    userinfo_endpoint: json.userinfo_endpoint,
    issuer: json.issuer,
    jwks_uri: json.jwks_uri,
  };
  oidcDiscoveryCache.set(issuerUrl, discovery);
  return discovery;
}

// -----------------------------------------------------------------------------
// OIDC callback
//
// Verifies state, exchanges code for ID-token + access-token, fetches
// userinfo, applies the allowed-email-domains gate, JIT-provisions
// when configured, and returns the linked user + minted session
// metadata so the route layer can issue the cookie.
// -----------------------------------------------------------------------------

export type OidcCallbackResult = {
  connectionId: string;
  teamId: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isNewlyProvisioned: boolean;
    role: "MEMBER" | "VIEWER";
  };
  redirectAfter: string | null;
};

export async function handleOidcCallback(
  input: {
    state: string;
    code: string;
    redirectUri: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<OidcCallbackResult> {
  purgeExpiredOidcState();
  const stateRecord = oidcStateStore.get(input.state);
  if (!stateRecord) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_INVALID_STATE");
  }
  oidcStateStore.delete(input.state); // single-use

  const conn = await client.ssoConnection.findFirst({
    where: { id: stateRecord.connectionId, teamId: stateRecord.teamId },
  });
  if (!conn) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
  }
  if (conn.status !== "ACTIVE") {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_CONNECTION_REVOKED");
  }
  if (!conn.issuerUrl || !conn.clientId || !conn.clientSecretHash) {
    throw new SsoServiceError("SSO_INVALID_PROVIDER");
  }

  const discovery = await fetchOidcDiscovery(conn.issuerUrl);

  // The route layer SHOULD pass the same raw client secret we stored
  // hashed; we don't have a way to recover it. Instead, the route
  // calls this service and the SSO connection points to the IdP — we
  // must rely on the operator's IdP to validate the client secret
  // server-side via the code exchange. Phase 26 design: the API holds
  // the client secret hash only for verification of operator UI
  // rotation, not for the IdP exchange. For the exchange itself, the
  // route layer must provide the raw secret it stores in a separate
  // KMS-backed env or by reading from the SSO connection at IdP setup
  // time. To keep this PR self-contained, we expose a "secrets
  // resolver" hook the route can override; default reads from env.
  const clientSecret = resolveClientSecretForExchange(conn.id);
  if (!clientSecret) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED", {
      reason: "client_secret_unavailable",
    });
  }

  // ---- Code exchange ----
  let exchangeBody: URLSearchParams;
  try {
    exchangeBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: conn.clientId,
      client_secret: clientSecret,
    });
  } catch {
    throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED");
  }

  let tokenJson: { id_token?: string; access_token?: string };
  try {
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: exchangeBody.toString(),
    });
    if (!tokenRes.ok) {
      bump("sso_login_failure_total");
      throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED", {
        status: tokenRes.status,
      });
    }
    tokenJson = (await tokenRes.json()) as {
      id_token?: string;
      access_token?: string;
    };
  } catch (err) {
    if (err instanceof SsoServiceError) throw err;
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED");
  }

  if (!tokenJson.access_token) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED", {
      reason: "no_access_token",
    });
  }

  // ---- id_token validation (P0 remediation, 2026-07-21) ----
  // The id_token is the cryptographic proof of identity for this login.
  // Signature is validated against the issuer's JWKS; `iss` must equal the
  // discovery document's issuer, `aud` must include our client_id, and the
  // `nonce` must echo the value we bound to this state record — closing
  // token-substitution / mix-up / replay paths the userinfo-only flow left
  // open. jwtVerify enforces exp/nbf with a bounded clock tolerance.
  if (!tokenJson.id_token) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_OIDC_TOKEN_INVALID", {
      reason: "no_id_token",
    });
  }
  let idTokenSub: string;
  try {
    const { payload } = await jwtVerify(
      tokenJson.id_token,
      jwksForUri(discovery.jwks_uri),
      {
        issuer: discovery.issuer,
        audience: conn.clientId,
        clockTolerance: 60,
      },
    );
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("missing_sub");
    }
    if (payload.nonce !== stateRecord.nonce) {
      throw new Error("nonce_mismatch");
    }
    idTokenSub = payload.sub;
  } catch {
    bump("sso_login_failure_total");
    safeEmitSecurityEvent({
      teamId: conn.teamId,
      eventType: "sso_login_failed",
      severity: "WARNING",
      details: {
        connectionId: conn.id,
        reason: "id_token_invalid",
        provider: conn.provider,
      },
    });
    throw new SsoServiceError("SSO_OIDC_TOKEN_INVALID");
  }

  // ---- Userinfo ----
  let userinfo: { sub?: string; email?: string; name?: string };
  try {
    const uiRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!uiRes.ok) {
      bump("sso_login_failure_total");
      throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
    }
    userinfo = (await uiRes.json()) as {
      sub?: string;
      email?: string;
      name?: string;
    };
  } catch (err) {
    if (err instanceof SsoServiceError) throw err;
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
  }

  if (!userinfo.sub || !userinfo.email) {
    bump("sso_login_failure_total");
    throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
  }

  // The userinfo response must describe the SAME subject the validated
  // id_token proved. A mismatch means the access token belongs to a
  // different principal than the authenticated one — reject.
  if (userinfo.sub !== idTokenSub) {
    bump("sso_login_failure_total");
    safeEmitSecurityEvent({
      teamId: conn.teamId,
      eventType: "sso_login_failed",
      severity: "WARNING",
      details: {
        connectionId: conn.id,
        reason: "userinfo_subject_mismatch",
        provider: conn.provider,
      },
    });
    throw new SsoServiceError("SSO_OIDC_TOKEN_INVALID", {
      reason: "userinfo_subject_mismatch",
    });
  }

  // ---- Allowed-email-domains gate ----
  if (
    !emailMatchesAllowedDomains(userinfo.email, conn.allowedEmailDomains)
  ) {
    bump("sso_login_failure_total");
    safeEmitSecurityEvent({
      teamId: conn.teamId,
      eventType: "sso_login_failed",
      severity: "WARNING",
      details: {
        connectionId: conn.id,
        reason: "email_domain_not_allowed",
        provider: conn.provider,
      },
    });
    throw new SsoServiceError("SSO_EMAIL_DOMAIN_NOT_ALLOWED");
  }

  // ---- Phase 3 — SSO login enforcement point ----
  // Enterprise-only + organization-workspace (never PERSONAL) + verified-domain
  // (when the connection restricts to verified OrganizationDomain rows). Runs
  // BEFORE any find-or-JIT so denied logins create no membership side-effects.
  const policy = await enforceSsoLoginPolicy(
    {
      teamId: conn.teamId,
      email: userinfo.email,
      restrictToVerifiedDomains: conn.restrictToVerifiedDomains,
    },
    client,
  );
  if (!policy.ok) {
    bump("sso_login_failure_total");
    safeEmitSecurityEvent({
      teamId: conn.teamId,
      eventType: "sso_login_failed",
      severity: "WARNING",
      details: {
        connectionId: conn.id,
        reason: policy.reason,
        provider: conn.provider,
      },
    });
    if (policy.reason === "sso_not_enterprise") {
      throw new SsoServiceError("SSO_NOT_ENTERPRISE");
    }
    if (policy.reason === "sso_workspace_personal") {
      throw new SsoServiceError("SSO_WORKSPACE_PERSONAL");
    }
    throw new SsoServiceError("SSO_DOMAIN_NOT_VERIFIED");
  }

  // ---- Find or JIT-provision the user ----
  const externalMapping = await client.externalIdentityMapping.findUnique({
    where: {
      provider_externalSubjectId: {
        provider: conn.provider,
        externalSubjectId: userinfo.sub,
      },
    },
  });

  let userId: string;
  let isNewlyProvisioned = false;
  let role: "MEMBER" | "VIEWER" = "MEMBER";

  if (externalMapping) {
    userId = externalMapping.userId;
  } else {
    // JIT path
    const jitPolicy: JitProvisioningPolicy = {
      enabled: !!conn.jitDefaultRole,
      defaultRole:
        conn.jitDefaultRole === "MEMBER" || conn.jitDefaultRole === "VIEWER"
          ? conn.jitDefaultRole
          : null,
      allowedEmailDomains: conn.allowedEmailDomains,
    };
    const jitDecision: JitProvisioningDecision = evaluateJitProvisioning(
      jitPolicy,
      userinfo.email,
    );
    if (!jitDecision.ok) {
      bump("sso_jit_denied_total");
      safeEmitSecurityEvent({
        teamId: conn.teamId,
        eventType: "sso_jit_denied",
        severity: "WARNING",
        details: {
          connectionId: conn.id,
          reason: jitDecision.reason,
        },
      });
      throw new SsoServiceError("SSO_JIT_DISABLED", { reason: jitDecision.reason });
    }
    role = jitDecision.role;

    // Find or create the User by email. If found, link; if not, create.
    const existingUser = await client.user.findFirst({
      where: { email: userinfo.email.toLowerCase() },
      select: { id: true },
    });
    if (existingUser) {
      // P0 remediation (2026-07-21) — linking to a PRE-EXISTING account is
      // only safe when the email's domain is DNS-verified by exactly this
      // connection's own organization (globally-unique claim). Without
      // this, an attacker-controlled IdP could assert any existing user's
      // email and receive a session as that user. Fail closed; JIT does
      // NOT fall through to creating a duplicate account.
      const link = await evaluateExistingAccountLink(
        { teamId: conn.teamId, email: userinfo.email },
        client,
      );
      if (!link.ok) {
        bump("sso_login_failure_total");
        safeEmitSecurityEvent({
          teamId: conn.teamId,
          eventType: "sso_login_failed",
          severity: "HIGH",
          details: {
            connectionId: conn.id,
            reason: `unsafe_account_link:${link.reason}`,
            provider: conn.provider,
          },
        });
        throw new SsoServiceError("SSO_ACCOUNT_LINK_DENIED", {
          reason: link.reason,
        });
      }
      userId = existingUser.id;
    } else {
      // SSO-provisioned users are tagged as EMAIL provider; their IdP
      // linkage is captured by the ExternalIdentityMapping row below.
      const created = await client.user.create({
        data: {
          email: userinfo.email.toLowerCase(),
          provider: "EMAIL",
          providerUserId: `sso-${userinfo.sub}`,
        },
        select: { id: true },
      });
      userId = created.id;
      isNewlyProvisioned = true;
    }

    // Link the external identity mapping.
    await client.externalIdentityMapping.create({
      data: {
        teamId: conn.teamId,
        userId,
        provider: conn.provider,
        externalSubjectId: userinfo.sub,
        displayName: userinfo.name ?? null,
        externalEmail: userinfo.email,
      },
    });

    // PHASE 3 (2026-07-21) — canonical orchestrator: SSO_JIT intent.
    // `preserveExistingStatus` keeps the pre-existing behavior that a login
    // NEVER silently reactivates a SUSPENDED/REVOKED member; the JIT grant
    // is recorded as an SSO_JIT-source provenance row either way.
    await provisionMembership(client, {
      intent: "SSO_JIT",
      source: "SSO_JIT",
      userId,
      workspace: {
        teamId: conn.teamId,
        role: role === "VIEWER" ? "VIEWER" : "MEMBER",
      },
      actorUserId: conn.createdByUserId ?? null,
      externalRef: `sso:${conn.provider}:${conn.id}`,
      accessReason: `SSO JIT (${conn.provider})`,
      preserveExistingStatus: true,
    });

    bump("sso_jit_provisioned_total");
    safeEmitSecurityEvent({
      teamId: conn.teamId,
      eventType: "sso_jit_provisioned",
      severity: "INFO",
      details: {
        connectionId: conn.id,
        userId,
        role,
      },
    });
  }

  // Mark the connection used.
  await client.ssoConnection.update({
    where: { id: conn.id },
    data: { lastUsedAtUtc: new Date() },
  });

  safeEmitSecurityEvent({
    teamId: conn.teamId,
    eventType: "sso_login_succeeded",
    severity: "INFO",
    details: { connectionId: conn.id, userId, provider: conn.provider },
  });

  return {
    connectionId: conn.id,
    teamId: conn.teamId,
    user: {
      id: userId,
      email: userinfo.email.toLowerCase(),
      displayName: userinfo.name ?? null,
      isNewlyProvisioned,
      role,
    },
    redirectAfter: stateRecord.redirectAfter,
  };
}

// -----------------------------------------------------------------------------
// Client-secret resolver hook
//
// The route layer can override the resolver to pull the raw secret
// from a KMS or secrets manager. Default reads from env keyed by
// connection id.
// -----------------------------------------------------------------------------

let clientSecretResolver: (connectionId: string) => string | null = (id) => {
  const env = process.env[`SSO_CLIENT_SECRET_${id.toUpperCase().replace(/-/g, "_")}`];
  return env ?? null;
};

export function setClientSecretResolver(
  fn: (connectionId: string) => string | null,
): void {
  clientSecretResolver = fn;
}

function resolveClientSecretForExchange(connectionId: string): string | null {
  return clientSecretResolver(connectionId);
}

// -----------------------------------------------------------------------------
// Test helper — clear in-process OIDC state map between tests.
// -----------------------------------------------------------------------------

export function __resetSsoServiceStateForTests(): void {
  oidcStateStore.clear();
  oidcDiscoveryCache.clear();
}
