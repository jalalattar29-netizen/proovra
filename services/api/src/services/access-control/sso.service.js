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
import { SSO_PROVIDERS, SsoConnectionCreateInputSchema, emailMatchesAllowedDomains, evaluateJitProvisioning, isAllowedSsoConnectionTransition, ssoProviderProtocol, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------
export class SsoServiceError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "SsoServiceError";
    }
}
// -----------------------------------------------------------------------------
// Hash helpers
// -----------------------------------------------------------------------------
function hashClientSecret(secret) {
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
function previewClientSecret(secret) {
    const tail = secret.slice(-4);
    return `ck-***-${tail}`;
}
function projectConnection(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        provider: row.provider,
        displayName: row.displayName,
        status: row.status,
        issuerUrl: row.issuerUrl,
        clientId: row.clientId,
        clientSecretPreview: row.clientSecretPreview,
        allowedEmailDomains: row.allowedEmailDomains,
        jitDefaultRole: row.jitDefaultRole === "MEMBER" || row.jitDefaultRole === "VIEWER"
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
const PROVIDER_SET = new Set(SSO_PROVIDERS);
export async function listSsoConnections(input, client = defaultPrisma) {
    const rows = await client.ssoConnection.findMany({
        where: { teamId: input.teamId },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: 100,
    });
    return rows.map(projectConnection);
}
export async function getSsoConnection(input, client = defaultPrisma) {
    const row = await client.ssoConnection.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    return row ? projectConnection(row) : null;
}
export async function createSsoConnection(input, client = defaultPrisma) {
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
        provider: input.provider,
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
                samlMetadataJson: input.samlMetadataJson,
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
export async function transitionSsoConnection(input, client = defaultPrisma) {
    const row = await client.ssoConnection.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!row)
        throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
    const from = row.status;
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
            revokedByUserId: input.nextStatus === "REVOKED" ? input.actorUserId : null,
            revokedReason: input.nextStatus === "REVOKED" ? input.reason ?? null : null,
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
    }
    else {
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
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const oidcStateStore = new Map();
function purgeExpiredOidcState() {
    const now = Date.now();
    for (const [k, v] of oidcStateStore) {
        if (v.expiresAtMs < now)
            oidcStateStore.delete(k);
    }
}
export async function buildOidcAuthorizationUrl(input, client = defaultPrisma) {
    const conn = await client.ssoConnection.findFirst({
        where: {
            id: input.connectionId,
            teamId: input.teamId,
            status: "ACTIVE",
        },
    });
    if (!conn)
        throw new SsoServiceError("SSO_CONNECTION_NOT_FOUND");
    if (ssoProviderProtocol(conn.provider) !== "OIDC") {
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
const oidcDiscoveryCache = new Map();
async function fetchOidcDiscovery(issuerUrl) {
    const cached = oidcDiscoveryCache.get(issuerUrl);
    if (cached)
        return cached;
    let res;
    try {
        res = await fetch(issuerUrl, { method: "GET" });
    }
    catch {
        throw new SsoServiceError("SSO_DISCOVERY_FAILED");
    }
    if (!res.ok) {
        throw new SsoServiceError("SSO_DISCOVERY_FAILED", { status: res.status });
    }
    const json = (await res.json());
    if (!json.authorization_endpoint ||
        !json.token_endpoint ||
        !json.userinfo_endpoint) {
        throw new SsoServiceError("SSO_DISCOVERY_FAILED", {
            reason: "missing_endpoint",
        });
    }
    const discovery = {
        authorization_endpoint: json.authorization_endpoint,
        token_endpoint: json.token_endpoint,
        userinfo_endpoint: json.userinfo_endpoint,
    };
    oidcDiscoveryCache.set(issuerUrl, discovery);
    return discovery;
}
export async function handleOidcCallback(input, client = defaultPrisma) {
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
    let exchangeBody;
    try {
        exchangeBody = new URLSearchParams({
            grant_type: "authorization_code",
            code: input.code,
            redirect_uri: input.redirectUri,
            client_id: conn.clientId,
            client_secret: clientSecret,
        });
    }
    catch {
        throw new SsoServiceError("SSO_CODE_EXCHANGE_FAILED");
    }
    let tokenJson;
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
        tokenJson = (await tokenRes.json());
    }
    catch (err) {
        if (err instanceof SsoServiceError)
            throw err;
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
    let userinfo;
    try {
        const uiRes = await fetch(discovery.userinfo_endpoint, {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (!uiRes.ok) {
            bump("sso_login_failure_total");
            throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
        }
        userinfo = (await uiRes.json());
    }
    catch (err) {
        if (err instanceof SsoServiceError)
            throw err;
        bump("sso_login_failure_total");
        throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
    }
    if (!userinfo.sub || !userinfo.email) {
        bump("sso_login_failure_total");
        throw new SsoServiceError("SSO_OIDC_USERINFO_INVALID");
    }
    // ---- Allowed-email-domains gate ----
    if (!emailMatchesAllowedDomains(userinfo.email, conn.allowedEmailDomains)) {
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
    let userId;
    let isNewlyProvisioned = false;
    let role = "MEMBER";
    if (externalMapping) {
        userId = externalMapping.userId;
    }
    else {
        // JIT path
        const jitPolicy = {
            enabled: !!conn.jitDefaultRole,
            defaultRole: conn.jitDefaultRole === "MEMBER" || conn.jitDefaultRole === "VIEWER"
                ? conn.jitDefaultRole
                : null,
            allowedEmailDomains: conn.allowedEmailDomains,
        };
        const jitDecision = evaluateJitProvisioning(jitPolicy, userinfo.email);
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
        }
        else {
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
let clientSecretResolver = (id) => {
    const env = process.env[`SSO_CLIENT_SECRET_${id.toUpperCase().replace(/-/g, "_")}`];
    return env ?? null;
};
export function setClientSecretResolver(fn) {
    clientSecretResolver = fn;
}
function resolveClientSecretForExchange(connectionId) {
    return clientSecretResolver(connectionId);
}
// -----------------------------------------------------------------------------
// Test helper — clear in-process OIDC state map between tests.
// -----------------------------------------------------------------------------
export function __resetSsoServiceStateForTests() {
    oidcStateStore.clear();
    oidcDiscoveryCache.clear();
}
