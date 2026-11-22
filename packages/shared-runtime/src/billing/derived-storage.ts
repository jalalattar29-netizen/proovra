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
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset"> &
    Partial<Pick<PrismaClient, "derivedAssetStorageIntent">> &
    MaybeQueryRaw,
  input: { teamId: string | null; now?: Date },
): Promise<bigint> {
  if (!input.teamId) return 0n;
  const now = input.now ?? (await databaseNow(prisma)) ?? new Date();
  const [agg, intents] = await Promise.all([
    prisma.evidencePartDerivedAsset.aggregate({
      where: {
        teamId: input.teamId,
        storageReservedBytes: { not: null },
        storageReservedAtUtc: { gt: derivedAssetReservationLiveSince(now) },
        // FINAL-VERIFY-2 closure — a reservation that belongs to an intent is
        // counted through that intent (below), never twice.
        storageReservationToken: null,
      },
      _sum: { storageReservedBytes: true },
    }),
    sumOpenDerivedAssetStorageIntentBytes(prisma, input.teamId),
  ]);
  const raw = agg?._sum?.storageReservedBytes ?? 0;
  const rows = typeof raw === "bigint" ? raw : BigInt(Math.max(0, Math.trunc(Number(raw))));
  return rows + intents;
}

/**
 * FINAL-VERIFY-2 closure — bytes held by OPEN derived write intents of this
 * workspace Team. An OPEN intent counts WHATEVER the age of its reservation:
 * expiry, replacement or release of the reservation never frees bytes that a
 * declared write may have stored. Only proof (settle, delete, adopt, absence
 * after every write window closed) resolves it.
 */
export async function sumOpenDerivedAssetStorageIntentBytes(
  prisma: Partial<Pick<PrismaClient, "derivedAssetStorageIntent">>,
  teamId: string | null,
): Promise<bigint> {
  if (!teamId) return 0n;
  // A client without the delegate (a narrow unit-test double) has no intents.
  if (typeof prisma.derivedAssetStorageIntent?.aggregate !== "function") return 0n;
  const agg = await prisma.derivedAssetStorageIntent.aggregate({
    where: { teamId, state: "OPEN" },
    _sum: { reservedBytes: true },
  });
  const raw = agg?._sum?.reservedBytes ?? 0;
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
  return (await writeDerivedAssetStorageReservationHeldTx(tx, key, bytes, null)).reservedAtUtc;
}

/**
 * FINAL-VERIFY-2 closure — the object a holder declares it will write. Every
 * worker producer knows its (content-addressed) key before it reserves.
 */
export type DerivedAssetWriteTarget = {
  bucket: string;
  key: string;
  derivedSha256?: string | null;
  contentType?: string | null;
};

/**
 * FINAL-VERIFY-2 closure — `writeDerivedAssetStorageReservationTx` for a
 * holder that DECLARES its write target: the same statement also writes the
 * attempt's durable intent (`derived_asset_storage_intents`, OPEN, the same
 * database stamp) and names it on the row (`storage_reservation_token`). The
 * intent exists before any byte is sent and outlives the reservation: it is
 * what keeps possibly-stored bytes counted when the settle, the fallback, the
 * upload's answer or the database fails. Without a target the reservation is
 * the plain M676 one (no intent, counted by the row while live).
 */
