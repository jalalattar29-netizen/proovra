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
 *      or the written version is unknown), the reservation is NOT released: it
 *      keeps counting the bytes until it expires, and the incident is logged at
 *      error level (a residual bounded by the reservation's TTL).
 * An object already referenced by a row (same pointer and version) is counted
 * by that row: the reservation is simply released.
 */
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import type { DerivedAssetKind } from "@proovra/shared-runtime/media-intelligence";

import { prisma } from "./db.js";
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
  object: { bucket: string; key: string; versionId: string | null };
  /** What was written: enough to keep it counted on its own row. */
  written: { derivedSha256: string; sizeBytes: number; contentType: string | null; engineVersion?: string };
  reason: string;
}): Promise<UnsettledDerivedObjectOutcome> {
  const { key, heldSince, object, written } = input;
  const release = () => releaseDerivedArtifactReservation(key, heldSince);
  const log = { evidenceId: key.evidenceId, assetKind: key.assetKind, variantKey: key.variantKey, reason: input.reason };

  // An object a row already references is counted by that row.
  if (object.versionId) {
    const referenced = await prisma.evidencePartDerivedAsset
      .findFirst({
        where: { storageBucket: object.bucket, storageKey: object.key, storageVersionId: object.versionId },
        select: { id: true },
      })
      .catch(() => null);
    if (referenced) {
      await release();
      return "already_counted";
    }
  }

  // 1. Delete what this attempt wrote, unless a hold is in force (fail closed).
  //    A key-wide delete (version unknown) is attempted only when no row
  //    references the key: it must never remove a counted version.
  let held = true;
  try {
    held = (await evaluateEffectiveLegalHold(prisma, { teamId: key.teamId, evidenceId: key.evidenceId })).held;
  } catch {
    held = true;
  }
  let keyReferenced = false;
  if (!object.versionId) {
    keyReferenced = await prisma.evidencePartDerivedAsset
      .findFirst({ where: { storageBucket: object.bucket, storageKey: object.key }, select: { id: true } })
      .then((r) => Boolean(r))
      .catch(() => true);
  }
  if (!held && !keyReferenced) {
    const removal = await deleteObjectVersions(object).catch(() => null);
    const gone =
      removal != null &&
      (removal.deleted || (Number(removal.failed || 0) === 0 && Number(removal.retainedVersions || 0) === 0 && Number(removal.deletedVersions || 0) === 0));
    if (gone) {
      await release();
      logger.warn(log, "derived.unsettled_object_deleted");
      return "deleted";
    }
  }

  // 2. Keep it counted on its own row (only for a known version: an unknown
  //    one may not exist, and must not be billed as if it did).
  if (object.versionId) {
    try {
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
          storageVersionId: object.versionId,
          lastError: `unsettled_object_retained:${input.reason}`.slice(0, 200),
          ...(written.engineVersion ? { engineVersion: written.engineVersion } : {}),
        },
        prisma,
      );
      if (retained.ok) {
        await release();
        logger.warn({ ...log, retainedAssetId: retained.id }, "derived.unsettled_object_retained");
        return "retained";
      }
    } catch {
      /* fall through: the reservation keeps counting */
    }
  }

  // 3. Neither: the reservation is not released (it keeps counting until it expires).
  logger.error(log, "derived.unsettled_object_reservation_kept");
  return "reservation_kept";
}
