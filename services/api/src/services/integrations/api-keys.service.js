/**
 * Phase 10 — API credential / service account service.
 *
 * Generates high-entropy API keys, stores only an HMAC of the raw value
 * plus an operator-visible prefix, validates inbound bearer tokens in
 * constant time, and exposes safe projections that never echo the hash
 * or raw key.
 *
 * Security model:
 *   - Raw key = `pwk_v1_<32-byte-base64url>`. ~256 bits of entropy.
 *   - Stored: `keyPrefix` (operator-visible identifier) + `keyHash`
 *     (HMAC-SHA256 of the raw key keyed by API_KEY_SECRET).
 *   - Verification: HMAC the inbound key, look up by `keyHash`.
 *   - Scopes are canonical permission identifiers from
 *     @proovra/shared/permissions.ts. A request is authorized when its
 *     credential's scopes contain the required permission.
 *
 * Feature flag: every routes that uses this service must additionally
 * check `INTEGRATIONS_ENABLED` so disabled deployments don't expose the
 * surface.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { API_KEY_RANDOM_BYTES, PERMISSIONS, deriveApiKeyDisplayPrefix, formatApiKeyValue, parseApiKeyShape, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
const INTEGRATIONS_FLAG = "INTEGRATIONS_ENABLED";
const API_KEY_SECRET_ENV = "API_KEY_SECRET";
export function isIntegrationsFeatureEnabled() {
    return process.env[INTEGRATIONS_FLAG] === "true";
}
function readApiKeySecret() {
    const raw = process.env[API_KEY_SECRET_ENV];
    if (!raw || raw.trim().length < 32)
        return null;
    if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) {
        return Buffer.from(raw, "hex");
    }
    return Buffer.from(raw, "utf8");
}
export function integrationsFeatureDisabledReason() {
    if (process.env[INTEGRATIONS_FLAG] !== "true")
        return "feature_flag_off";
    if (readApiKeySecret() === null)
        return "secret_missing";
    return null;
}
export function getIntegrationsRuntimeDiagnostics() {
    const rawApiKey = process.env[API_KEY_SECRET_ENV];
    const trimmedApiKey = (rawApiKey ?? "").trim();
    const apiKeySecretBound = trimmedApiKey.length > 0;
    const apiKeySecretLengthValid = trimmedApiKey.length >= 32;
    const rawCron = process.env.INTEGRATION_CRON_SECRET;
    const cronSecretBound = (rawCron ?? "").trim().length >= 16;
    const reason = integrationsFeatureDisabledReason();
    return {
        enabled: reason === null,
        apiKeySecretBound,
        apiKeySecretLengthValid,
        cronSecretBound,
        reason,
    };
}
function base64url(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
function hmacHex(secret, value) {
    return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
export function issueApiKey() {
    const secret = readApiKeySecret();
    if (!secret)
        return null;
    const body = base64url(randomBytes(API_KEY_RANDOM_BYTES));
    const rawKey = formatApiKeyValue(body);
    const keyHash = hmacHex(secret, rawKey);
    const keyPrefix = deriveApiKeyDisplayPrefix(rawKey);
    return { rawKey, keyHash, keyPrefix };
}
export function hashIncomingApiKey(rawKey) {
    const shape = parseApiKeyShape(rawKey);
    if (!shape)
        return null;
    const secret = readApiKeySecret();
    if (!secret)
        return null;
    return hmacHex(secret, rawKey);
}
export function constantTimeEqualHex(a, b) {
    if (a.length !== b.length || a.length !== 64)
        return false;
    if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b))
        return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
// -----------------------------------------------------------------------------
// Scope validation
// -----------------------------------------------------------------------------
const PERMISSION_SET = new Set(PERMISSIONS);
export function isValidScope(scope) {
    return PERMISSION_SET.has(scope);
}
export function filterValidScopes(scopes) {
    return scopes.filter(isValidScope);
}
export function scopesGrantPermission(scopes, permission) {
    return scopes.includes(permission);
}
export class ApiCredentialError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "ApiCredentialError";
    }
}
export async function createApiCredential(input, client = defaultPrisma) {
    if (integrationsFeatureDisabledReason()) {
        throw new ApiCredentialError("feature_disabled");
    }
    const validScopes = filterValidScopes(input.scopes);
    if (validScopes.length === 0) {
        throw new ApiCredentialError("invalid_scopes", {
            provided: input.scopes,
            reason: "At least one valid scope is required. Scope identifiers must match the canonical permission catalog.",
        });
    }
    const issued = issueApiKey();
    if (!issued)
        throw new ApiCredentialError("secret_missing");
    const credential = await client.apiCredential.create({
        data: {
            teamId: input.teamId,
            name: input.name.slice(0, 180),
            description: input.description?.slice(0, 2000) ?? null,
            keyPrefix: issued.keyPrefix,
            keyHash: issued.keyHash,
            scopes: validScopes,
            createdByUserId: input.actorUserId,
            status: "ACTIVE",
        },
    });
    return { credential, rawKey: issued.rawKey };
}
export async function listApiCredentials(input, client = defaultPrisma) {
    return client.apiCredential.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function revokeApiCredential(input, client = defaultPrisma) {
    const existing = await client.apiCredential.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new ApiCredentialError("credential_not_found");
    if (existing.status === "REVOKED")
        return existing;
    return client.apiCredential.update({
        where: { id: existing.id },
        data: {
            status: "REVOKED",
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
            revokedReason: input.reason?.slice(0, 400) ?? null,
            // Phase 2 — revoking a credential MUST also kill any in-flight
            // dual-active previous hash so the old raw key cannot be replayed
            // through the grace window after explicit revocation.
            previousKeyHash: null,
            previousKeyPrefix: null,
            previousValidUntilUtc: null,
        },
    });
}
// -----------------------------------------------------------------------------
// PHASE 2 — true dual-active rotation.
//
// rotateApiCredential() issues a brand-new raw key + hash + prefix and stores
// the PRIOR hash/prefix in the `previous_*` columns alongside an absolute
// cutoff (`previousValidUntilUtc = now + graceMinutes`). The new raw key is
// returned exactly once — the caller MUST surface it then drop it. After the
// cutoff, the verify path stops accepting the previous hash.
//
// Caller contract:
//   - The credential must be ACTIVE (REVOKED / hard-disabled cannot rotate).
//   - graceMinutes is clamped to [1, MAX_ROTATION_GRACE_MINUTES] (24h ceiling).
//   - rotation_required is cleared on success — the rotation just happened.
//   - lastUsedAtUtc is left untouched so the operator-facing "last used"
//     metric still reflects when the OLD key was last successfully verified.
//
// Audit: the route layer is responsible for writing the TeamActivity row
// because this service has no access to the actor's audit context other
// than `actorUserId`. The service guarantees DB consistency only.
// -----------------------------------------------------------------------------
export const MAX_ROTATION_GRACE_MINUTES = 24 * 60; // 1 day
export const DEFAULT_ROTATION_GRACE_MINUTES = 60;
function clampGraceMinutes(input) {
    const raw = input ?? DEFAULT_ROTATION_GRACE_MINUTES;
    if (!Number.isFinite(raw)) {
        throw new ApiCredentialError("invalid_grace_minutes", {
            provided: input,
            reason: "graceMinutes must be a finite number.",
        });
    }
    const floored = Math.floor(raw);
    if (floored < 1 || floored > MAX_ROTATION_GRACE_MINUTES) {
        throw new ApiCredentialError("invalid_grace_minutes", {
            provided: input,
            reason: `graceMinutes must be between 1 and ${MAX_ROTATION_GRACE_MINUTES}.`,
        });
    }
    return floored;
}
export async function rotateApiCredential(input, client = defaultPrisma) {
    if (integrationsFeatureDisabledReason()) {
        throw new ApiCredentialError("feature_disabled");
    }
    const graceMinutes = clampGraceMinutes(input.graceMinutes);
    const existing = await client.apiCredential.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new ApiCredentialError("credential_not_found");
    if (existing.status === "REVOKED") {
        throw new ApiCredentialError("credential_already_revoked");
    }
    // Disabled (soft-paused) credentials should not rotate — enable them
    // first. Distinguishing this case from "revoked" gives the operator a
    // clearer error.
    if (existing.disabledAtUtc !== null) {
        throw new ApiCredentialError("credential_not_active", {
            reason: "Credential is disabled; enable it before rotating.",
        });
    }
    const issued = issueApiKey();
    if (!issued)
        throw new ApiCredentialError("secret_missing");
    const previousValidUntilUtc = new Date(Date.now() + graceMinutes * 60 * 1000);
    const credential = await client.apiCredential.update({
        where: { id: existing.id },
        data: {
            keyPrefix: issued.keyPrefix,
            keyHash: issued.keyHash,
            previousKeyHash: existing.keyHash,
            previousKeyPrefix: existing.keyPrefix,
            previousValidUntilUtc,
            // Rotation just happened — clear the operator hint so the caller
            // doesn't see "rotation required" on the freshly rotated key.
            rotationRequired: false,
        },
    });
    return {
        credential,
        rawKey: issued.rawKey,
        previousKeyPrefix: existing.keyPrefix,
        previousValidUntilUtc,
    };
}
export async function disableApiCredential(input, client = defaultPrisma) {
    const existing = await client.apiCredential.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new ApiCredentialError("credential_not_found");
    if (existing.status === "REVOKED")
        throw new ApiCredentialError("credential_already_revoked");
    return client.apiCredential.update({
        where: { id: existing.id },
        data: {
            disabledAtUtc: new Date(),
            disabledByUserId: input.actorUserId,
        },
    });
}
export async function enableApiCredential(input, client = defaultPrisma) {
    const existing = await client.apiCredential.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new ApiCredentialError("credential_not_found");
    if (existing.status === "REVOKED")
        throw new ApiCredentialError("credential_already_revoked");
    return client.apiCredential.update({
        where: { id: existing.id },
        data: {
            disabledAtUtc: null,
            disabledByUserId: null,
        },
    });
}
export async function updateApiCredentialHardening(input, client = defaultPrisma) {
    const existing = await client.apiCredential.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing)
        throw new ApiCredentialError("credential_not_found");
    if (existing.status === "REVOKED")
        throw new ApiCredentialError("credential_already_revoked");
    const data = {};
    if (Object.prototype.hasOwnProperty.call(input, "expiresAtUtc")) {
        data.expiresAtUtc = input.expiresAtUtc ?? null;
    }
    if (input.ipAllowlist !== undefined) {
        // Bound each entry to avoid pathological CIDR strings.
        data.ipAllowlist = input.ipAllowlist
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 64);
    }
    if (Object.prototype.hasOwnProperty.call(input, "environment")) {
        const env = input.environment;
        data.environment = env ? env.slice(0, 32) : null;
    }
    if (input.rotationRequired !== undefined) {
        data.rotationRequired = input.rotationRequired;
    }
    return client.apiCredential.update({
        where: { id: existing.id },
        data,
    });
}
/**
 * Phase 10 (back-compat) — boolean-style verify. Returns the credential
 * if and only if the key is valid AND has not been revoked/disabled/expired.
 * New code should call `verifyApiKeyDetailed` so the middleware can
 * produce a precise audit reason on failure.
 */
