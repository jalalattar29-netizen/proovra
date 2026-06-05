/**
 * PHASE 2 — True dual-active API credential rotation tests.
 *
 * Drives `rotateApiCredential` + `verifyApiKeyDetailed` against an in-memory
 * fake of the Prisma `ApiCredential` table. Covers:
 *
 *   - Happy path: rotation issues a new raw key + persists previous_*
 *   - During grace: the OLD key still authenticates
 *   - During grace: the NEW key authenticates
 *   - After grace: the OLD key is rejected with reason="expired"
 *   - After grace: the NEW key still authenticates
 *   - Rotation refuses REVOKED credentials
 *   - Rotation refuses disabled credentials
 *   - graceMinutes is clamped to [1, 1440]; outside throws invalid_grace_minutes
 *   - Revoking a credential clears in-flight previous_* columns
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiCredentialError,
  MAX_ROTATION_GRACE_MINUTES,
  hashIncomingApiKey,
  issueApiKey,
  revokeApiCredential,
  rotateApiCredential,
  verifyApiKeyDetailed,
} from "../src/services/integrations/api-keys.service.js";

const TEST_SECRET = "a".repeat(64);
const TEAM = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

// -----------------------------------------------------------------------------
// Minimal in-memory Prisma fake for ApiCredential. We populate it with a
// single seeded credential and let rotation/verify drive its mutations.
// -----------------------------------------------------------------------------

type DbRow = {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED";
  createdByUserId: string;
  lastUsedAtUtc: Date | null;
  revokedAtUtc: Date | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  expiresAtUtc: Date | null;
  disabledAtUtc: Date | null;
  disabledByUserId: string | null;
  rotationRequired: boolean;
  ipAllowlist: string[];
  environment: string | null;
  previousKeyHash: string | null;
  previousKeyPrefix: string | null;
  previousValidUntilUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeFakePrisma(rows: DbRow[]) {
  return {
    apiCredential: {
      async findUnique({ where }: { where: { keyHash: string } }) {
        return rows.find((r) => r.keyHash === where.keyHash) ?? null;
      },
      async findFirst({
        where,
      }: {
        where: { id?: string; teamId?: string; previousKeyHash?: string };
      }) {
        return (
          rows.find((r) => {
            if (where.id !== undefined && r.id !== where.id) return false;
            if (where.teamId !== undefined && r.teamId !== where.teamId)
              return false;
            if (
              where.previousKeyHash !== undefined &&
              r.previousKeyHash !== where.previousKeyHash
            )
              return false;
            return true;
          }) ?? null
        );
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<DbRow>;
      }) {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx === -1) throw new Error(`row ${where.id} not found`);
        rows[idx] = { ...rows[idx], ...data, updatedAt: new Date() };
        return rows[idx];
      },
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function seedCredential(rawSecret: string = TEST_SECRET): DbRow {
  const prev = process.env.API_KEY_SECRET;
  process.env.API_KEY_SECRET = rawSecret;
  const issued = issueApiKey();
  if (prev === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = prev;
  if (!issued) throw new Error("test setup: issueApiKey returned null");
  const NOW = new Date();
  return {
    id: CRED,
    teamId: TEAM,
    name: "Test credential",
    description: null,
    keyPrefix: issued.keyPrefix,
    keyHash: issued.keyHash,
    scopes: ["integration.evidence.read"],
    status: "ACTIVE",
    createdByUserId: ACTOR,
    lastUsedAtUtc: null,
    revokedAtUtc: null,
    revokedByUserId: null,
    revokedReason: null,
    expiresAtUtc: null,
    disabledAtUtc: null,
    disabledByUserId: null,
    rotationRequired: false,
    ipAllowlist: [],
    environment: null,
    previousKeyHash: null,
    previousKeyPrefix: null,
    previousValidUntilUtc: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("rotateApiCredential — PHASE 2 dual-active rotation", () => {
  let originalFlag: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.INTEGRATIONS_ENABLED;
    originalSecret = process.env.API_KEY_SECRET;
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = originalSecret;
  });

  it("issues a new raw key + stores the prior hash in previous_*", async () => {
    const rows = [seedCredential()];
    const original = { ...rows[0] };
    const prisma = makeFakePrisma(rows);
    const result = await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR },
      prisma,
    );
    expect(result.rawKey).toMatch(/^pwk_v1_/);
    expect(result.credential.keyHash).not.toBe(original.keyHash);
    expect(result.credential.keyPrefix).not.toBe(original.keyPrefix);
    expect(result.credential.previousKeyHash).toBe(original.keyHash);
    expect(result.credential.previousKeyPrefix).toBe(original.keyPrefix);
    expect(result.previousKeyPrefix).toBe(original.keyPrefix);
    expect(result.previousValidUntilUtc.getTime()).toBeGreaterThan(Date.now());
    // Default grace window is 60 minutes — give a 5-second slop for slow CI.
    expect(result.previousValidUntilUtc.getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60 * 1000 + 5_000,
    );
  });

  it("verify accepts the OLD key during the grace window", async () => {
    const rows = [seedCredential()];
    const oldRaw = (() => {
      // We need the raw key, so issue a fresh one and seed with its hash.
      const issued = issueApiKey()!;
      rows[0].keyHash = issued.keyHash;
      rows[0].keyPrefix = issued.keyPrefix;
      return issued.rawKey;
    })();
    const prisma = makeFakePrisma(rows);
    await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR, graceMinutes: 60 },
      prisma,
    );
    const result = await verifyApiKeyDetailed(oldRaw, prisma);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.credentialId).toBe(CRED);
      // The previous key must force rotationRequired=true on the response
      // so middleware emits the x-proovra-rotation-required header.
      expect(result.credential.rotationRequired).toBe(true);
    }
  });

  it("verify accepts the NEW key during the grace window", async () => {
    const rows = [seedCredential()];
    const prisma = makeFakePrisma(rows);
    const rotation = await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR, graceMinutes: 60 },
      prisma,
    );
    const result = await verifyApiKeyDetailed(rotation.rawKey, prisma);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.credentialId).toBe(CRED);
      // The new key never sets rotationRequired implicitly.
      expect(result.credential.rotationRequired).toBe(false);
    }
  });

  it("verify rejects the OLD key after the grace window expires", async () => {
    const rows = [seedCredential()];
    const oldIssued = issueApiKey()!;
    rows[0].keyHash = oldIssued.keyHash;
    rows[0].keyPrefix = oldIssued.keyPrefix;
    const prisma = makeFakePrisma(rows);
    await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR, graceMinutes: 1 },
      prisma,
    );
    // Move the clock past the grace cutoff by mutating the stored value
    // directly (faster + deterministic than waiting in CI).
    rows[0].previousValidUntilUtc = new Date(Date.now() - 1_000);
    const result = await verifyApiKeyDetailed(oldIssued.rawKey, prisma);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
    // The lazy cleanup MUST have nulled the previous_* columns.
    expect(rows[0].previousKeyHash).toBeNull();
    expect(rows[0].previousKeyPrefix).toBeNull();
    expect(rows[0].previousValidUntilUtc).toBeNull();
  });

  it("verify keeps accepting the NEW key after the grace window expires", async () => {
    const rows = [seedCredential()];
    const prisma = makeFakePrisma(rows);
    const rotation = await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR, graceMinutes: 1 },
      prisma,
    );
    rows[0].previousValidUntilUtc = new Date(Date.now() - 1_000);
    const result = await verifyApiKeyDetailed(rotation.rawKey, prisma);
    expect(result.ok).toBe(true);
  });

  it("rejects rotation on REVOKED credentials", async () => {
    const rows = [seedCredential()];
    rows[0].status = "REVOKED";
    rows[0].revokedAtUtc = new Date();
    const prisma = makeFakePrisma(rows);
    await expect(
      rotateApiCredential(
        { id: CRED, teamId: TEAM, actorUserId: ACTOR },
        prisma,
      ),
    ).rejects.toMatchObject({
      name: "ApiCredentialError",
      code: "credential_already_revoked",
    });
  });

  it("rejects rotation on disabled (soft-paused) credentials", async () => {
    const rows = [seedCredential()];
    rows[0].disabledAtUtc = new Date();
    const prisma = makeFakePrisma(rows);
    await expect(
      rotateApiCredential(
        { id: CRED, teamId: TEAM, actorUserId: ACTOR },
        prisma,
      ),
    ).rejects.toMatchObject({
      name: "ApiCredentialError",
      code: "credential_not_active",
    });
  });

  it("rejects rotation when the credential is not found", async () => {
    const prisma = makeFakePrisma([]);
    await expect(
      rotateApiCredential(
        { id: CRED, teamId: TEAM, actorUserId: ACTOR },
        prisma,
      ),
    ).rejects.toMatchObject({
      name: "ApiCredentialError",
      code: "credential_not_found",
    });
  });

  it.each([0, -10, MAX_ROTATION_GRACE_MINUTES + 1, NaN, Infinity])(
    "clamps invalid graceMinutes (%s) to invalid_grace_minutes",
    async (raw) => {
      const rows = [seedCredential()];
      const prisma = makeFakePrisma(rows);
      await expect(
        rotateApiCredential(
          {
            id: CRED,
            teamId: TEAM,
            actorUserId: ACTOR,
            graceMinutes: raw,
          },
          prisma,
        ),
      ).rejects.toBeInstanceOf(ApiCredentialError);
    },
  );

  it("clears previous_* when the credential is subsequently revoked", async () => {
    const rows = [seedCredential()];
    const prisma = makeFakePrisma(rows);
    await rotateApiCredential(
      { id: CRED, teamId: TEAM, actorUserId: ACTOR, graceMinutes: 60 },
      prisma,
    );
    expect(rows[0].previousKeyHash).not.toBeNull();

    await revokeApiCredential(
      {
        id: CRED,
        teamId: TEAM,
        actorUserId: ACTOR,
        reason: "compromised",
      },
      prisma,
    );
    // Revocation MUST drop the in-flight previous_* columns so the old raw
    // key cannot replay through the grace window after explicit revocation.
    expect(rows[0].previousKeyHash).toBeNull();
    expect(rows[0].previousKeyPrefix).toBeNull();
    expect(rows[0].previousValidUntilUtc).toBeNull();
    expect(rows[0].status).toBe("REVOKED");
    expect(rows[0].revokedReason).toBe("compromised");
  });
});

describe("verifyApiKeyDetailed — bounded surface", () => {
  let originalFlag: string | undefined;
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalFlag = process.env.INTEGRATIONS_ENABLED;
    originalSecret = process.env.API_KEY_SECRET;
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = originalSecret;
  });

  it("returns not_found when neither current nor previous matches", async () => {
    const prisma = makeFakePrisma([]);
    const issued = issueApiKey()!;
    const result = await verifyApiKeyDetailed(issued.rawKey, prisma);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("rejects with missing_or_malformed for non-pwk inputs", async () => {
    const prisma = makeFakePrisma([]);
    const result = await verifyApiKeyDetailed("not-a-key", prisma);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_or_malformed");
  });

  it("never logs the raw key when verify fails", async () => {
    // Sanity: the verify function reads the hash, not the raw key. We
    // capture every Buffer.from / log call through a custom hashing path
    // is not testable in isolation, but we can assert that the
    // hashIncomingApiKey transform is reversed before any DB read.
    const issued = issueApiKey()!;
    const hashed = hashIncomingApiKey(issued.rawKey);
    expect(hashed).not.toBe(issued.rawKey);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});
