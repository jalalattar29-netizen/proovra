/**
 * THE INTEGRITY-RECHECK AUTHORITY (ET-SM-07, owner decision 2026-09-30).
 *
 * Integrity rechecking is a core evidence-safety commitment for every signed
 * record, including one that never receives a report, on every plan. Until
 * now the stored bytes were re-hashed only inside the report pipeline, which
 * is commercially gated, so a record without a report was never re-verified.
 *
 * This module is the one place that decides and records:
 *   - WHICH records are in scope (signed, not destroyed and not being
 *     destroyed) — `integrityRecheckEligibleWhere`;
 *   - WHICH are due (never checked, older than the cadence, or explicitly
 *     requested) — `integrityRecheckDueWhere`;
 *   - the CLAIM that lets exactly one checker hold a record at a time
 *     (`claimIntegrityRecheck`, a lease);
 *   - the RECORD of every attempt (`recordIntegrityCheckTx`): an append-only
 *     history row plus the latest-state columns on the record;
 *   - an on-demand REQUEST (`requestIntegrityRecheck`), used by Public Verify,
 *     original-byte release, recovery and storage-anomaly paths;
 *   - the STATE a reader may present (`readStoredBytesIntegrity`, a thin
 *     binding over the pure resolver in @proovra/shared).
 *
 * It hashes nothing. The worker reads the objects (it owns the storage
 * client) and reports what it observed; the API reads state and requests
 * rechecks. Neither writes these columns any other way.
 *
 * It never changes a record's lifecycle: a trashed record is rechecked where
 * it is, and a destroyed or being-destroyed record is out of scope — a recheck
 * cannot resurrect either.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  INTEGRITY_RECHECK_INTERVAL_DAYS_DEFAULT,
  STORED_BYTES_FRESHNESS_HOURS_DEFAULT,
  resolveStoredBytesIntegrity,
  type IntegrityCheckFailureCode,
  type IntegrityCheckOutcome,
  type IntegrityCheckTrigger,
  type StoredBytesIntegrity,
} from "@proovra/shared";

/** Bumped when the checking procedure changes in a way a reader should know. */
export const INTEGRITY_CHECKER_VERSION = "proovra-integrity-recheck/1";

/** How long one checker may hold a record before another may take it. */
export const INTEGRITY_RECHECK_CLAIM_LEASE_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The periodic cadence. `INTEGRITY_RECHECK_INTERVAL_DAYS` configures it;
 * anything that is not a positive number falls back to the default (30).
 */
export function integrityRecheckIntervalDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INTEGRITY_RECHECK_INTERVAL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : INTEGRITY_RECHECK_INTERVAL_DAYS_DEFAULT;
}

/**
 * UC-TRUST-008 — the window inside which a passing check is presented as
 * CURRENT. `STORED_BYTES_FRESHNESS_HOURS` configures it; anything that is not
 * a positive number falls back to the default (24). Deliberately separate
 * from the recheck cadence: a 30-day-old check is due-later, never current.
 */
export function storedBytesFreshnessHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STORED_BYTES_FRESHNESS_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : STORED_BYTES_FRESHNESS_HOURS_DEFAULT;
}

const SIGNED: prismaPkg.EvidenceStatus[] = [
  prismaPkg.EvidenceStatus.SIGNED,
  prismaPkg.EvidenceStatus.REPORTED,
];
const OUT_OF_SCOPE: prismaPkg.EvidenceLifecycleState[] = ["DESTROYED", "PENDING_DESTRUCTION"];

/**
 * Records a recheck applies to: signed (so there is a signed digest to compare
 * with) and neither destroyed nor in the middle of being destroyed (its bytes
 * may be going). Every plan; no commercial predicate.
 */
export function integrityRecheckEligibleWhere(): Prisma.EvidenceWhereInput {
  return {
    status: { in: SIGNED },
    lifecycleState: { notIn: OUT_OF_SCOPE },
    fileSha256: { not: null },
  };
}