export async function writeDerivedAssetStorageReservationHeldTx(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  key: DerivedAssetReservationKey,
  bytes: bigint,
  target: DerivedAssetWriteTarget | null,
): Promise<{ reservedAtUtc: Date; intentId: string | null }> {
  const rows = (
    target
      ? await tx.$queryRaw`
    WITH intent AS (
      INSERT INTO "derived_asset_storage_intents" (
        "team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key",
        "reserved_bytes", "storage_bucket", "storage_key", "derived_sha256", "content_type",
        "holder_stamp_utc"
      ) VALUES (
        ${key.teamId}::uuid, ${key.evidenceId}::uuid, ${key.evidencePartId}::uuid,
        ${key.assetKind}::varchar, ${key.variantKey}::varchar,
        ${bytes}::bigint, ${target.bucket}::varchar, ${target.key}::varchar,
        ${target.derivedSha256 ?? null}::varchar, ${target.contentType?.slice(0, 80) ?? null}::varchar,
        date_trunc('milliseconds', clock_timestamp())
      )
      RETURNING "id", "holder_stamp_utc"
    )
    INSERT INTO "evidence_part_derived_assets" (
      "team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key",
      "status", "storage_reserved_bytes", "storage_reserved_at_utc", "storage_reservation_token", "updated_at_utc"
    )
    SELECT ${key.teamId}::uuid, ${key.evidenceId}::uuid, ${key.evidencePartId}::uuid,
           ${key.assetKind}::varchar, ${key.variantKey}::varchar,
           'PROCESSING', ${bytes}::bigint, i."holder_stamp_utc", i."id", NOW()
      FROM intent i
    ON CONFLICT ("team_id", "evidence_part_id", "asset_kind", "variant_key") DO UPDATE
      SET "storage_reserved_bytes" = EXCLUDED."storage_reserved_bytes",
          "storage_reserved_at_utc" = EXCLUDED."storage_reserved_at_utc",
          "storage_reservation_token" = EXCLUDED."storage_reservation_token"
    RETURNING "storage_reserved_at_utc" AS "reservedAtUtc", "storage_reservation_token"::text AS "intentId"`
      : await tx.$queryRaw`
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
          "storage_reserved_at_utc" = EXCLUDED."storage_reserved_at_utc",
          "storage_reservation_token" = NULL
    RETURNING "storage_reserved_at_utc" AS "reservedAtUtc", NULL::text AS "intentId"`
  ) as Array<{ reservedAtUtc: Date; intentId: string | null }>;
  const stamp = rows[0]?.reservedAtUtc;
  if (!(stamp instanceof Date)) throw new Error("derived_storage_reservation_not_written");
  const intentId = rows[0]?.intentId ?? null;
  if (target && !intentId) throw new Error("derived_storage_intent_not_written");
  return { reservedAtUtc: stamp, intentId };
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
  // FINAL-VERIFY-2 closure — the holder's intent is renewed in the same
  // statement (its stamp bounds the holder's write window for the
  // reconciler), and a reservation whose intent is no longer OPEN is never
  // renewed.
  const rows = (await prisma.$queryRaw`
    WITH renewed AS (
      UPDATE "evidence_part_derived_assets" d
         SET "storage_reserved_at_utc" = date_trunc('milliseconds', clock_timestamp())
       WHERE d."team_id" = ${key.teamId}::uuid
         AND d."evidence_part_id" = ${key.evidencePartId}::uuid
         AND d."asset_kind" = ${key.assetKind}::varchar
         AND d."variant_key" = ${key.variantKey}::varchar
         AND d."storage_reserved_bytes" IS NOT NULL
         AND d."storage_reserved_at_utc" = ${heldSince}::timestamptz
         AND d."storage_reserved_at_utc" > clock_timestamp() - make_interval(secs => ${ttlSeconds}::double precision)
         AND (d."storage_reservation_token" IS NULL OR EXISTS (
               SELECT 1 FROM "derived_asset_storage_intents" i
                WHERE i."id" = d."storage_reservation_token" AND i."state" = 'OPEN'))
      RETURNING d."storage_reserved_at_utc", d."storage_reservation_token"
    ), intent AS (
      UPDATE "derived_asset_storage_intents" i
         SET "holder_stamp_utc" = r."storage_reserved_at_utc"
        FROM renewed r
       WHERE i."id" = r."storage_reservation_token" AND i."state" = 'OPEN'
      RETURNING i."id"
    )
    SELECT r."storage_reserved_at_utc" AS "reservedAtUtc" FROM renewed r`) as Array<{ reservedAtUtc: Date }>;
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

// =============================================================================
// FINAL-VERIFY-2 closure — DURABLE WRITE INTENTS AND THEIR RECONCILIATION
// =============================================================================
//
// A reservation stops counting at its TTL; bytes a write may have stored must
// not. Every worker producer declares its write target when it reserves
// (`writeDerivedAssetStorageReservationHeldTx`), which writes an OPEN intent
// in the same statement. The intent is counted by both meters until one of:
//   SETTLED  — the canonical row recorded the object in the same transaction
//              (fenced on the live reservation and on the intent still OPEN);
//   RELEASED — the holder never started a write;
//   DELETED  — the holder's own version was removed, proven by listing;
//   ADOPTED  — the stored version(s) are counted on their own retained rows,
//              in the same transaction that resolves the intent;
//   ABSENT   — after every holder's write window on that key had closed, the
//              reconciler aborted incomplete multipart uploads and listed the
//              key: nothing unreferenced is stored.
// Resolution is conditional on `state = 'OPEN'` (and on the reconciler's own
// lease token): exactly one resolver wins, so a stalled holder whose intent
// was reconciled cannot settle afterwards, and vice versa.

/**
 * How long after a holder's last reservation stamp has expired the
 * reconciler waits before it judges the key by listing. Every holder write is
 * aborted DERIVED_ASSET_RESERVATION_SAFETY_MARGIN_MS before its reservation
 * would lapse and the settle is bounded by the database to the reservation's
 * end; the grace covers a request whose body was fully sent just before its
 * abort and that the store commits a moment later.
 */
export const DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS = 5 * 60 * 1000;

/** Terminal intent states (anything but OPEN). */
export type DerivedAssetIntentResolution = "SETTLED" | "RELEASED" | "DELETED" | "ADOPTED" | "ABSENT";

/**
 * Resolve OPEN intents, conditionally: only rows still OPEN (and, for the
 * reconciler, still leased to `reconcileToken`) are touched. Returns how many
 * were resolved; a caller that needs all of them treats fewer as a lost fence.
 */
export async function resolveDerivedAssetStorageIntentsTx(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    intentIds: string[];
    state: DerivedAssetIntentResolution;
    resolution: string;
    resolvedBytes?: bigint | number | null;
    resolvedAssetId?: string | null;
    reconcileToken?: string | null;
  },
): Promise<number> {
  if (input.intentIds.length === 0) return 0;
  const bytes = input.resolvedBytes == null ? null : BigInt(input.resolvedBytes);
  const rows = (await tx.$queryRaw`
    UPDATE "derived_asset_storage_intents"
       SET "state" = ${input.state}::varchar,
           "resolution" = ${input.resolution.slice(0, 200)}::varchar,
           "resolved_bytes" = ${bytes}::bigint,
           "resolved_asset_id" = ${input.resolvedAssetId ?? null}::uuid,
           "resolved_at_utc" = clock_timestamp(),
           "reconcile_lease_until" = NULL
     WHERE "id" = ANY(${input.intentIds}::uuid[])
       AND "state" = 'OPEN'
       AND (${input.reconcileToken ?? null}::uuid IS NULL OR "reconcile_token" = ${input.reconcileToken ?? null}::uuid)
    RETURNING "id"`) as Array<{ id: string }>;
  return rows.length;
}

