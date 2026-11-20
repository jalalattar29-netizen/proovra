/**
 * UC-0 (D5) — derived bytes count toward storage.
 *
 * `EvidencePartDerivedAsset` objects (thumbnails, frames, waveforms, proxies)
 * are real objects in the workspace's bucket, but the storage calculators
 * summed evidence, reports and packages only, so derived bytes were never
 * counted. There is no thumbnail exemption: every derived object with a
 * storage pointer counts, whatever its status (a FAILED regeneration keeps the
 * pointer — and the bytes — of the artifact it failed to replace).
 *
 * Scoped by the derived row's own `team_id`, which is always the owning
 * record's team (the writer copies it from the part's evidence and the column
 * is NOT NULL, so a legacy `team_id IS NULL` record can never have one).
 * Counted exactly once: one row per (team, part, kind, variant), one pointer
 * per row. Destruction deletes the rows of a destroyed record together with
 * their objects, so a destroyed record contributes nothing.
 *
 * Shared by the API and Worker calculators so the two cannot disagree.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { MEDIA_INTELLIGENCE_RUN_LEASE_MS } from "../media-intelligence/run-tracker.service.js";

export type DerivedStorageScope = {
  /** The workspace Team (a personal Team for a personal scope), or null. */
  teamId: string | null;
};

export async function sumDerivedAssetStorageBytes(
  // AUD-0017 — any client with the delegate, so a transaction can pass its own.
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset"> & Partial<Pick<PrismaClient, "redactionDerivative" | "redactionPagePreview">>,
  scope: DerivedStorageScope,
): Promise<bigint> {
  if (!scope.teamId) return 0n;
  const agg = await prisma.evidencePartDerivedAsset.aggregate({
    where: { teamId: scope.teamId, storageKey: { not: null } },
    _sum: { sizeBytes: true },
  });
  const raw = agg?._sum?.sizeBytes ?? 0;
  // PRO-R3-15 / DEC-04 — a redacted copy is a customer-requested derived
  // artifact: an object in the workspace's bucket counts like every other
  // derived object with a storage pointer (a READY copy, and a FAILED row
  // that recorded the object it stored). One row per version, one pointer
  // per row, so a re-render never double-counts.
  const redaction = prisma.redactionDerivative
    ? await prisma.redactionDerivative.aggregate({
        where: { teamId: scope.teamId, storageKey: { not: null } },
        _sum: { byteSize: true },
      })
    : null;
  const redactionRaw = redaction?._sum?.byteSize ?? 0;
  // PRO-R3-04 — the editor's rendered page images are stored objects of the
  // same kind: one row per (project, page), counted while the pointer exists.
  const previews = prisma.redactionPagePreview
    ? await prisma.redactionPagePreview.aggregate({
        where: { teamId: scope.teamId, storageKey: { not: null } },
        _sum: { byteSize: true },
      })
    : null;
  const previewRaw = previews?._sum?.byteSize ?? 0;
  return (
    BigInt(Math.trunc(Number(raw))) +
    BigInt(Math.trunc(Number(redactionRaw))) +
    BigInt(Math.trunc(Number(previewRaw)))
  );
}

/**
 * WS-SCHED / PRO-W1-07 (DEC-04) — Evidence Exchange package ZIPs are
 * customer-requested derived artifacts and count toward storage, on both hosts.
 *
 * A package counts while its row points at a stored object (`storage_key`),
 * whatever its state: READY and DELIVERED packages, and one the customer
 * revoked or that expired while its ZIP is still held under the records'
 * Object Lock. The builder writes the pointer and `package_size_bytes` in the
 * READY transition only, so a DRAFT or BUILDING package counts nothing, and
 * destruction clears the pointer once the object is verified gone
 * (evidence-destruction/executor), so a destroyed package counts nothing.
 *
 * Scoped by the package's own `team_id` (NOT NULL: packages exist only in a
 * workspace Team), the same subject `sumDerivedAssetStorageBytes` uses.
 */
export async function sumExchangePackageStorageBytes(
  prisma: Pick<PrismaClient, "evidenceExchangePackage">,
  scope: DerivedStorageScope,
): Promise<bigint> {
  if (!scope.teamId) return 0n;
  const agg = await prisma.evidenceExchangePackage.aggregate({
    where: { teamId: scope.teamId, storageKey: { not: null } },
    _sum: { packageSizeBytes: true },
  });
  const raw = agg?._sum?.packageSizeBytes ?? 0;
  return BigInt(Math.trunc(Number(raw)));
}

// =============================================================================
// M676 (DEC-04) — THE STORAGE RESERVATION OF A DERIVED-ARTIFACT JOB
// =============================================================================
//
// The derived storage gate was check-then-write: two derived jobs of one
// workspace both read the same committed usage, both passed, and both wrote an
// object under the record's Object Lock (overshoot: one derived object per
// concurrent job). The worker now RESERVES the bytes on the derived row
// (`storage_reserved_bytes` / `storage_reserved_at_utc`, migration
// 20281122000000) in a short transaction under the workspace capacity lock
// (`lockWorkspaceCapacityTx`), and uploads only after that transaction ends.
//
//   - LIVE while younger than DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS. Both
//     usage meters add the live reservations through
//     `sumLiveArtifactStorageReservationBytes` (artifact-storage-reservation),
//     the one reservation figure the API and the Worker read.
//   - SETTLED by `recordDerivedAsset` (any status): the same statement that
//     writes the live size clears the reservation, so the bytes are never
//     counted twice and never uncounted.
//   - RELEASED by an aborted job (`releaseDerivedAssetStorageReservation`), and
//     cleared after expiry by `releaseExpiredDerivedAssetStorageReservations`.

