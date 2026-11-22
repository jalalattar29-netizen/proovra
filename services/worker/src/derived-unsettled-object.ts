/**
 * M676 follow-up — A DERIVED OBJECT THAT WAS WRITTEN BUT NEVER SETTLED.
 *
 * A derived producer reserves its bytes (M676), writes the object under the
 * record's artifact lock, then settles the row (`recordDerivedAsset`
 * COMPLETED), which turns the reservation into counted stored bytes. When the
 * write happened (or may have happened) but the settle did not — the settling
 * write failed, the claim or the reservation was lost before it, or the
 * completion's answer was lost — the producer used to release the reservation
 * and try a best-effort delete whose failure was swallowed. Under Object Lock
 * that delete always fails, so stored bytes stopped being counted.
 *
 * Never silently release. In order:
 *   1. DELETED — the version this attempt wrote is removed (no hold, nothing
 *      references it) and the store's listing proves it gone: the reservation
 *      is released (it reserved nothing that still exists).
 *   2. RETAINED — otherwise the object is kept COUNTED: it is recorded on its
 *      own FAILED row (variant `<variant>~u<sha12>`, the canonical row is not
 *      touched) carrying its pointer, version and size, so both meters count
 *      it (`sumDerivedAssetStorageBytes` counts every row with a pointer) and
 *      destruction sweeps it with the record. The reservation is then released.
 *   3. KEPT — if neither is possible (the database refused the retained row,
 *      or the written version is unknown), the reservation is NOT released.
 * An object already referenced by a row (same pointer and version) is counted
 * by that row: the reservation is simply released.
 *
 * FINAL-VERIFY-2 closure — with the holder's durable INTENT (every worker
 * producer declares one when it reserves), "kept" no longer ends when the
 * reservation lapses: the OPEN intent keeps the bytes counted until the
 * reconciler (derived-storage-intent) proves them deleted, adopts them, or
 * proves the key holds nothing unreferenced after every write window closed.
 *   - DELETED of a KNOWN version resolves the intent DELETED;
 *   - RETAINED is one transaction: the retained row and the intent's
 *     resolution (ADOPTED), so a database that refuses one refuses both and
 *     the intent still counts (failure case (a));
 *   - a key-wide delete for an UNKNOWN version (a lost upload answer) never
 *     resolves the intent: the lost request may still land after it; and a
 *     held unknown version (failure case (b)) is left to the reconciler,
 *     which finds and adopts it by listing;
 *   - a database that cannot be read fails CLOSED (nothing deleted).
 */
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import { redeclareDerivedAssetStorageIntentIfUnreliable, resolveDerivedAssetStorageIntentsTx } from "@proovra/shared-runtime";
import type { DerivedAssetKind } from "@proovra/shared-runtime/media-intelligence";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db.js";
import {
  DERIVED_DISPOSAL_TRANSACTION_MS,
  adoptDerivedObjectVersionsTx,
  boundedTransaction,
} from "./derived-storage-intent.js";
import { logger } from "./logger.js";
import { deleteObjectVersions } from "./storage.js";
import { releaseDerivedArtifactReservation } from "./workspace-billing.js";

type ReservationKey = Parameters<typeof releaseDerivedArtifactReservation>[0];

export type UnsettledDerivedObjectOutcome = "already_counted" | "deleted" | "retained" | "reservation_kept";

/** The variant of the row that keeps an unsettled object counted (≤ 64 chars). */
export function unsettledDerivedVariantKey(variantKey: string, derivedSha256: string): string {
  return `${variantKey.slice(0, 48)}~u${derivedSha256.slice(0, 12)}`;
}

