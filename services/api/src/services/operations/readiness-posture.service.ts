/**
 * Phase 8 — Enterprise Production Readiness posture rollup (SCOPE F / I / J).
 *
 * Computes a TRUTHFUL, operator-safe posture snapshot from real
 * platform configuration and existing operational services. This is
 * the read-model behind GET /v1/operations/readiness.
 *
 * HONESTY CONTRACT (enforced by phase-8-readiness-posture.test.ts):
 *   * Every field is derived from real env config or an existing
 *     service — never fabricated.
 *   * NO secrets, key material, bucket names, ARNs, or IAM details
 *     appear in the output. Only booleans, bounded modes, provider
 *     labels, day counts, and timestamps.
 *   * Backup posture NEVER claims "configured"/"backed up" as a
 *     positive when it cannot be proven. Database backup is a
 *     managed-platform assumption (there are NO repo-level pg_dump /
 *     automated backup scripts), so it is reported as
 *     "managed_platform_assumed" — an honest assumption label, not a
 *     guarantee.
 *   * We never assert SOC2 / ISO / uptime SLA / "penetration tested".
 *     Those words do not appear here.
 *   * When a value cannot be determined we return null + a reason.
 *
 * Config provenance (file:line proving each value is real):
 *   * objectLock* — process.env.S3_OBJECT_LOCK_{ENABLED,MODE,RETAIN_DAYS}
 *     mirroring services/api/src/storage.ts:174-189 (isObjectLockEnabled /
 *     readObjectLockDefaults) + services/worker/src/config.ts:51-61.
 *   * objectLockStatus — getObjectLockStatus() in
 *     services/api/src/services/operations/object-lock-status.service.ts
 *     (live bucket probe, operator-safe projection).
 *   * signerProvider / keyVersioned — process.env.SIGNER_PROVIDER +
 *     SIGNING_KEY_VERSION, mirroring
 *     services/api/src/config/index.ts:259-277 (signing provider
 *     consistency) + services/api/src/signing/signer.ts:59.
 *   * runtimeReadinessSummary — runReadinessCheck() in
 *     services/api/src/runtime/runtime-readiness.ts:1386.
 *   * schemaDriftSummary — runSchemaValidation() in
 *     services/api/src/runtime/schema-validation.ts:501.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  getObjectLockStatus,
  type ObjectLockStatus,
} from "./object-lock-status.service.js";
import {
  runReadinessCheck,
  type ReadinessStatus,
} from "../../runtime/runtime-readiness.js";
import { runSchemaValidation } from "../../runtime/schema-validation.js";

// -----------------------------------------------------------------------------
// Types — every field is operator-safe (no secrets).
// -----------------------------------------------------------------------------

/**
 * Database backup posture. Deliberately does NOT include a
 * "configured" / "backed_up" positive: the repo carries no automated
 * DB backup scripts, so we can only honestly report the
 * managed-platform assumption or that nothing is configured.
 */
export type DatabaseBackupPosture =
  | "managed_platform_assumed"
  | "not_configured";

export type BackupPosture = {
  objectLockEnabled: boolean;
  /** GOVERNANCE | COMPLIANCE | null (null when unset / disabled). */
  objectLockMode: "GOVERNANCE" | "COMPLIANCE" | null;
  /** Configured default retention in days, or null when unset. */
  objectLockRetainDays: number | null;
  /** Live bucket probe (operator-safe projection). */
  objectLockStatus: ObjectLockStatus;
  /**
   * Honest DB backup posture. See DatabaseBackupPosture — never a
   * fabricated positive.
   */
  databaseBackup: DatabaseBackupPosture;
  /** Reason string explaining the databaseBackup value. */
  databaseBackupReason: string;
  /**
   * Operator-declared managed-backup provider label (e.g. "Neon PITR",
   * "AWS RDS automated backups"). null when not declared. Read from
   * DATABASE_BACKUP_PROVIDER — a label only, never a URL/secret.
   */
  databaseBackupProvider: string | null;
  /** Link to the operator's backup policy/runbook (DATABASE_BACKUP_POLICY_URL). null when unset. */
  databaseBackupPolicyUrl: string | null;
  /** When the operator last VERIFIED backups exist (DATABASE_BACKUP_LAST_VERIFIED_AT, ISO). null = unknown. */
  databaseBackupLastVerifiedAtUtc: string | null;
  /** When a RESTORE was last successfully tested (DATABASE_RESTORE_TESTED_AT, ISO). null = not run. */
  databaseRestoreTestedAtUtc: string | null;
  /**
   * Honest launch gate: true when backups are NOT independently verified
   * (no last-verified timestamp) OR a restore has never been tested. This
   * is the "required launch action" signal — never suppressed to look green.
   */
  databaseBackupLaunchActionRequired: boolean;
  artifactRegeneration: {
    /**
     * Report / verification-package regeneration is available from
     * the existing worker pipeline (the artifacts are deterministic
     * and re-derivable from immutable evidence + manifest). This is a
     * real capability, not a backup.
     */
    reportRegenAvailable: true;
    note: string;
  };
};