/** An OPEN intent as the reconciler sees it. */
export type ReconcilableDerivedAssetStorageIntent = {
  id: string;
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: string;
  variantKey: string;
  reservedBytes: bigint;
  storageBucket: string;
  storageKey: string;
  derivedSha256: string | null;
  contentType: string | null;
  /**
   * The holder's last reservation stamp (database clock). Its write window
   * ended by holderStampUtc + TTL: anything the store shows as created later
   * on the same key is NOT this holder's (a content-addressed retry).
   */
  holderStampUtc: Date;
};

/**
 * CLAIM intents the reconciler may judge: OPEN, the holder's last stamp older
 * than the TTL plus `graceMs` (database clock), and NO other OPEN intent on
 * the same object key whose holder could still be writing or that another
 * reconciler holds. Claims are serialized (one advisory lock for the claim
 * statement) and leased to `token` until `leaseMs` from now; the resolution is
 * fenced on that token.
 */
export async function claimReconcilableDerivedAssetStorageIntents(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { token: string; limit: number; leaseMs: number; graceMs?: number },
): Promise<ReconcilableDerivedAssetStorageIntent[]> {
  const staleSeconds = (DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS + (input.graceMs ?? DERIVED_ASSET_INTENT_RECONCILE_GRACE_MS)) / 1000;
  const leaseSeconds = Math.max(1, input.leaseMs / 1000);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('derived-asset-storage-intent-claim'))`;
    const rows = (await tx.$queryRaw`
      WITH eligible AS (
        SELECT i."id"
          FROM "derived_asset_storage_intents" i
         WHERE i."state" = 'OPEN'
           AND i."holder_stamp_utc" <= clock_timestamp() - make_interval(secs => ${staleSeconds}::double precision)
           AND (i."reconcile_lease_until" IS NULL OR i."reconcile_lease_until" < clock_timestamp())
           AND NOT EXISTS (
             SELECT 1 FROM "derived_asset_storage_intents" o
              WHERE o."storage_bucket" = i."storage_bucket"
                AND o."storage_key" = i."storage_key"
                AND o."state" = 'OPEN'
                AND o."id" <> i."id"
                AND (o."holder_stamp_utc" > clock_timestamp() - make_interval(secs => ${staleSeconds}::double precision)
                     OR o."reconcile_lease_until" >= clock_timestamp()))
         ORDER BY i."holder_stamp_utc" ASC
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "derived_asset_storage_intents" t
         SET "reconcile_token" = ${input.token}::uuid,
             "reconcile_lease_until" = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
             "reconcile_attempts" = t."reconcile_attempts" + 1
        FROM eligible e
       WHERE t."id" = e."id"
      RETURNING t."id"::text AS "id", t."team_id"::text AS "teamId", t."evidence_id"::text AS "evidenceId",
                t."evidence_part_id"::text AS "evidencePartId", t."asset_kind" AS "assetKind",
                t."variant_key" AS "variantKey", t."reserved_bytes" AS "reservedBytes",
                t."storage_bucket" AS "storageBucket", t."storage_key" AS "storageKey",
                t."derived_sha256" AS "derivedSha256", t."content_type" AS "contentType",
                t."holder_stamp_utc" AS "holderStampUtc"`) as ReconcilableDerivedAssetStorageIntent[];
    return rows.map((r) => ({ ...r, reservedBytes: BigInt(r.reservedBytes as unknown as bigint) }));
  });
}

/**
 * closure3/store (FV2-RESIDUAL-2) — RE-DECLARE a holder's write target when the
 * holder still has bytes that may exist (a disposal that could neither delete
 * nor record them) but its intent can no longer be relied on to find them:
 *   - the intent was resolved ABSENT or DELETED: the reconciler judged it on
 *     a listing taken BEFORE this holder's late write landed (a holder frozen
 *     past its write margin plus the grace), so nothing counts the object;
 *   - a reconciler holds its lease right now: its listing may predate the
 *     landing, and it may resolve the intent after this statement;
 *   - the holder's write window (last stamp + TTL) has ended: a version that
 *     landed after it looks "fresh" to the reconciler, which would keep the
 *     intent OPEN forever instead of judging it.
 * In each case a NEW OPEN intent on the same key is written, stamped now
 * (database clock), counting `bytes`; the reconciler judges it (with any
 * other OPEN intent on the key) after its own TTL + grace, finds the version
 * and deletes or adopts it. Otherwise nothing is written: the OPEN intent
 * still counts and its listing will see what landed inside its window.
 * Never when the bytes are already counted (closure3 review L2): an intent
 * SETTLED or ADOPTED (an adoption that committed but whose answer was lost),
 * RELEASED (no write ever started), or a row that already references this
 * very version.
 * Returns the new intent id, or null when none was needed.
 */
export async function redeclareDerivedAssetStorageIntentIfUnreliable(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: { intentId: string; bytes: bigint | number; versionId?: string | null },
): Promise<string | null> {
  const ttlSeconds = DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS / 1000;
  const bytes = BigInt(Math.max(0, Math.trunc(Number(input.bytes))));
  const rows = (await prisma.$queryRaw`
    INSERT INTO "derived_asset_storage_intents" (
      "team_id", "evidence_id", "evidence_part_id", "asset_kind", "variant_key",
      "reserved_bytes", "storage_bucket", "storage_key", "derived_sha256", "content_type",
      "holder_stamp_utc"
    )
    SELECT i."team_id", i."evidence_id", i."evidence_part_id", i."asset_kind", i."variant_key",
           ${bytes}::bigint, i."storage_bucket", i."storage_key", i."derived_sha256", i."content_type",
           date_trunc('milliseconds', clock_timestamp())
      FROM "derived_asset_storage_intents" i
     WHERE i."id" = ${input.intentId}::uuid
       AND (i."state" IN ('ABSENT', 'DELETED')
            OR (i."state" = 'OPEN'
                AND (i."reconcile_lease_until" >= clock_timestamp()
                     OR i."holder_stamp_utc" <= clock_timestamp() - make_interval(secs => ${ttlSeconds}::double precision))))
       AND NOT EXISTS (
             SELECT 1 FROM "evidence_part_derived_assets" d
              WHERE d."storage_bucket" = i."storage_bucket"
                AND d."storage_key" = i."storage_key"
                AND ${input.versionId ?? null}::varchar IS NOT NULL
                AND d."storage_version_id" = ${input.versionId ?? null}::varchar)
    RETURNING "id"::text AS "id"`) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Record why a claimed intent could not be resolved this tick (it stays OPEN,
 * still counted) and give the lease back, so a later tick judges the key
 * again as soon as the claim rules allow (never while another holder of the
 * key is live).
 */
export async function noteDerivedAssetStorageIntentReconcileError(
  prisma: Pick<PrismaClient, "$executeRaw">,
  input: { intentIds: string[]; token: string; error: string },
): Promise<void> {
  if (input.intentIds.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "derived_asset_storage_intents"
       SET "last_reconcile_error" = ${input.error.slice(0, 200)}::varchar,
           "reconcile_lease_until" = NULL
     WHERE "id" = ANY(${input.intentIds}::uuid[]) AND "state" = 'OPEN' AND "reconcile_token" = ${input.token}::uuid`;
}