/** Eligible records that are due now and not held by a live claim. */
export function integrityRecheckDueWhere(
  now: Date = new Date(),
  intervalDays: number = integrityRecheckIntervalDays(),
): Prisma.EvidenceWhereInput {
  const staleBefore = new Date(now.getTime() - intervalDays * DAY_MS);
  const leaseBefore = new Date(now.getTime() - INTEGRITY_RECHECK_CLAIM_LEASE_MS);
  return {
    AND: [
      integrityRecheckEligibleWhere(),
      {
        OR: [
          { integrityRecheckRequestedAtUtc: { not: null } },
          { integrityCheckedAtUtc: null },
          { integrityCheckedAtUtc: { lt: staleBefore } },
        ],
      },
      {
        OR: [
          { integrityRecheckClaimedAtUtc: null },
          { integrityRecheckClaimedAtUtc: { lt: leaseBefore } },
        ],
      },
    ],
  };
}

type EvidenceWriter = Pick<PrismaClient, "evidence">;

/**
 * Take the lease on one record. True when THIS caller holds it.
 *
 * A conditional update, so two checkers racing for one record cannot both win
 * and a duplicate job is a no-op. `force` claims an eligible record that is
 * not due (a caller that is about to read the bytes anyway, such as report
 * issuance) but still respects a live claim held by someone else.
 */
export async function claimIntegrityRecheck(
  client: EvidenceWriter,
  evidenceId: string,
  opts: { now?: Date; force?: boolean } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const leaseBefore = new Date(now.getTime() - INTEGRITY_RECHECK_CLAIM_LEASE_MS);
  const where: Prisma.EvidenceWhereInput = opts.force
    ? {
        AND: [
          integrityRecheckEligibleWhere(),
          {
            OR: [
              { integrityRecheckClaimedAtUtc: null },
              { integrityRecheckClaimedAtUtc: { lt: leaseBefore } },
            ],
          },
        ],
      }
    : integrityRecheckDueWhere(now);
  const claimed = await client.evidence.updateMany({
    where: { AND: [{ id: evidenceId }, where] },
    data: { integrityRecheckClaimedAtUtc: now },
  });
  return claimed.count === 1;
}

export type IntegrityCheckedObject = {
  partIndex: number | null;
  versionId: string | null;
  sha256: string | null;
};

export type IntegrityCheckRecord = {
  evidenceId: string;
  teamId: string | null;
  outcome: IntegrityCheckOutcome;
  failureCode: IntegrityCheckFailureCode | null;
  trigger: IntegrityCheckTrigger;
  /** The exact VersionId read, for a single-object record. */
  storageVersionId: string | null;
  checkedObjects: IntegrityCheckedObject[];
  expectedDigest: string | null;
  checkedDigest: string | null;
  correlationId: string | null;
  checkedAtUtc?: Date;
};

type IntegrityCheckTx = Pick<Prisma.TransactionClient, "evidence" | "evidenceIntegrityCheck">;

/**
 * Record one attempt: the history row and the record's latest state, together.
 *
 *   VERIFIED     verified-at and checked-at advance; any request is satisfied.
 *   FAILED       checked-at advances; verified-at is left as the last time the
 *                bytes DID match; the request is satisfied (the answer is in).
 *   UNAVAILABLE  checked-at is NOT advanced and the request is kept, so the
 *                record stays due; the lease is restarted so the retry comes
 *                after it, not on the next tick. Only the outcome is noted.
 *
 * VERIFIED and FAILED release the claim. The lifecycle state is never touched.
 */
