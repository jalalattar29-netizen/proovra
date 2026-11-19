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

import type { PrismaClient } from "@prisma/client";

export type DerivedStorageScope = {
  /** The workspace Team (a personal Team for a personal scope), or null. */
  teamId: string | null;
};

export async function sumDerivedAssetStorageBytes(
  // AUD-0017 — any client with the delegate, so a transaction can pass its own.
  prisma: Pick<PrismaClient, "evidencePartDerivedAsset">,
  scope: DerivedStorageScope,
): Promise<bigint> {
  if (!scope.teamId) return 0n;
  const agg = await prisma.evidencePartDerivedAsset.aggregate({
    where: { teamId: scope.teamId, storageKey: { not: null } },
    _sum: { sizeBytes: true },
  });
  const raw = agg?._sum?.sizeBytes ?? 0;
  return BigInt(Math.trunc(Number(raw)));
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
