/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — the projection (Public Verify family).
 *
 * Looks up ONE published package by its id or by the SHA-256 of its exact
 * bytes, and states its identity, digest and seal-key binding
 * (`PublicPackageRecord`, @proovra/shared). Bounded reads only: the package,
 * its seal key's exact registry identity with purpose PACKAGE_SEAL (and the
 * next version of that key, for rotation), the adjacent packages of the same
 * profile, and the other packages of the same issuance. A key registered for
 * any other purpose — the evidence signature — never binds a package.
 */
import {
  PUBLIC_PACKAGE_RECORD_STATEMENT,
  type PublicPackageKeyBinding,
  type PublicPackageProfile,
  type PublicPackageRecord,
} from "@proovra/shared";
import {
  packageProfileLabel,
  publishedPackageWhere,
  publishedProfilePackageWhere,
} from "@proovra/shared-runtime/reports";

import { prisma } from "../../db.js";
import { describePublicSigningKey } from "../../signing/key-registry.js";

const SELECT = {
  id: true,
  evidenceId: true,
  version: true,
  reportVersion: true,
  disclosureProfile: true,
  issuanceId: true,
  packageSha256: true,
  packageFormatVersion: true,
  sealSha256: true,
  sealSigningKeySha256: true,
  sealSigningKeyId: true,
  sealSigningKeyVersion: true,
  supersedesPackageId: true,
  generatedAtUtc: true,
} as const;

type Row = {
  id: string;
  evidenceId: string;
  version: number;
  reportVersion: number | null;
  disclosureProfile: string | null;
  issuanceId: string | null;
  packageSha256: string | null;
  packageFormatVersion: number | null;
  sealSha256: string | null;
  sealSigningKeySha256: string | null;
  sealSigningKeyId: string | null;
  sealSigningKeyVersion: number | null;
  supersedesPackageId: string | null;
  generatedAtUtc: Date | null;
};

/** A published package by its id (any profile). Null for unknown or unpublished. */
export async function findPublishedPackageById(packageId: string): Promise<Row | null> {
  return prisma.verificationPackage.findFirst({ where: publishedPackageWhere({ id: packageId }), select: SELECT });
}

/** A published package by the SHA-256 of its exact bytes (any profile). */
export async function findPublishedPackageBySha256(sha256: string): Promise<Row | null> {
  return prisma.verificationPackage.findFirst({
    where: publishedPackageWhere({ packageSha256: sha256.toLowerCase() }),
    orderBy: { generatedAtUtc: "asc" },
    select: SELECT,
  });
}

export async function projectPublicPackageRecord(row: Row): Promise<PublicPackageRecord> {
  const profile: PublicPackageProfile = packageProfileLabel(row.disclosureProfile);
  const sameProfile = (where: Record<string, unknown>) =>
    row.disclosureProfile === "FULL_FORENSIC" || row.disclosureProfile === "EXTERNAL_DISCLOSURE"
      ? publishedProfilePackageWhere(row.disclosureProfile, { evidenceId: row.evidenceId, ...where })
      : publishedProfilePackageWhere("FULL_FORENSIC", { evidenceId: row.evidenceId, ...where });

  const [previous, next, siblings, sealKey] = await Promise.all([
    row.supersedesPackageId
      ? prisma.verificationPackage.findFirst({
          where: publishedPackageWhere({ id: row.supersedesPackageId }),
          select: { id: true, version: true, reportVersion: true },
        })
      : prisma.verificationPackage.findFirst({
          where: sameProfile({ version: { lt: row.version } }),
          orderBy: { version: "desc" },
          select: { id: true, version: true, reportVersion: true },
        }),
    prisma.verificationPackage.findFirst({
      where: sameProfile({ version: { gt: row.version } }),
      orderBy: { version: "asc" },
      select: { id: true, version: true, reportVersion: true },
    }),
    row.issuanceId
      ? prisma.verificationPackage.findMany({
          where: publishedPackageWhere({ issuanceId: row.issuanceId, id: { not: row.id } }),
          select: { id: true, disclosureProfile: true },
          take: 4,
        })
      : Promise.resolve([] as Array<{ id: string; disclosureProfile: string | null }>),
    row.sealSigningKeyId && row.sealSigningKeyVersion != null
      ? describePublicSigningKey(prisma, {
          keyId: row.sealSigningKeyId,
          version: row.sealSigningKeyVersion,
          purpose: "PACKAGE_SEAL",
        })
      : Promise.resolve(null),
  ]);

  // A recorded seal fingerprint that disagrees with the registered key is not
  // a binding.
  const boundKey =
    sealKey && row.sealSigningKeySha256 && sealKey.fingerprintSha256 === row.sealSigningKeySha256.toLowerCase()
      ? sealKey
      : null;
  const sealed = (row.packageFormatVersion ?? 0) >= 5;
  const keyBinding: PublicPackageKeyBinding = !sealed
    ? "NOT_SEALED"
    : !boundKey
      ? "KEY_NOT_PUBLISHED"
      : boundKey.status === "REVOKED"
        ? "BOUND_KEY_REVOKED"
        : "BOUND";

  return {
    schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
    version: 2,
    packageId: row.id,
    packageIdRecordedInPackage: row.disclosureProfile != null,
    disclosureProfile: profile,
    issuanceId: row.issuanceId ?? null,
    issuedWith: siblings.map((s) => ({ packageId: s.id, disclosureProfile: packageProfileLabel(s.disclosureProfile) })),
    reportVersion: row.reportVersion ?? row.version,
    issuedAtUtc: (row.generatedAtUtc ?? new Date(0)).toISOString(),
    packageSha256: row.packageSha256 ?? null,
    packageFormatVersion: row.packageFormatVersion ?? null,
    sealSha256: row.sealSha256 ?? null,
    sealKeyFingerprintSha256: row.sealSigningKeySha256 ?? null,
    sealKey: boundKey ? { ...boundKey, purpose: "PACKAGE_SEAL" } : null,
    keyBinding,
    supersedes: previous ? { packageId: previous.id, reportVersion: previous.reportVersion ?? previous.version } : null,
    supersededBy: next ? { packageId: next.id, reportVersion: next.reportVersion ?? next.version } : null,
    statement: PUBLIC_PACKAGE_RECORD_STATEMENT,
  };
}
