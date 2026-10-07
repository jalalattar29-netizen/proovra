/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — the contract (2026-10-07).
 *
 * What PROOVRA states, outside the package, about ONE sealed verification
 * package a recipient holds: its identity, its digest, and the registry
 * binding of the key that sealed it. Served by the Public Verify family
 * (`GET /public/verification-packages/:packageId` and `/by-sha256/:sha256`)
 * and rendered by the Public Verify package page. One type for both.
 *
 * Bounded: it describes the looked-up package, its seal key's exact registry
 * identity (purpose PACKAGE_SEAL), the adjacent packages of the same profile,
 * and the other packages of the same issuance — never the key inventory,
 * never evidence content, never workspace or owner data.
 */

export type PublicPackageProfile = "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE" | "LEGACY";

export type PublicPackageKeyStatus = "ACTIVE" | "SUPERSEDED" | "REVOKED";

/**
 *   BOUND               the seal key is registered by PROOVRA for package
 *                       sealing, not revoked.
 *   BOUND_KEY_REVOKED   registered, and revoked since (the record states when).
 *   KEY_NOT_PUBLISHED   the package's seal key is not in the registry for
 *                       package sealing (packages issued before seal keys were
 *                       registered). Not a binding.
 *   NOT_SEALED          a package issued before sealing existed.
 */
export type PublicPackageKeyBinding = "BOUND" | "BOUND_KEY_REVOKED" | "KEY_NOT_PUBLISHED" | "NOT_SEALED";

export type PublicPackageSealKey = {
  purpose: "PACKAGE_SEAL";
  algorithm: "Ed25519";
  keyId: string;
  version: number;
  fingerprintSha256: string;
  status: PublicPackageKeyStatus;
  validFromUtc: string;
  validUntilUtc: string | null;
  revokedAtUtc: string | null;
  supersededByVersion: number | null;
};

export type PublicPackageRecord = {
  schema: "PROOVRA_PUBLIC_PACKAGE_RECORD";
  version: 2;
  packageId: string;
  /** False for a legacy package (issued before ids were sealed inside it). */
  packageIdRecordedInPackage: boolean;
  disclosureProfile: PublicPackageProfile;
  /** The issuance that issued this package, when recorded. */
  issuanceId: string | null;
  /** The other packages issued with it (one per profile). */
  issuedWith: Array<{ packageId: string; disclosureProfile: PublicPackageProfile }>;
  reportVersion: number;
  issuedAtUtc: string;
  packageSha256: string | null;
  packageFormatVersion: number | null;
  sealSha256: string | null;
  sealKeyFingerprintSha256: string | null;
  sealKey: PublicPackageSealKey | null;
  keyBinding: PublicPackageKeyBinding;
  /** The previous / next published package of the SAME profile for this record. */
  supersedes: { packageId: string; reportVersion: number } | null;
  supersededBy: { packageId: string; reportVersion: number } | null;
  statement: string;
};

export const PUBLIC_PACKAGE_RECORD_STATEMENT =
  "PROOVRA's record of this package's identity, digest and seal key. It does not verify the package for you: recompute the package's SHA-256 and check its seal with the commands in its README. A matching record says the package is the one PROOVRA issued; it is not a finding about the evidence.";

export const PUBLIC_PACKAGE_KEY_BINDING_TEXT: Readonly<Record<PublicPackageKeyBinding, string>> = {
  BOUND: "The seal key is registered by PROOVRA for package sealing and is not revoked.",
  BOUND_KEY_REVOKED: "The seal key is registered by PROOVRA for package sealing and was revoked after this package was issued.",
  KEY_NOT_PUBLISHED: "This package's seal key is not registered by PROOVRA for package sealing. Its seal can still be checked against the key the package ships, but that key is not bound to PROOVRA.",
  NOT_SEALED: "This package was issued before packages were sealed. Its manifest signature does not cover every file.",
};