export async function recordIntegrityCheckTx(
  tx: IntegrityCheckTx,
  record: IntegrityCheckRecord,
): Promise<{ id: string; checkedAtUtc: Date }> {
  const at = record.checkedAtUtc ?? new Date();
  const row = await tx.evidenceIntegrityCheck.create({
    data: {
      evidenceId: record.evidenceId,
      teamId: record.teamId,
      storageVersionId: record.storageVersionId,
      checkedObjects: record.checkedObjects as unknown as Prisma.InputJsonValue,
      expectedDigest: record.expectedDigest,
      checkedDigest: record.checkedDigest,
      checkedAtUtc: at,
      outcome: record.outcome,
      failureCode: record.failureCode,
      trigger: record.trigger,
      checkerVersion: INTEGRITY_CHECKER_VERSION,
      correlationId: record.correlationId ? record.correlationId.slice(0, 128) : null,
    },
    select: { id: true },
  });
  await tx.evidence.updateMany({
    where: { id: record.evidenceId },
    data:
      record.outcome === "UNAVAILABLE"
        ? {
            integrityCheckOutcome: record.outcome,
            integrityCheckFailureCode: record.failureCode,
            // The lease is KEPT, restarted from this attempt: it is the
            // retry backoff. Releasing it would make the record due again at
            // once, and a store that stays down would be re-read every tick
            // ahead of everything else.
            integrityRecheckClaimedAtUtc: at,
          }
        : {
            integrityCheckedAtUtc: at,
            integrityCheckOutcome: record.outcome,
            integrityCheckFailureCode: record.failureCode,
            integrityRecheckRequestedAtUtc: null,
            integrityRecheckClaimedAtUtc: null,
            ...(record.outcome === "VERIFIED" ? { integrityVerifiedAtUtc: at } : {}),
          },
  });
  return { id: row.id, checkedAtUtc: at };
}

/**
 * Ask for an on-demand recheck. Idempotent: a record already requested keeps
 * its original request time (so it is not starved by re-requests), and a
 * record out of scope is not touched. Returns whether a request is now set.
 */
export async function requestIntegrityRecheck(
  client: EvidenceWriter,
  evidenceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const set = await client.evidence.updateMany({
    where: {
      AND: [{ id: evidenceId }, integrityRecheckEligibleWhere(), { integrityRecheckRequestedAtUtc: null }],
    },
    data: { integrityRecheckRequestedAtUtc: now },
  });
  return set.count === 1;
}

/** The columns a reader selects to present the state. */
export const STORED_BYTES_INTEGRITY_SELECT = {
  status: true,
  integrityVerifiedAtUtc: true,
  integrityCheckedAtUtc: true,
  integrityCheckOutcome: true,
  integrityCheckFailureCode: true,
  integrityRecheckRequestedAtUtc: true,
  // UC-TRUST-008 — the pinned version and the recorded digest the state is about.
  storageVersionId: true,
  fileSha256: true,
  // UC-TRUST-008 — a multi-part record is pinned only when every part is.
  parts: { select: { storageVersionId: true } },
} as const;

export type StoredBytesIntegrityRow = {
  status: prismaPkg.EvidenceStatus | string;
  integrityVerifiedAtUtc: Date | null;
  integrityCheckedAtUtc: Date | null;
  integrityCheckOutcome: string | null;
  integrityCheckFailureCode: string | null;
  integrityRecheckRequestedAtUtc: Date | null;
  storageVersionId?: string | null;
  fileSha256?: string | null;
  parts?: Array<{ storageVersionId: string | null }>;
};

/** UC-TRUST-008 — what a check reads is an immutable, pinned version. */
export function storedBytesVersionPinned(row: Pick<StoredBytesIntegrityRow, "storageVersionId" | "parts">): boolean {
  if (row.storageVersionId) return true;
  const parts = row.parts ?? [];
  return parts.length > 0 && parts.every((p) => Boolean(p.storageVersionId));
}

/**
 * The state a surface may present for this record: CURRENT only inside the
 * freshness window (UC-TRUST-008), judged against the pinned version.
 */
export function readStoredBytesIntegrity(
  row: StoredBytesIntegrityRow,
  now: Date = new Date(),
  intervalDays: number = integrityRecheckIntervalDays(),
  freshnessHours: number = storedBytesFreshnessHours(),
): StoredBytesIntegrity {
  return resolveStoredBytesIntegrity(
    {
      rejected: row.status === prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH,
      lastVerifiedAtUtc: row.integrityVerifiedAtUtc,
      lastCheckedAtUtc: row.integrityCheckedAtUtc,
      lastOutcome: row.integrityCheckOutcome,
      lastFailureCode: row.integrityCheckFailureCode,
      recheckRequestedAtUtc: row.integrityRecheckRequestedAtUtc,
      pinnedVersionId: row.storageVersionId ?? null,
      recordedDigest: row.fileSha256 ?? null,
      versionPinned: storedBytesVersionPinned(row),
    },
    now,
    intervalDays,
    freshnessHours,
  );
}