/**
 * How long a derived reservation counts. The media-intelligence run lease
 * (20 minutes): the combined-recording job reserves, renews its run lease and
 * then gets at most its 15-minute attempt budget to upload (kept below the
 * lease, `combine_screen_recording.attemptTimeoutMs`), so a live job always
 * settles inside the TTL; a thumbnail / frame / waveform / proxy job writes
 * one small object in seconds. A job that died stops counting when the lease
 * a successor would take over at runs out.
 */
export const DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS = MEDIA_INTELLIGENCE_RUN_LEASE_MS;

/** The derived row a reservation is held on: its canonical identity. */
export type DerivedAssetReservationKey = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: string;
  variantKey: string;
};

/** The oldest reservation time that still counts at `now`. */
export function derivedAssetReservationLiveSince(now: Date): Date {
  return new Date(now.getTime() - DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS);
}

/**
 * Bytes reserved by derived jobs in flight for this workspace Team (the usage
 * Team both meters resolve). Expired reservations count nothing.
 */
export async function sumLiveDerivedAssetStorageReservationBytes(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset">,
  input: { teamId: string | null; now?: Date },
): Promise<bigint> {
  if (!input.teamId) return 0n;
  const agg = await prisma.evidencePartDerivedAsset.aggregate({
    where: {
      teamId: input.teamId,
      storageReservedBytes: { not: null },
      storageReservedAtUtc: { gt: derivedAssetReservationLiveSince(input.now ?? new Date()) },
    },
    _sum: { storageReservedBytes: true },
  });
  const raw = agg?._sum?.storageReservedBytes ?? 0;
  return typeof raw === "bigint" ? raw : BigInt(Math.max(0, Math.trunc(Number(raw))));
}

/**
 * Inside the caller's capacity-locked transaction: drop this row's own
 * reservation first, so a retry re-reserving is not counted against itself.
 */
export async function clearOwnDerivedAssetStorageReservationTx(
  tx: Pick<PrismaClient, "evidencePartDerivedAsset">,
  key: DerivedAssetReservationKey,
): Promise<void> {
  await tx.evidencePartDerivedAsset.updateMany({
    where: {
      teamId: key.teamId,
      evidencePartId: key.evidencePartId,
      assetKind: key.assetKind,
      variantKey: key.variantKey,
      storageReservedBytes: { not: null },
    },
    data: { storageReservedBytes: null, storageReservedAtUtc: null },
  });
}

/**
 * Inside the caller's capacity-locked transaction, after the bytes were
 * admitted: record the reservation on the row. A producer whose row does not
 * exist yet (the combined screen recording of a new generation) gets a
 * PROCESSING placeholder with no storage pointer; an existing row keeps its
 * status, pointer and size (a regeneration's previous object still counts).
 */
export async function writeDerivedAssetStorageReservationTx(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  key: DerivedAssetReservationKey,
  bytes: bigint,
  now: Date,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "evidence_part_derived_assets" (
      "team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key",
      "status", "storage_reserved_bytes", "storage_reserved_at_utc", "updated_at_utc"
    ) VALUES (
      ${key.teamId}::uuid, ${key.evidenceId}::uuid, ${key.evidencePartId}::uuid,
      ${key.assetKind}::varchar, ${key.variantKey}::varchar,
      'PROCESSING', ${bytes}::bigint, ${now}::timestamptz, NOW()
    )
    ON CONFLICT ("team_id", "evidence_part_id", "asset_kind", "variant_key") DO UPDATE
      SET "storage_reserved_bytes" = EXCLUDED."storage_reserved_bytes",
          "storage_reserved_at_utc" = EXCLUDED."storage_reserved_at_utc"`;
}

/**
 * RELEASE an aborted job's reservation (nothing was recorded). A PROCESSING
 * placeholder that never received an object (no storage pointer, no digest)
 * is removed with it: it never described a stored artifact. A row that does
 * describe one keeps everything but the reservation. Idempotent.
 */
export async function releaseDerivedAssetStorageReservation(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset">,
  key: DerivedAssetReservationKey,
): Promise<void> {
  await prisma.evidencePartDerivedAsset.deleteMany({
    where: {
      teamId: key.teamId,
      evidencePartId: key.evidencePartId,
      assetKind: key.assetKind,
      variantKey: key.variantKey,
      status: "PROCESSING",
      storageKey: null,
      derivedSha256: null,
      storageReservedBytes: { not: null },
    },
  });
  await clearOwnDerivedAssetStorageReservationTx(prisma, key);
}

/**
 * Expired reservations already count nothing; this makes the rows say so
 * (and removes expired placeholders that never received an object). Bounded
 * by two statements, safe on either host. Returns the rows touched.
 */
export async function releaseExpiredDerivedAssetStorageReservations(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset">,
  now: Date = new Date(),
): Promise<number> {
  const expired = { storageReservedBytes: { not: null }, storageReservedAtUtc: { lte: derivedAssetReservationLiveSince(now) } };
  const placeholders = await prisma.evidencePartDerivedAsset.deleteMany({
    where: { ...expired, status: "PROCESSING", storageKey: null, derivedSha256: null },
  });
  const cleared = await prisma.evidencePartDerivedAsset.updateMany({
    where: expired,
    data: { storageReservedBytes: null, storageReservedAtUtc: null },
  });
  return placeholders.count + cleared.count;
}