export async function verifyApiKey(rawKey, client = defaultPrisma) {
    const detailed = await verifyApiKeyDetailed(rawKey, client);
    return detailed.ok ? detailed.credential : null;
}
export async function verifyApiKeyDetailed(rawKey, client = defaultPrisma) {
    const hash = hashIncomingApiKey(rawKey);
    if (!hash)
        return { ok: false, reason: "missing_or_malformed" };
    // Phase 2 — true dual-active verification. We first look up by the
    // current `keyHash`. If no row matches, we fall back to looking up
    // by `previousKeyHash` and accept the credential ONLY if the previous
    // grace window has not yet expired. This keeps the happy-path query
    // identical to before (one unique-index lookup) and only pays for the
    // second lookup when a stale key is in flight.
    let row = await client.apiCredential.findUnique({
        where: { keyHash: hash },
    });
    let matchedPrevious = false;
    if (!row) {
        const prev = await client.apiCredential.findFirst({
            where: { previousKeyHash: hash },
        });
        if (!prev)
            return { ok: false, reason: "not_found" };
        // Previous-key window expired: lazily clear the columns and reject.
        // Cleanup runs best-effort; a failure here does NOT promote the
        // rejection into a success.
        if (prev.previousValidUntilUtc === null ||
            prev.previousValidUntilUtc.getTime() <= Date.now()) {
            client.apiCredential
                .update({
                where: { id: prev.id },
                data: {
                    previousKeyHash: null,
                    previousKeyPrefix: null,
                    previousValidUntilUtc: null,
                },
            })
                .catch(() => null);
            return { ok: false, reason: "expired" };
        }
        row = prev;
        matchedPrevious = true;
    }
    if (row.status !== "ACTIVE")
        return { ok: false, reason: "revoked" };
    if (row.disabledAtUtc !== null)
        return { ok: false, reason: "disabled" };
    if (row.expiresAtUtc !== null &&
        row.expiresAtUtc.getTime() <= Date.now()) {
        return { ok: false, reason: "expired" };
    }
    // Constant-time hash check against whichever column actually matched.
    const storedHash = matchedPrevious
        ? row.previousKeyHash ?? ""
        : row.keyHash;
    if (!constantTimeEqualHex(storedHash, hash)) {
        return { ok: false, reason: "hash_mismatch" };
    }
    // Update lastUsed asynchronously; failure doesn't block the auth path.
    client.apiCredential
        .update({
        where: { id: row.id },
        data: { lastUsedAtUtc: new Date() },
    })
        .catch(() => null);
    return {
        ok: true,
        credential: {
            credentialId: row.id,
            teamId: row.teamId,
            scopes: row.scopes,
            ipAllowlist: row.ipAllowlist,
            // Phase 2 — if the caller authenticated with the PREVIOUS key, force
            // `rotationRequired=true` regardless of the stored value so middleware
            // surfaces the `x-proovra-rotation-required` header. This nudges the
            // integration to swap to the new key before the grace window ends.
            rotationRequired: matchedPrevious ? true : row.rotationRequired,
            environment: row.environment,
            expiresAtUtc: row.expiresAtUtc,
        },
    };
}
// -----------------------------------------------------------------------------
// Safe projection — never returns raw key or hash
// -----------------------------------------------------------------------------
export function projectApiCredential(c) {
    return {
        id: c.id,
        teamId: c.teamId,
        name: c.name,
        description: c.description,
        keyPrefix: c.keyPrefix,
        scopes: c.scopes,
        status: c.status,
        createdByUserId: c.createdByUserId,
        lastUsedAtUtc: c.lastUsedAtUtc?.toISOString() ?? null,
        revokedAtUtc: c.revokedAtUtc?.toISOString() ?? null,
        revokedByUserId: c.revokedByUserId,
        revokedReason: c.revokedReason,
        expiresAtUtc: c.expiresAtUtc?.toISOString() ?? null,
        disabledAtUtc: c.disabledAtUtc?.toISOString() ?? null,
        disabledByUserId: c.disabledByUserId,
        rotationRequired: c.rotationRequired,
        ipAllowlist: c.ipAllowlist,
        environment: c.environment,
        previousKeyPrefix: c.previousKeyPrefix ?? null,
        previousValidUntilUtc: c.previousValidUntilUtc?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        // Deliberately NOT returned: keyHash, previousKeyHash.
    };
}
void Prisma; // keep prisma import live for future use
