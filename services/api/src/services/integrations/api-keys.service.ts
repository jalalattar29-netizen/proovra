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
import type {
  PrismaClient,
  ApiCredential as DbApiCredential,
} from "@prisma/client";
import {
  API_KEY_RANDOM_BYTES,
  PERMISSIONS,
  Permission,
  deriveApiKeyDisplayPrefix,
  formatApiKeyValue,
  parseApiKeyShape,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

const INTEGRATIONS_FLAG = "INTEGRATIONS_ENABLED";
const API_KEY_SECRET_ENV = "API_KEY_SECRET";

export function isIntegrationsFeatureEnabled(): boolean {
  return process.env[INTEGRATIONS_FLAG] === "true";
}

function readApiKeySecret(): Buffer | null {
  const raw = process.env[API_KEY_SECRET_ENV];
  if (!raw || raw.trim().length < 32) return null;
  if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, "hex");
  }
  return Buffer.from(raw, "utf8");
}

export type IntegrationsFeatureDisabledReason =
  | "feature_flag_off"
  | "secret_missing";

export function integrationsFeatureDisabledReason():
  | IntegrationsFeatureDisabledReason
  | null {
  if (process.env[INTEGRATIONS_FLAG] !== "true") return "feature_flag_off";
  if (readApiKeySecret() === null) return "secret_missing";
  return null;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function hmacHex(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

// -----------------------------------------------------------------------------
// Issue / hash
// -----------------------------------------------------------------------------

export type IssuedApiKey = {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
};

export function issueApiKey(): IssuedApiKey | null {
  const secret = readApiKeySecret();
  if (!secret) return null;
  const body = base64url(randomBytes(API_KEY_RANDOM_BYTES));
  const rawKey = formatApiKeyValue(body);
  const keyHash = hmacHex(secret, rawKey);
  const keyPrefix = deriveApiKeyDisplayPrefix(rawKey);
  return { rawKey, keyHash, keyPrefix };
}

export function hashIncomingApiKey(rawKey: string): string | null {
  const shape = parseApiKeyShape(rawKey);
  if (!shape) return null;
  const secret = readApiKeySecret();
  if (!secret) return null;
  return hmacHex(secret, rawKey);
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length !== 64) return false;
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// -----------------------------------------------------------------------------
// Scope validation
// -----------------------------------------------------------------------------

const PERMISSION_SET = new Set<Permission>(PERMISSIONS);

export function isValidScope(scope: string): scope is Permission {
  return PERMISSION_SET.has(scope as Permission);
}

export function filterValidScopes(scopes: string[]): Permission[] {
  return scopes.filter(isValidScope);
}

export function scopesGrantPermission(
  scopes: ReadonlyArray<string>,
  permission: Permission,
): boolean {
  return scopes.includes(permission);
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export type CreateApiCredentialInput = {
  teamId: string;
  name: string;
  description?: string | null;
  scopes: string[];
  actorUserId: string;
};

export type CreateApiCredentialResult = {
  credential: DbApiCredential;
  rawKey: string;
};

export class ApiCredentialError extends Error {
  constructor(
    public readonly code:
      | "feature_disabled"
      | "secret_missing"
      | "invalid_scopes"
      | "credential_not_found"
      | "credential_already_revoked",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ApiCredentialError";
  }
}

export async function createApiCredential(
  input: CreateApiCredentialInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateApiCredentialResult> {
  if (integrationsFeatureDisabledReason()) {
    throw new ApiCredentialError("feature_disabled");
  }
  const validScopes = filterValidScopes(input.scopes);
  if (validScopes.length === 0) {
    throw new ApiCredentialError("invalid_scopes", {
      provided: input.scopes,
      reason:
        "At least one valid scope is required. Scope identifiers must match the canonical permission catalog.",
    });
  }

  const issued = issueApiKey();
  if (!issued) throw new ApiCredentialError("secret_missing");

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

export async function listApiCredentials(
  input: { teamId: string; status?: "ACTIVE" | "REVOKED"; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<DbApiCredential[]> {
  return client.apiCredential.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

export async function revokeApiCredential(
  input: {
    id: string;
    teamId: string;
    actorUserId: string;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbApiCredential> {
  const existing = await client.apiCredential.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) throw new ApiCredentialError("credential_not_found");
  if (existing.status === "REVOKED") return existing;

  return client.apiCredential.update({
    where: { id: existing.id },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason?.slice(0, 400) ?? null,
    },
  });
}

// -----------------------------------------------------------------------------
// Phase 17 — service-account hardening operations.
//
// Distinct from revoke: a disabled credential can be re-enabled (soft
// pause), whereas REVOKED is terminal. Expiry, IP allowlist, rotation
// flag, and environment label are operator-managed and exposed in the
// /identity surface.
// -----------------------------------------------------------------------------

export type DisableApiCredentialInput = {
  id: string;
  teamId: string;
  actorUserId: string;
};

export async function disableApiCredential(
  input: DisableApiCredentialInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbApiCredential> {
  const existing = await client.apiCredential.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) throw new ApiCredentialError("credential_not_found");
  if (existing.status === "REVOKED") throw new ApiCredentialError("credential_already_revoked");
  return client.apiCredential.update({
    where: { id: existing.id },
    data: {
      disabledAtUtc: new Date(),
      disabledByUserId: input.actorUserId,
    },
  });
}

export async function enableApiCredential(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbApiCredential> {
  const existing = await client.apiCredential.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) throw new ApiCredentialError("credential_not_found");
  if (existing.status === "REVOKED") throw new ApiCredentialError("credential_already_revoked");
  return client.apiCredential.update({
    where: { id: existing.id },
    data: {
      disabledAtUtc: null,
      disabledByUserId: null,
    },
  });
}

export type UpdateApiCredentialHardeningInput = {
  id: string;
  teamId: string;
  // Pass null to clear; undefined to leave unchanged.
  expiresAtUtc?: Date | null;
  ipAllowlist?: ReadonlyArray<string>;
  environment?: string | null;
  rotationRequired?: boolean;
};

export async function updateApiCredentialHardening(
  input: UpdateApiCredentialHardeningInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbApiCredential> {
  const existing = await client.apiCredential.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) throw new ApiCredentialError("credential_not_found");
  if (existing.status === "REVOKED") throw new ApiCredentialError("credential_already_revoked");
  const data: Prisma.ApiCredentialUpdateInput = {};
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

// -----------------------------------------------------------------------------
// Verification — used by middleware
// -----------------------------------------------------------------------------

export type VerifiedApiCredential = {
  credentialId: string;
  teamId: string;
  scopes: string[];
  // Phase 17 — service-account hardening signals exposed to middleware
  // so it can apply CIDR/IP gating and surface rotation-required to
  // operators without re-querying.
  ipAllowlist: ReadonlyArray<string>;
  rotationRequired: boolean;
  environment: string | null;
  expiresAtUtc: Date | null;
};

export type VerifyApiKeyFailureReason =
  | "missing_or_malformed"
  | "not_found"
  | "revoked"
  | "disabled"
  | "expired"
  | "hash_mismatch";

export type VerifyApiKeyResult =
  | { ok: true; credential: VerifiedApiCredential }
  | { ok: false; reason: VerifyApiKeyFailureReason };

/**
 * Phase 10 (back-compat) — boolean-style verify. Returns the credential
 * if and only if the key is valid AND has not been revoked/disabled/expired.
 * New code should call `verifyApiKeyDetailed` so the middleware can
 * produce a precise audit reason on failure.
 */
export async function verifyApiKey(
  rawKey: string,
  client: PrismaClient = defaultPrisma,
): Promise<VerifiedApiCredential | null> {
  const detailed = await verifyApiKeyDetailed(rawKey, client);
  return detailed.ok ? detailed.credential : null;
}

export async function verifyApiKeyDetailed(
  rawKey: string,
  client: PrismaClient = defaultPrisma,
): Promise<VerifyApiKeyResult> {
  const hash = hashIncomingApiKey(rawKey);
  if (!hash) return { ok: false, reason: "missing_or_malformed" };
  const row = await client.apiCredential.findUnique({
    where: { keyHash: hash },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "ACTIVE") return { ok: false, reason: "revoked" };
  if (row.disabledAtUtc !== null) return { ok: false, reason: "disabled" };
  if (
    row.expiresAtUtc !== null &&
    row.expiresAtUtc.getTime() <= Date.now()
  ) {
    return { ok: false, reason: "expired" };
  }
  if (!constantTimeEqualHex(row.keyHash, hash)) {
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
      rotationRequired: row.rotationRequired,
      environment: row.environment,
      expiresAtUtc: row.expiresAtUtc,
    },
  };
}

// -----------------------------------------------------------------------------
// Safe projection — never returns raw key or hash
// -----------------------------------------------------------------------------

export function projectApiCredential(c: DbApiCredential): {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdByUserId: string;
  lastUsedAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  // Phase 17 — hardening surface (safe to project; never includes the
  // raw key or hash).
  expiresAtUtc: string | null;
  disabledAtUtc: string | null;
  disabledByUserId: string | null;
  rotationRequired: boolean;
  ipAllowlist: string[];
  environment: string | null;
  createdAt: string;
  updatedAt: string;
} {
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
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // Deliberately NOT returned: keyHash.
  };
}

void Prisma; // keep prisma import live for future use