export async function disposeUnsettledDerivedObject(input: {
  key: ReservationKey;
  /** The holder's reservation stamp (its fence token), when it holds one. */
  heldSince: Date | null;
  /** FINAL-VERIFY-2 closure — the holder's durable intent, when it declared one. */
  intentId?: string | null;
  object: { bucket: string; key: string; versionId: string | null };
  /** What was written: enough to keep it counted on its own row. */
  written: { derivedSha256: string; sizeBytes: number; contentType: string | null; engineVersion?: string };
  reason: string;
  /** Test seam: the database client (defaults to the worker's). */
  client?: PrismaClient;
}): Promise<UnsettledDerivedObjectOutcome> {
  const { key, heldSince, object, written } = input;
  const db = (input.client ?? prisma) as PrismaClient;
  const intentId = input.intentId ?? null;
  const release = () => releaseDerivedArtifactReservation(key, heldSince);
  const log = { evidenceId: key.evidenceId, assetKind: key.assetKind, variantKey: key.variantKey, reason: input.reason };
  const resolveIntent = async (state: "DELETED" | "ADOPTED", resolution: string) => {
    if (!intentId) return;
    await resolveDerivedAssetStorageIntentsTx(db, { intentIds: [intentId], state, resolution, resolvedBytes: 0 }).catch(
      () => undefined, // still OPEN: over-counted until the reconciler proves it
    );
  };
  // closure3/store (FV2-RESIDUAL-2) — bytes that may still exist, recorded on
  // no row, whose intent was already resolved (or is being judged, or whose
  // write window ended) are declared again on a fresh OPEN intent: a late
  // write is never left uncounted while this holder is alive to say so.
  const redeclare = async (): Promise<string | null> => {
    if (!intentId) return null;
    return redeclareDerivedAssetStorageIntentIfUnreliable(db, { intentId, bytes: written.sizeBytes }).catch(() => null);
  };

  // An object a row already references is counted by that row. A database
  // that cannot answer decides nothing (fail closed: no delete, no release).
  // A row that references the KEY with no version (a legacy row, or an
  // unversioned store's "null") may count this very object: it is never
  // deleted, and an unversioned overwrite is counted by that row.
  let keyCountedWithoutVersion = false;
  if (object.versionId) {
    let referenced: { id: string } | null;
    try {
      referenced = await db.evidencePartDerivedAsset.findFirst({
        where: { storageBucket: object.bucket, storageKey: object.key, storageVersionId: object.versionId },
        select: { id: true },
      });
      keyCountedWithoutVersion = Boolean(
        await db.evidencePartDerivedAsset.findFirst({
          where: {
            storageBucket: object.bucket,
            storageKey: object.key,
            OR: [{ storageVersionId: null }, { storageVersionId: "null" }],
          },
          select: { id: true },
        }),
      );
    } catch {
      logger.error(log, "derived.unsettled_object_reservation_kept");
      return "reservation_kept";
    }
    if (referenced || (keyCountedWithoutVersion && object.versionId === "null")) {
      await resolveIntent("ADOPTED", referenced ? "already_counted" : "counted_by_key_reference");
      await release();
      return "already_counted";
    }
  }

  // 1. Delete what this attempt wrote, unless a hold is in force (fail closed).
  //    A key-wide delete (version unknown) is attempted only when no row
  //    references the key and no OTHER attempt's intent targets it: it must
  //    never remove a counted version or a version another holder may settle.
  let held = true;
  try {
    held = (await evaluateEffectiveLegalHold(db as never, { teamId: key.teamId, evidenceId: key.evidenceId })).held;
  } catch {
    held = true;
  }
  let keyReferenced = false;
  if (!object.versionId) {
    keyReferenced = await db.evidencePartDerivedAsset
      .findFirst({ where: { storageBucket: object.bucket, storageKey: object.key }, select: { id: true } })
      .then((r) => Boolean(r))
      .catch(() => true);
    if (!keyReferenced && intentId && typeof db.derivedAssetStorageIntent?.findFirst === "function") {
      keyReferenced = await db.derivedAssetStorageIntent
        .findFirst({
          where: { storageBucket: object.bucket, storageKey: object.key, state: "OPEN", id: { not: intentId } },
          select: { id: true },
        })
        .then((r) => Boolean(r))
        .catch(() => true);
    }
  }
  if (!held && !keyReferenced && !keyCountedWithoutVersion) {
    const removal = await deleteObjectVersions(object).catch(() => null);
    const gone =
      removal != null &&
      (removal.deleted || (Number(removal.failed || 0) === 0 && Number(removal.retainedVersions || 0) === 0 && Number(removal.deletedVersions || 0) === 0));
    if (gone) {
      // A known version is proven gone: its intent is resolved. An UNKNOWN
      // version (a lost answer) may still land after this delete: the intent
      // stays OPEN, counted, for the reconciler to judge after the grace.
      if (object.versionId) await resolveIntent("DELETED", "holder_deleted_own_version");
      const redeclaredIntentId = object.versionId ? null : await redeclare();
      await release();
      logger.warn({ ...log, intentKept: !object.versionId && Boolean(intentId), redeclaredIntentId }, "derived.unsettled_object_deleted");
      return "deleted";
    }
  }

  // 2. Keep it counted on its own row (only for a known version: an unknown
  //    one may not exist, and must not be billed as if it did).
  if (object.versionId) {
    const versionId = object.versionId;
    try {
      let retainedId: string | null = null;
      if (intentId) {
        // One transaction: the retained row AND the intent's resolution.
        const ids = await boundedTransaction(db, Date.now() + DERIVED_DISPOSAL_TRANSACTION_MS, (tx, bound) =>
          adoptDerivedObjectVersionsTx(tx, {
            owner: key,
            versions: [
              {
                bucket: object.bucket,
                key: object.key,
                versionId,
                sizeBytes: written.sizeBytes,
                variantKey: unsettledDerivedVariantKey(key.variantKey, written.derivedSha256),
              },
            ],
            derivedSha256: written.derivedSha256,
            contentType: written.contentType,
            engineVersion: written.engineVersion,
            reason: input.reason,
            intentIds: [intentId],
            state: "ADOPTED",
            bound,
          }),
        );
        retainedId = ids[0] ?? null;
      } else {
        const { recordDerivedAsset } = await import("@proovra/shared-runtime/media-intelligence");
        const retained = await recordDerivedAsset(
          {
            teamId: key.teamId,
            evidenceId: key.evidenceId,
            evidencePartId: key.evidencePartId,
            assetKind: key.assetKind as DerivedAssetKind,
            status: "FAILED",
            variantKey: unsettledDerivedVariantKey(key.variantKey, written.derivedSha256),
            derivedSha256: written.derivedSha256,
            sizeBytes: written.sizeBytes,
            contentType: written.contentType,
            storageBucket: object.bucket,
            storageKey: object.key,
            storageVersionId: versionId,
            lastError: `unsettled_object_retained:${input.reason}`.slice(0, 200),
            ...(written.engineVersion ? { engineVersion: written.engineVersion } : {}),
          },
          db,
        );
        retainedId = retained.ok ? retained.id : null;
      }
      if (retainedId) {
        await release();
        logger.warn({ ...log, retainedAssetId: retainedId }, "derived.unsettled_object_retained");
        return "retained";
      }
    } catch {
      /* fall through: the intent (or the reservation) keeps counting */
    }
  }

  // 3. Neither: nothing is released. With an intent, it keeps counting past
  //    the reservation's TTL until the reconciler resolves it; an intent that
  //    can no longer be relied on to find these bytes is declared again.
  const redeclaredIntentId = await redeclare();
  logger.error({ ...log, intentKept: Boolean(intentId), redeclaredIntentId }, "derived.unsettled_object_reservation_kept");
  return "reservation_kept";
}
