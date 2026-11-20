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
//
// M676 follow-up — a reservation is RENEWED, never outlived. Its time is the
// DATABASE clock (stamped, renewed, metered and expired against NOW()), so no
// host's clock decides whether it still counts. The holder keeps the stamp it
// wrote and renews with `renewDerivedAssetStorageReservation`, fenced on that
// stamp: a reservation that was settled, released, expired or replaced is
// never revived, and the holder stops writing instead. A holder writes only
// before `DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS` ahead of the end of its
// last renewal (measured from before the renewal was sent), so its bytes land
// while the reservation still counts.

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

/**
 * M676 follow-up — how long before the end of its reservation a holder stops
 * writing: every upload request (a part, the completion, a single PUT) is
 * aborted by then, leaving this much time for the settling write.
 */
export const DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS = 3 * 60 * 1000;

/**
 * M676 follow-up — the local epoch-ms by which a holder must have finished
 * writing, given the local time taken BEFORE the stamping statement was sent
 * (so the database stamp can only be later: the deadline is conservative and
 * needs no agreement between the two clocks, only a measured duration).
 */
export function derivedAssetReservationWriteDeadline(sentAtLocalMs: number): number {
  return sentAtLocalMs + DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS - DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS;
}

type MaybeQueryRaw = Partial<Pick<PrismaClient, "$queryRaw">>;

/**
 * M676 follow-up — the database clock, when the client can read it (a mock
 * client without `$queryRaw`, or a failed read, falls back to the caller).
 */
async function databaseNow(client: MaybeQueryRaw): Promise<Date | null> {
  if (typeof client.$queryRaw !== "function") return null;
  try {
    const rows = (await client.$queryRaw`SELECT NOW() AS "now"`) as unknown;
    const value = Array.isArray(rows) ? (rows[0] as { now?: unknown } | undefined)?.now : undefined;
    return value instanceof Date ? value : null;
  } catch {
    return null;
  }
}

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
 *
 * M676 follow-up — without an explicit `now`, liveness is judged on the
 * database clock (the clock that stamped and renewed the reservation).
 */
export async function sumLiveDerivedAssetStorageReservationBytes(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset"> & MaybeQueryRaw,
  input: { teamId: string | null; now?: Date },
): Promise<bigint> {
  if (!input.teamId) return 0n;
  const now = input.now ?? (await databaseNow(prisma)) ?? new Date();
  const agg = await prisma.evidencePartDerivedAsset.aggregate({
    where: {
      teamId: input.teamId,
      storageReservedBytes: { not: null },
      storageReservedAtUtc: { gt: derivedAssetReservationLiveSince(now) },
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
 *
 * M676 follow-up — stamped with the DATABASE clock (millisecond precision, so
 * the stamp a client reads back is exactly the stored value) and returned:
 * the stamp is the holder's fence token for renewal and release.
 */
export async function writeDerivedAssetStorageReservationTx(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  key: DerivedAssetReservationKey,
  bytes: bigint,
): Promise<Date> {
  const rows = (await tx.$queryRaw`
    INSERT INTO "evidence_part_derived_assets" (
      "team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key",
      "status", "storage_reserved_bytes", "storage_reserved_at_utc", "updated_at_utc"
    ) VALUES (
      ${key.teamId}::uuid, ${key.evidenceId}::uuid, ${key.evidencePartId}::uuid,
      ${key.assetKind}::varchar, ${key.variantKey}::varchar,
      'PROCESSING', ${bytes}::bigint, date_trunc('milliseconds', clock_timestamp()), NOW()
    )
    ON CONFLICT ("team_id", "evidence_part_id", "asset_kind", "variant_key") DO UPDATE
      SET "storage_reserved_bytes" = EXCLUDED."storage_reserved_bytes",
          "storage_reserved_at_utc" = EXCLUDED."storage_reserved_at_utc"
    RETURNING "storage_reserved_at_utc" AS "reservedAtUtc"`) as Array<{ reservedAtUtc: Date }>;
  const stamp = rows[0]?.reservedAtUtc;
  if (!(stamp instanceof Date)) throw new Error("derived_storage_reservation_not_written");
  return stamp;
}

/**
 * M676 follow-up — RENEW this holder's reservation: restamp it with the
 * database clock, but only while it is still the reservation this holder
 * wrote (the stamp it holds), still carries its bytes, and has not expired on
 * the database clock. Returns the new stamp, or null when the reservation is
 * gone (settled, released, expired, cleared by the reconciler, or replaced by
 * another attempt): the holder must then stop and write nothing more.
 */
export async function renewDerivedAssetStorageReservation(
  prisma: Pick<PrismaClient, "$queryRaw">,
  key: DerivedAssetReservationKey,
  heldSince: Date,
): Promise<Date | null> {
  const ttlSeconds = DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS / 1000;
  const rows = (await prisma.$queryRaw`
    UPDATE "evidence_part_derived_assets"
       SET "storage_reserved_at_utc" = date_trunc('milliseconds', clock_timestamp())
     WHERE "team_id" = ${key.teamId}::uuid
       AND "evidence_part_id" = ${key.evidencePartId}::uuid
       AND "asset_kind" = ${key.assetKind}::varchar
       AND "variant_key" = ${key.variantKey}::varchar
       AND "storage_reserved_bytes" IS NOT NULL
       AND "storage_reserved_at_utc" = ${heldSince}::timestamptz
       AND "storage_reserved_at_utc" > clock_timestamp() - make_interval(secs => ${ttlSeconds}::double precision)
    RETURNING "storage_reserved_at_utc" AS "reservedAtUtc"`) as Array<{ reservedAtUtc: Date }>;
  const stamp = rows[0]?.reservedAtUtc;
  return stamp instanceof Date ? stamp : null;
}

/**
 * RELEASE an aborted job's reservation (nothing was recorded). A PROCESSING
 * placeholder that never received an object (no storage pointer, no digest)
 * is removed with it: it never described a stored artifact. A row that does
 * describe one keeps everything but the reservation. Idempotent.
 *
 * M676 follow-up — `heldSince` (the holder's stamp) fences the release to the
 * holder's own reservation: an attempt that lost it never releases the
 * reservation of the attempt that replaced it.
 */
export async function releaseDerivedAssetStorageReservation(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset">,
  key: DerivedAssetReservationKey,
  heldSince?: Date | null,
): Promise<void> {
  const own = heldSince ? { storageReservedAtUtc: heldSince } : {};
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
      ...own,
    },
  });
  if (!heldSince) {
    await clearOwnDerivedAssetStorageReservationTx(prisma, key);
    return;
  }
  await prisma.evidencePartDerivedAsset.updateMany({
    where: {
      teamId: key.teamId,
      evidencePartId: key.evidencePartId,
      assetKind: key.assetKind,
      variantKey: key.variantKey,
      storageReservedBytes: { not: null },
      ...own,
    },
    data: { storageReservedBytes: null, storageReservedAtUtc: null },
  });
}

/**
 * Expired reservations already count nothing; this makes the rows say so
 * (and removes expired placeholders that never received an object). Bounded
 * by two statements, safe on either host. Returns the rows touched.
 *
 * M676 follow-up — without an explicit `now`, expiry is judged on the
 * database clock, the clock the holders renew against.
 */
export async function releaseExpiredDerivedAssetStorageReservations(
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset"> & MaybeQueryRaw,
  nowInput?: Date,
): Promise<number> {
  const now = nowInput ?? (await databaseNow(prisma)) ?? new Date();
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
