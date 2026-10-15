/**
 * THE OBJECT RETENTION RESOLVER — the one place an S3 write learns its lock.
 *
 * Every writer into the evidence bucket (API uploads and finalization, the
 * worker's reports, packages, previews, derived files) asks this module for
 * its mode and retain-until. It reads the deployment's existing authority
 * (`S3_OBJECT_LOCK_ENABLED`, `S3_OBJECT_LOCK_MODE`,
 * `S3_OBJECT_LOCK_RETAIN_DAYS`) through the eight-year contract in
 * `@proovra/shared` (`resolvePlatformRetentionDays`), so a writer cannot
 * compute a duration of its own and two writers cannot disagree.
 *
 *   - a NEW object not yet tied to a sealed record: now + the platform period;
 *   - the SEAL of a record: max(now + period, contractual retention), or the
 *     record's existing horizon when it was already sealed;
 *   - an ARTIFACT of an existing record: the record's fixed horizon.
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
  type ObjectLockModeName,
} from "@proovra/shared";

export interface ObjectLockPolicy {
  enabled: boolean;
  mode: ObjectLockModeName;
  /** max(eight years, configured days). */
  platformRetentionDays: number;
  /** Configuration asked for less than the eight-year contract (and was not followed). */
  configuredBelowContract: boolean;
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function objectLockPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectLockPolicy {
  const days = resolvePlatformRetentionDays(positiveInt(env.S3_OBJECT_LOCK_RETAIN_DAYS));
  return {
    enabled: String(env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true",
    mode: resolveObjectLockModeName(env.S3_OBJECT_LOCK_MODE),
    platformRetentionDays: days.days,
    configuredBelowContract: days.configuredBelowContract,
  };
}

/** The lock for a new object that no sealed record defines yet (an upload in flight, an export). */
export function newObjectLock(
  policy: ObjectLockPolicy = objectLockPolicyFromEnv(),
  now: Date = new Date(),
): { mode: ObjectLockModeName; retainUntil: Date } | null {
  if (!policy.enabled) return null;
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
 * The lock for one write that belongs to an evidence record. Returns null when
 * Object Lock is disabled (nothing is sent) — and throws when the record is
 * unknown, so a writer never falls back to a guess.
 */
export async function resolveEvidenceObjectRetention(
  prisma: RetentionReader,
  evidenceId: string,
  options: { kind: "SEAL" | "ARTIFACT"; now?: Date; policy?: ObjectLockPolicy },
): Promise<EvidenceObjectRetention | null> {
  const policy = options.policy ?? objectLockPolicyFromEnv();
  if (!policy.enabled) return null;
  const now = options.now ?? new Date();
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      createdAt: true,
      signedAtUtc: true,
      retentionUntilUtc: true,
      storageObjectLockRetainUntilUtc: true,
    },
  });
  if (!evidence) throw new Error(`OBJECT_RETENTION_EVIDENCE_NOT_FOUND:${evidenceId}`);
  const parts = await prisma.evidencePart.findMany({
    where: { evidenceId, storageObjectLockRetainUntilUtc: { not: null } },
    select: { storageObjectLockRetainUntilUtc: true },
  });
  let sealedOriginal: Date | null = evidence.storageObjectLockRetainUntilUtc ?? null;
  for (const p of parts) {
    const until = p.storageObjectLockRetainUntilUtc;
    if (until && (!sealedOriginal || until.getTime() > sealedOriginal.getTime())) sealedOriginal = until;
  }
  const alreadySealed = sealedOriginal !== null;
  // Before the first seal there is no horizon: the seal defines it.
  const horizon =
    alreadySealed || options.kind === "ARTIFACT"
      ? computeEvidenceRetentionHorizon({
          sealedOriginalRetainUntil: sealedOriginal,
          sealedAt: evidence.signedAtUtc ?? evidence.createdAt,
          appRetentionUntil: evidence.retentionUntilUtc,
          platformRetentionDays: policy.platformRetentionDays,
        })
      : null;
  return {
    mode: policy.mode,
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
