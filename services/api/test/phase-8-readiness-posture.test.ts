/**
 * Phase 8 — Enterprise Production Readiness posture closure suite
 * (SCOPE F / I / J).
 *
 *   1. Posture computation honesty: object-lock fields reflect real
 *      env-derived config; databaseBackup is an honest label (never a
 *      fabricated "configured"/"backed up"); knownLimitations carries
 *      the real caveats; NO secrets/key material leak.
 *   2. Route is platform-admin gated (requirePlatformAdmin) and emits a
 *      platform audit event on access.
 *   3. Docs presence + honesty: the 4 runbook docs exist and contain
 *      the honest disclaimers with NO positive SOC2 / uptime /
 *      penetration-tested claims.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

// The posture service delegates to getObjectLockStatus / runReadinessCheck /
// runSchemaValidation. Those touch S3 + the DB. We mock them so the honesty
// assertions run without infrastructure. The env-derived fields
// (objectLock*, signer, databaseBackup) are computed purely from
// process.env and are the focus of these tests.
vi.mock("../src/services/operations/object-lock-status.service.js", () => ({
  getObjectLockStatus: vi.fn(async () => ({
    mode: "disabled" as const,
    checkedAtUtc: new Date().toISOString(),
  })),
}));
vi.mock("../src/runtime/runtime-readiness.js", () => ({
  runReadinessCheck: vi.fn(async () => ({
    status: "HEALTHY" as const,
    ranAtUtc: new Date().toISOString(),
    durationMs: 1,
    requestId: null,
    subsystems: [
      { id: "database", status: "HEALTHY" },
      { id: "redis", status: "DEGRADED" },
    ],
  })),
}));
vi.mock("../src/runtime/schema-validation.js", () => ({
  runSchemaValidation: vi.fn(async () => ({
    status: "healthy" as const,
    ranAtUtc: new Date().toISOString(),
    durationMs: 1,
    checked: 42,
    driftFingerprint: "none",
    failures: [],
    subsystems: [],
  })),
}));

import {
  computeReadinessPosture,
  KNOWN_LIMITATIONS,
} from "../src/services/operations/readiness-posture.service.js";

const ENV_KEYS = [
  "S3_OBJECT_LOCK_ENABLED",
  "S3_OBJECT_LOCK_MODE",
  "S3_OBJECT_LOCK_RETAIN_DAYS",
  "SIGNER_PROVIDER",
  "SIGNING_KEY_VERSION",
  "DATABASE_URL",
  "DATABASE_BACKUP_PROVIDER",
  "DATABASE_BACKUP_POLICY_URL",
  "DATABASE_BACKUP_LAST_VERIFIED_AT",
  "DATABASE_RESTORE_TESTED_AT",
  "REDIS_URL",
  "NODE_ENV",
] as const;

describe("Phase 8 — posture computation honesty", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
  });

  it("objectLock fields reflect env-derived config (enabled)", async () => {
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
    process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "3650";
    process.env.DATABASE_URL = "postgres://x";
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.objectLockEnabled).toBe(true);
    expect(p.backup.objectLockMode).toBe("COMPLIANCE");
    expect(p.backup.objectLockRetainDays).toBe(3650);
  });

  it("objectLock fields reflect env-derived config (disabled)", async () => {
    delete process.env.S3_OBJECT_LOCK_ENABLED;
    delete process.env.S3_OBJECT_LOCK_MODE;
    delete process.env.S3_OBJECT_LOCK_RETAIN_DAYS;
    process.env.DATABASE_URL = "postgres://x";
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.objectLockEnabled).toBe(false);
    expect(p.backup.objectLockMode).toBeNull();
    expect(p.backup.objectLockRetainDays).toBeNull();
  });

  it("databaseBackup is an HONEST label — never a fabricated positive", async () => {
    process.env.DATABASE_URL = "postgres://x";
    const p = await computeReadinessPosture({} as never);
    // Only two honest values allowed. Neither is a fake "configured"/"backed up".
    expect(["managed_platform_assumed", "not_configured"]).toContain(
      p.backup.databaseBackup,
    );
    expect(p.backup.databaseBackup).toBe("managed_platform_assumed");
    // The label vocabulary must not contain fabricated positives.
    expect(p.backup.databaseBackup).not.toBe("configured");
    expect(p.backup.databaseBackup).not.toBe("backed_up");
    expect(p.backup.databaseBackupReason.toLowerCase()).toContain("assum");
  });

  it("databaseBackup honestly reports not_configured when no DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.databaseBackup).toBe("not_configured");
  });

  // ---- ITEM 1: DB backup verification metadata (honest launch gate) ----
  it("no backup env → launch action required, no fake verified/healthy", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.DATABASE_BACKUP_PROVIDER;
    delete process.env.DATABASE_BACKUP_POLICY_URL;
    delete process.env.DATABASE_BACKUP_LAST_VERIFIED_AT;
    delete process.env.DATABASE_RESTORE_TESTED_AT;
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.databaseBackupProvider).toBeNull();
    expect(p.backup.databaseBackupPolicyUrl).toBeNull();
    expect(p.backup.databaseBackupLastVerifiedAtUtc).toBeNull();
    expect(p.backup.databaseRestoreTestedAtUtc).toBeNull();
    // The honest gate must be ON (never silently green).
    expect(p.backup.databaseBackupLaunchActionRequired).toBe(true);
  });

  it("declared provider/policy render without exposing secrets", async () => {
    process.env.DATABASE_URL = "postgres://secret:pass@host/db";
    process.env.DATABASE_BACKUP_PROVIDER = "Neon PITR";
    process.env.DATABASE_BACKUP_POLICY_URL = "https://runbooks.example/db-backup";
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.databaseBackupProvider).toBe("Neon PITR");
    expect(p.backup.databaseBackupPolicyUrl).toBe(
      "https://runbooks.example/db-backup",
    );
    // No secret / connection string leaks into the posture.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("secret:pass");
    expect(serialized).not.toContain(process.env.DATABASE_URL);
  });

  it("restore-tested + last-verified dates clear the launch gate", async () => {
    process.env.DATABASE_URL = "postgres://x";
    process.env.DATABASE_BACKUP_LAST_VERIFIED_AT = "2027-01-05T00:00:00.000Z";
    process.env.DATABASE_RESTORE_TESTED_AT = "2027-01-06T00:00:00.000Z";
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.databaseBackupLastVerifiedAtUtc).toBe(
      "2027-01-05T00:00:00.000Z",
    );
    expect(p.backup.databaseRestoreTestedAtUtc).toBe(
      "2027-01-06T00:00:00.000Z",
    );
    expect(p.backup.databaseBackupLaunchActionRequired).toBe(false);
  });

  it("invalid backup timestamps are treated as unknown (never fabricated)", async () => {
    process.env.DATABASE_URL = "postgres://x";
    process.env.DATABASE_BACKUP_LAST_VERIFIED_AT = "not-a-date";
    const p = await computeReadinessPosture({} as never);
    expect(p.backup.databaseBackupLastVerifiedAtUtc).toBeNull();
    expect(p.backup.databaseBackupLaunchActionRequired).toBe(true);
  });

  // ---- ITEM 2: multi-instance MFA throttle posture ----
  it("mfaThrottle reports shared (redis) + production-ready when REDIS_URL set", async () => {
    process.env.DATABASE_URL = "postgres://x";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.NODE_ENV = "production";
    const p = await computeReadinessPosture({} as never);
    expect(p.mfaThrottle.store).toBe("redis");
    expect(p.mfaThrottle.shared).toBe(true);
    expect(p.mfaThrottle.productionReady).toBe(true);
  });

  it("mfaThrottle reports NOT production-ready in production without a shared store", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "production";
    const p = await computeReadinessPosture({} as never);
    expect(p.mfaThrottle.store).toBe("memory");
    expect(p.mfaThrottle.shared).toBe(false);
    expect(p.mfaThrottle.productionReady).toBe(false);
    // reason must never fake a positive
    expect(p.mfaThrottle.reason.toLowerCase()).toContain("redis");
  });

  it("mfaThrottle memory fallback is acceptable in dev/test (single instance)", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "test";
    const p = await computeReadinessPosture({} as never);
    expect(p.mfaThrottle.shared).toBe(false);
    expect(p.mfaThrottle.productionReady).toBe(true);
  });

  it("signer provider + key version reflect env (no key material)", async () => {
    process.env.SIGNER_PROVIDER = "aws-kms";
    process.env.SIGNING_KEY_VERSION = "3";
    process.env.DATABASE_URL = "postgres://x";
    const p = await computeReadinessPosture({} as never);
    expect(p.keys.signerProvider).toBe("aws-kms");
    expect(p.keys.keyVersioned).toBe(true);
  });

  it("key version honestly reports not-versioned when unset", async () => {
    delete process.env.SIGNING_KEY_VERSION;
    process.env.DATABASE_URL = "postgres://x";
    const p = await computeReadinessPosture({} as never);
    expect(p.keys.keyVersioned).toBe(false);
    expect(p.keys.keyVersionUnknownReason).toBeTruthy();
  });

  it("knownLimitations includes the real caveats", async () => {
    const p = await computeReadinessPosture({} as never);
    const joined = p.knownLimitations.join(" ").toLowerCase();
    expect(joined).toContain("per-instance");
    expect(joined).toContain("automated database backup");
    expect(joined).toContain("managed");
    expect(p.knownLimitations).toEqual(KNOWN_LIMITATIONS);
    expect(p.knownLimitations.length).toBeGreaterThanOrEqual(3);
  });

  it("emits NO secrets / key material in the serialized posture", async () => {
    process.env.SIGNER_PROVIDER = "aws-kms";
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.KMS_KEY_ID = "arn:aws:kms:us-east-1:111:key/super-secret";
    process.env.AUTH_JWT_SECRET = "jwt-super-secret-value";
    process.env.DATABASE_URL = "postgres://user:pw@host/db";
    const p = await computeReadinessPosture({} as never);
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("jwt-super-secret-value");
    expect(serialized).not.toContain("arn:aws:kms");
    expect(serialized).not.toContain("pw@host");
    delete process.env.KMS_KEY_ID;
    delete process.env.AUTH_JWT_SECRET;
  });
});

describe("Phase 8 — route is platform-admin gated + audits access", () => {
  const src = readSource(
    "../src/routes/operations-readiness.routes.ts",
  );
  it("route file exists and defines GET /v1/operations/readiness", () => {
    expect(src).toContain('"/v1/operations/readiness"');
  });
  it("uses requirePlatformAdmin as the preHandler", () => {
    expect(src).toContain("requirePlatformAdmin");
    expect(src).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });
  it("emits a platform audit event on access", () => {
    expect(src).toContain("emitPlatformAudit");
    expect(src).toContain("operations.readiness.viewed");
  });
  it("does not self-register (leaves wiring to the owner)", () => {
    // The plugin only exports its registrar; it must not IMPORT server.ts
    // or the route registry (mentioning them in a comment is fine).
    expect(src).not.toMatch(/import[^\n]*server\.js/);
    expect(src).not.toMatch(/import[^\n]*routeRegistry/);
    // It exports exactly the registrar function for the owner to wire.
    expect(src).toContain("export async function operationsReadinessRoutes");
  });
});

describe("Phase 8 — runbook docs presence + honesty", () => {
  const DOCS = [
    "../../../docs/runbooks/disaster-recovery.md",
    "../../../docs/runbooks/sre-runbooks.md",
    "../../../docs/runbooks/pentest-readiness.md",
    "../../../docs/runbooks/security-review.md",
  ] as const;

  it("all 4 runbook docs exist", () => {
    for (const d of DOCS) {
      expect(exists(d), `${d} should exist`).toBe(true);
    }
  });

  it("docs contain NO fabricated positive certification/uptime/pentest claims", () => {
    // Banned POSITIVE claims. Honest disclaimers (e.g. "does NOT claim
    // the platform has passed a penetration test") are legitimate and
    // MUST NOT trip this guard — so we strip negated sentences first,
    // then look for a bare positive assertion.
    const bannedPositive = [
      /soc\s*2\s*(certified|compliant)/i,
      /iso\s*27001\s*(certified|compliant)/i,
      /99\.9%\s*uptime/i,
      /guaranteed\s*uptime/i,
      /is\s+penetration[- ]tested/i,
    ];
    for (const d of DOCS) {
      const text = readSource(d);
      // Remove any sentence/line that carries a negation so a
      // disclaimer never counts as a positive claim.
      const positiveOnly = text
        .split(/[\r\n]+/)
        .filter(
          (line) =>
            !/\bnot\b|\bdoes not\b|\bno\b|\bunless\b|\bwithout\b/i.test(line),
        )
        .join("\n");
      for (const pat of bannedPositive) {
        expect(
          pat.test(positiveOnly),
          `${d} must not make positive claim ${pat}`,
        ).toBe(false);
      }
    }
  });

  it("DR doc states RPO/RTO as targets/assumptions, not guarantees", () => {
    const dr = readSource("../../../docs/runbooks/disaster-recovery.md");
    expect(dr.toLowerCase()).toContain("not guarantees");
    expect(dr).toContain("managed_platform_assumed");
    expect(dr.toLowerCase()).toContain("not in repo");
  });

  it("security-review doc restates the no-certification disclaimer", () => {
    const sr = readSource("../../../docs/runbooks/security-review.md");
    expect(sr.toLowerCase()).toContain("separately");
    expect(sr.toLowerCase()).toContain("does not claim");
    expect(sr).toMatch(/SOC 2/);
  });

  it("pentest doc states allowed scope + exclusions + security contact", () => {
    const pt = readSource("../../../docs/runbooks/pentest-readiness.md");
    expect(pt).toContain("security@proovra.com");
    expect(pt.toLowerCase()).toContain("exclusion");
    expect(pt.toLowerCase()).toContain("non-production");
  });
});