export type KeyPosture = {
  /** Normalised provider label. NO key material / ARN. */
  signerProvider: "aws-kms" | "local-pem" | "disabled" | "unknown";
  /** True when SIGNING_KEY_VERSION is set to a usable value. */
  keyVersioned: boolean;
  /** null when it could not be determined + a reason. */
  keyVersionUnknownReason: string | null;
};

export type ResiliencyPosture = {
  runtimeReadinessSummary: {
    status: ReadinessStatus | "UNKNOWN";
    ranAtUtc: string;
    subsystemCount: number;
    degradedSubsystems: ReadonlyArray<string>;
    /** null + reason when the aggregator could not run. */
    unavailableReason: string | null;
  };
  schemaDriftSummary: {
    status: "healthy" | "degraded" | "critical" | "unknown";
    driftFingerprint: string | null;
    failureCount: number;
    checkedCount: number;
    unavailableReason: string | null;
  };
};

/**
 * Multi-instance MFA / login-throttle posture. The throttle now runs on
 * the shared rate limiter (services/api/src/services/rate-limit.ts), which
 * uses Redis when REDIS_URL is configured and an in-memory fallback
 * otherwise. Only the Redis-backed store is safe across multiple API
 * instances — so we report an honest "not production-ready" when running
 * in production WITHOUT a shared store.
 */
export type MfaThrottlePosture = {
  /** Which store the shared rate limiter will use. */
  store: "redis" | "memory";
  /** True when the throttle counter is shared across instances (Redis). */
  shared: boolean;
  /**
   * False when NODE_ENV=production but no shared store is configured —
   * i.e. a multi-instance deployment could multiply the attempt budget.
   */
  productionReady: boolean;
  /** Operator-safe explanation (no secrets, no connection strings). */
  reason: string;
};

export type ReadinessPosture = {
  generatedAtUtc: string;
  backup: BackupPosture;
  keys: KeyPosture;
  resiliency: ResiliencyPosture;
  /** Multi-instance MFA/login throttle posture. */
  mfaThrottle: MfaThrottlePosture;
  /** Truthful, honest caveats. Rendered verbatim in the UI + docs. */
  knownLimitations: ReadonlyArray<string>;
};

// -----------------------------------------------------------------------------
// Honest known-limitations. These are REAL flagged caveats, restated
// honestly. Keep in sync with the tests + runbook docs.
// -----------------------------------------------------------------------------

export const KNOWN_LIMITATIONS: ReadonlyArray<string> = [
  // MFA/login throttling now runs on the shared rate limiter
  // (services/api/src/services/rate-limit.ts). It is multi-instance-safe
  // when REDIS_URL is configured; without it the limiter falls back to a
  // per-instance in-memory store. See mfaThrottle for the live posture.
  "MFA/login attempt throttling runs on the shared rate limiter. It is multi-instance-safe only when a shared store (REDIS_URL) is configured; otherwise it falls back to a per-instance in-memory store. Configure Redis before running more than one API instance in production (see mfaThrottle.productionReady).",
  // Real posture limitation: no repo-level automated DB backup.
  "No repository-level automated database backup (no pg_dump / snapshot scripts in the repo). Point-in-time recovery relies on the managed database platform's backup facility, which must be configured and verified out-of-band by the operator.",
  // Real posture limitation: full DR rehearsal / cross-region failover
  // is not exercised by the application layer.
  "Full disaster-recovery rehearsals and cross-region failover are infrastructure-layer concerns exercised through the hosting provider's tooling — the application layer validates only what it can prove (Object Lock configuration, artifact regeneration, schema/runtime readiness).",
  // Real posture limitation: no third-party certification is asserted.
  "No third-party certification (SOC 2, ISO 27001) or penetration-test pass is asserted by this platform unless a specific attestation has been separately obtained and verified; this surface reports configuration posture only.",
];

// -----------------------------------------------------------------------------
// Helpers — mirror the canonical env readers so posture matches runtime.
// -----------------------------------------------------------------------------

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Read an env var expected to hold an ISO-8601 timestamp. Returns the
 * normalised ISO string when valid, else null (honest "unknown"). Never
 * throws; never fabricates a date.
 */
