/**
 * THE OBJECT RETENTION RESOLVER — the one place an S3 write learns its lock.
 *
 * Every writer into the evidence bucket (API uploads and finalization, the
 * worker's reports, packages, previews, derived files) asks this module for
 * its mode and retain-until. It reads the deployment's existing authority —
 * `S3_OBJECT_LOCK_ENABLED`, `S3_OBJECT_LOCK_MODE` (COMPLIANCE in Production),
 * `S3_OBJECT_LOCK_RETAIN_DAYS` (2920 in Production) — through the contract in
 * `@proovra/shared` (`resolvePlatformRetentionDays`), so a writer cannot compute
 * a duration of its own and two writers cannot disagree.
 *
 *   - a NEW object not yet tied to a sealed record: now + the platform period;
 *   - the SEAL of a record: max(now + period, contractual retention), or the
 *     record's existing horizon when it was already sealed;
 *   - an ARTIFACT of an existing record: the record's fixed horizon, in the
 *     STRONGER of the configured mode and the record's stored mode — a
 *     COMPLIANCE record never gets a GOVERNANCE artifact. Past the horizon the
 *     write is refused (`RetentionHorizonEndedError`), never extended here.
 *
 * Nothing here shortens a lock: S3 refuses a shorter retain-until on a locked
 * version, and this module never sends a Governance bypass.
 */
import type { PrismaClient } from "@prisma/client";

import {
  computeEvidenceRetentionHorizon,
  resolveObjectLockModeName,
  resolveObjectRetainUntil,
  resolvePlatformRetentionDays,
  strongestObjectLockMode,
  type ObjectLockModeName,
} from "@proovra/shared";

export interface ObjectLockPolicy {
  enabled: boolean;
  /** The configured mode; null when missing or unrecognised (there is no default). */
  mode: ObjectLockModeName | null;
  /** max(2920 days, configured days). */
  platformRetentionDays: number;
  /** Configuration asked for less than the 2920-day contract (and was not followed). */
  configuredBelowContract: boolean;
  /** Enabled without a usable mode: nothing can be locked truthfully. */
  incomplete: boolean;
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function objectLockPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectLockPolicy {
  const days = resolvePlatformRetentionDays(positiveInt(env.S3_OBJECT_LOCK_RETAIN_DAYS));
  const enabled = String(env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true";
  const mode = resolveObjectLockModeName(env.S3_OBJECT_LOCK_MODE);
  return {
    enabled,
    mode,
    platformRetentionDays: days.days,
    configuredBelowContract: days.configuredBelowContract,
    incomplete: enabled && mode === null,
  };
}

/** Object Lock is enabled but no mode is configured: a write that must be locked is refused. */
export class ObjectLockConfigurationIncompleteError extends Error {
  readonly code = "OBJECT_LOCK_CONFIGURATION_INCOMPLETE" as const;
  readonly retriable = false;
  constructor() {
    super("OBJECT_LOCK_CONFIGURATION_INCOMPLETE: S3_OBJECT_LOCK_ENABLED=true without a valid S3_OBJECT_LOCK_MODE");
    this.name = "ObjectLockConfigurationIncompleteError";
  }
}

/**
 * The lock for a new object that no sealed record defines yet (an upload in
 * flight, an export). Null when Object Lock is disabled — or enabled without
 * a mode, which callers report truthfully as "not applied".
 */
export function newObjectLock(
  policy: ObjectLockPolicy = objectLockPolicyFromEnv(),
  now: Date = new Date(),
): { mode: ObjectLockModeName; retainUntil: Date } | null {
  if (!policy.enabled || policy.mode === null) return null;
  return {
    mode: policy.mode,
    retainUntil: resolveObjectRetainUntil({
      kind: "SEAL",
      now,
      platformRetentionDays: policy.platformRetentionDays,
      horizon: null,
      appRetentionUntil: null,
      alreadySealed: false,
    }),
  };
}

export interface EvidenceObjectRetention {
  mode: ObjectLockModeName;
  retainUntil: Date;
  /** The record's fixed horizon (null only before its first seal). */
  horizon: Date | null;
}

type RetentionReader = Pick<PrismaClient, "evidence" | "evidencePart">;

/**
 * The lock for one write that belongs to an evidence record.
 *
 *   - Object Lock disabled → null (nothing is sent);
 *   - enabled without a mode → SEAL: null (finalization reports "not
 *     applied"); ARTIFACT: refused (`ObjectLockConfigurationIncompleteError`);
 *   - an unknown record → refused, so a writer never falls back to a guess;
 *   - an ARTIFACT past the record's horizon → refused
 *     (`RetentionHorizonEndedError`).
 */
export async function resolveEvidenceObjectRetention(
  prisma: RetentionReader,
  evidenceId: string,
  options: { kind: "SEAL" | "ARTIFACT"; now?: Date; policy?: ObjectLockPolicy },
): Promise<EvidenceObjectRetention | null> {
  const policy = options.policy ?? objectLockPolicyFromEnv();
  if (!policy.enabled) return null;
  if (policy.mode === null) {
    if (options.kind === "SEAL") return null;
    throw new ObjectLockConfigurationIncompleteError();
  }
  const now = options.now ?? new Date();
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      createdAt: true,
      signedAtUtc: true,
      retentionUntilUtc: true,
      storageObjectLockMode: true,
      storageObjectLockRetainUntilUtc: true,
      latestRequiredRetainUntilUtc: true,
    },
  });
  if (!evidence) throw new Error(`OBJECT_RETENTION_EVIDENCE_NOT_FOUND:${evidenceId}`);
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId, storageObjectLockRetainUntilUtc: { not: null } },
    select: { storageObjectLockRetainUntilUtc: true, storageObjectLockMode: true },
  });
  let sealedOriginal: Date | null = evidence.storageObjectLockRetainUntilUtc ?? null;
  for (const p of parts) {
    const until = p.storageObjectLockRetainUntilUtc;
    if (until && (!sealedOriginal || until.getTime() > sealedOriginal.getTime())) sealedOriginal = until;
  }
  const alreadySealed = sealedOriginal !== null;
  // The stored mode of the record's own objects is authoritative: a record
  // sealed under COMPLIANCE stays COMPLIANCE whatever is configured later.
  const mode = strongestObjectLockMode(
    policy.mode,
    evidence.storageObjectLockMode,
    ...parts.map((p) => p.storageObjectLockMode),
  )!;
  // Before the first seal there is no horizon: the seal defines it.
  const horizon =
    alreadySealed || options.kind === "ARTIFACT"
      ? computeEvidenceRetentionHorizon({
          sealedOriginalRetainUntil: sealedOriginal,
          storageRetainUntil: evidence.latestRequiredRetainUntilUtc,
          sealedAt: evidence.signedAtUtc ?? evidence.createdAt,
          appRetentionUntil: evidence.retentionUntilUtc,
          platformRetentionDays: policy.platformRetentionDays,
        })
      : null;
  return {
    mode,
    retainUntil: resolveObjectRetainUntil({
      kind: options.kind,
      now,
      platformRetentionDays: policy.platformRetentionDays,
      horizon,
      appRetentionUntil: evidence.retentionUntilUtc,
      alreadySealed,
    }),
    horizon,
  };
}
