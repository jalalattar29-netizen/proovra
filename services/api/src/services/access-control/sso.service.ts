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
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

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
      | "SSO_OIDC_USERINFO_INVALID",
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
};

function projectConnection(row: DbConnection): SsoConnectionProjection {
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
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "sso.connection.create",
    category: "identity",
    severity: "warning",
    source: "sso_service",
    outcome: "success",
    resourceType: "sso_connection",
    resourceId: row.id,
    metadata: { teamId: input.teamId, provider: input.provider },
    db: client,
  });

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
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "sso.connection.transition",
    category: "identity",
    severity: input.nextStatus === "REVOKED" ? "warning" : "info",
    source: "sso_service",
    outcome: "success",
    resourceType: "sso_connection",
    resourceId: row.id,
    metadata: { teamId: input.teamId, from, to: input.nextStatus },
    db: client,
  });
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
};

const oidcDiscoveryCache = new Map<string, OidcDiscovery>();

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
    !json.userinfo_endpoint
  ) {
    throw new SsoServiceError("SSO_DISCOVERY_FAILED", {
      reason: "missing_endpoint",
    });
  }
  const discovery: OidcDiscovery = {
    authorization_endpoint: json.authorization_endpoint,
    token_endpoint: json.token_endpoint,
    userinfo_endpoint: json.userinfo_endpoint,
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

    // Ensure the user is a team member (idempotent).
    await client.teamMember.upsert({
      where: { teamId_userId: { teamId: conn.teamId, userId } },
      update: {},
      create: {
        teamId: conn.teamId,
        userId,
        role: role === "VIEWER" ? "VIEWER" : "MEMBER",
        status: "ACTIVE",
        accessGrantedByUserId: conn.createdByUserId,
        accessReason: `SSO JIT (${conn.provider})`,
      },
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