function readIsoEnv(name: string): string | null {
  const raw = clean(process.env[name]);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Read a plain env label (provider name / policy URL). null when unset. Never a secret. */
function readLabelEnv(name: string): string | null {
  const raw = clean(process.env[name]);
  return raw.length > 0 ? raw : null;
}

/** Mirrors services/api/src/storage.ts:174 isObjectLockEnabled(). */
function readObjectLockEnabled(): boolean {
  return clean(process.env.S3_OBJECT_LOCK_ENABLED).toLowerCase() === "true";
}

/** Mirrors services/api/src/storage.ts:187 (S3_OBJECT_LOCK_MODE). */
function readObjectLockMode(): "GOVERNANCE" | "COMPLIANCE" | null {
  const raw = clean(process.env.S3_OBJECT_LOCK_MODE).toUpperCase();
  return raw === "GOVERNANCE" || raw === "COMPLIANCE" ? raw : null;
}

/** Mirrors services/api/src/storage.ts:189 parsePositiveInt(RETAIN_DAYS). */
function readObjectLockRetainDays(): number | null {
  const raw = clean(process.env.S3_OBJECT_LOCK_RETAIN_DAYS);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalise SIGNER_PROVIDER. Mirrors
 * services/api/src/config/index.ts:259 (default local-pem) and the
 * signer-health provider mapping.
 */
function readSignerProvider():
  | "aws-kms"
  | "local-pem"
  | "disabled"
  | "unknown" {
  const raw = clean(process.env.SIGNER_PROVIDER).toLowerCase();
  if (raw === "") return "local-pem"; // documented default
  if (raw === "aws-kms" || raw === "aws_kms") return "aws-kms";
  if (raw === "local-pem" || raw === "local_pem") return "local-pem";
  if (raw === "disabled") return "disabled";
  return "unknown";
}

/**
 * Database backup posture. There are NO repo-level automated backup
 * scripts (verified: no pg_dump / snapshot scripts under
 * services/api/scripts or infra). We therefore report an honest
 * managed-platform assumption rather than a fabricated positive.
 *
 * If a future operator wires an explicit managed-backup acknowledgement
 * env, this is where the honest signal would be read. Until then the
 * managed-platform assumption stands (databases in this stack are
 * expected to run on a managed platform that provides backups).
 */
function readDatabaseBackupPosture(): {
  posture: DatabaseBackupPosture;
  reason: string;
} {
  const hasDatabaseUrl = clean(process.env.DATABASE_URL).length > 0;
  if (!hasDatabaseUrl) {
    return {
      posture: "not_configured",
      reason:
        "DATABASE_URL is not set; no database is configured for this process, so no backup posture can be reported.",
    };
  }
  return {
    posture: "managed_platform_assumed",
    reason:
      "No repository-level automated database backup scripts exist. Database backups are assumed to be provided by the managed database platform and MUST be configured and verified out-of-band by the operator. This is an assumption, not a verified guarantee.",
  };
}

// -----------------------------------------------------------------------------
// Sub-computations
// -----------------------------------------------------------------------------

async function computeBackupPosture(): Promise<BackupPosture> {
  const objectLockStatus = await getObjectLockStatus();
  const db = readDatabaseBackupPosture();
  // Operator-declared honest backup metadata (labels/timestamps only).
  const databaseBackupProvider = readLabelEnv("DATABASE_BACKUP_PROVIDER");
  const databaseBackupPolicyUrl = readLabelEnv("DATABASE_BACKUP_POLICY_URL");
  const databaseBackupLastVerifiedAtUtc = readIsoEnv(
    "DATABASE_BACKUP_LAST_VERIFIED_AT",
  );
  const databaseRestoreTestedAtUtc = readIsoEnv("DATABASE_RESTORE_TESTED_AT");
  // Launch gate is HONEST: green only when backups are independently
  // verified AND a restore has actually been tested. Absence => action
  // required (never silently "ready").
  const databaseBackupLaunchActionRequired =
    databaseBackupLastVerifiedAtUtc === null ||
    databaseRestoreTestedAtUtc === null;
  return {
    objectLockEnabled: readObjectLockEnabled(),
    objectLockMode: readObjectLockMode(),
    objectLockRetainDays: readObjectLockRetainDays(),
    objectLockStatus,
    databaseBackup: db.posture,
    databaseBackupReason: db.reason,
    databaseBackupProvider,
    databaseBackupPolicyUrl,
    databaseBackupLastVerifiedAtUtc,
    databaseRestoreTestedAtUtc,
    databaseBackupLaunchActionRequired,
    artifactRegeneration: {
      reportRegenAvailable: true,
      note: "Signed reports and verification packages are deterministic artifacts re-derivable from immutable evidence and the stored manifest; they can be regenerated rather than restored from a backup.",
    },
  };
}

function computeKeyPosture(): KeyPosture {
  const signerProvider = readSignerProvider();
  const versionRaw = clean(process.env.SIGNING_KEY_VERSION);
  if (versionRaw.length === 0) {
    return {
      signerProvider,
      keyVersioned: false,
      keyVersionUnknownReason:
        "SIGNING_KEY_VERSION is not set; signing key versioning cannot be confirmed.",
    };
  }
  const parsed = Number.parseInt(versionRaw, 10);
  const versioned = Number.isFinite(parsed) && parsed >= 1;
  return {
    signerProvider,
    keyVersioned: versioned,
    keyVersionUnknownReason: versioned
      ? null
      : "SIGNING_KEY_VERSION is set but is not a positive integer version.",
  };
}

async function computeResiliency(
  prisma: PrismaClient,
): Promise<ResiliencyPosture> {
  // Runtime readiness — reuse the existing aggregator.
  let runtimeReadinessSummary: ResiliencyPosture["runtimeReadinessSummary"];
  try {
    const report = await runReadinessCheck(prisma, null);
    runtimeReadinessSummary = {
      status: report.status,
      ranAtUtc: report.ranAtUtc,
      subsystemCount: report.subsystems.length,
      degradedSubsystems: report.subsystems
        .filter((s) => s.status === "DEGRADED" || s.status === "CRITICAL")
        .map((s) => s.id),
      unavailableReason: null,
    };
  } catch (err) {
    runtimeReadinessSummary = {
      status: "UNKNOWN",
      ranAtUtc: new Date().toISOString(),
      subsystemCount: 0,
      degradedSubsystems: [],
      unavailableReason:
        err instanceof Error
          ? `Runtime readiness aggregator unavailable: ${err.message.slice(0, 160)}`
          : "Runtime readiness aggregator unavailable.",
    };
  }

  // Schema drift — reuse the existing validator.
  let schemaDriftSummary: ResiliencyPosture["schemaDriftSummary"];
  try {
    const report = await runSchemaValidation(prisma);
    schemaDriftSummary = {
      status: report.status,
      driftFingerprint: report.driftFingerprint ?? null,
      failureCount: report.failures.length,
      checkedCount: report.checked,
      unavailableReason: null,
    };
  } catch (err) {
    schemaDriftSummary = {
      status: "unknown",
      driftFingerprint: null,
      failureCount: 0,
      checkedCount: 0,
      unavailableReason:
        err instanceof Error
          ? `Schema validation unavailable: ${err.message.slice(0, 160)}`
          : "Schema validation unavailable.",
    };
  }

  return { runtimeReadinessSummary, schemaDriftSummary };
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

/**
 * MFA / login-throttle posture. Honest: the throttle uses the shared
 * limiter which is Redis-backed only when REDIS_URL is configured. In
 * production without a shared store the throttle is per-instance and a
 * multi-instance deployment is NOT production-ready for brute-force
 * resistance. We read only whether a shared store is CONFIGURED — never
 * the connection string.
 */
function computeMfaThrottlePosture(): MfaThrottlePosture {
  const hasSharedStore = clean(process.env.REDIS_URL).length > 0;
  const isProduction = clean(process.env.NODE_ENV).toLowerCase() === "production";
  const store: "redis" | "memory" = hasSharedStore ? "redis" : "memory";
  if (hasSharedStore) {
    return {
      store,
      shared: true,
      productionReady: true,
      reason:
        "MFA/login attempt throttling runs on the shared (Redis-backed) rate limiter, so attempt counters are shared across API instances.",
    };
  }
  return {
    store,
    shared: false,
    productionReady: !isProduction,
    reason: isProduction
      ? "REDIS_URL is not configured in production: MFA/login throttling falls back to a per-instance in-memory store. A multi-instance deployment could multiply the attempt budget. Configure a shared (Redis) store before launch."
      : "REDIS_URL is not configured: MFA/login throttling uses the in-memory fallback. This is acceptable for a single-instance dev/test environment.",
  };
}

export async function computeReadinessPosture(
  prisma: PrismaClient = defaultPrisma,
): Promise<ReadinessPosture> {
  const [backup, resiliency] = await Promise.all([
    computeBackupPosture(),
    computeResiliency(prisma),
  ]);
  return {
    generatedAtUtc: new Date().toISOString(),
    backup,
    keys: computeKeyPosture(),
    resiliency,
    mfaThrottle: computeMfaThrottlePosture(),
    knownLimitations: KNOWN_LIMITATIONS,
  };
}
