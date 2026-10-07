import {
  packageProfileLabel,
  primaryPublishedPackageWhere,
  type VerificationPackageProfileLabel,
} from "@proovra/shared-runtime/reports";

import { prisma } from "../../db.js";

export async function listEvidenceArtifacts(evidenceId: string) {
  const [reports, verificationPackages] = await Promise.all([
    prisma.report.findMany({
      where: { evidenceId },
      orderBy: [{ version: "desc" }],
      select: {
        id: true,
        version: true,
        generatedAtUtc: true,
        sizeBytes: true,
        storageObjectLockMode: true,
      },
    }),
    // "The package" of each version: the published primary package.
    prisma.verificationPackage.findMany({
      where: primaryPublishedPackageWhere({ evidenceId }),
      orderBy: [{ version: "desc" }],
      select: {
        id: true,
        version: true,
        generatedAtUtc: true,
        packageType: true,
        sizeBytes: true,
        storageObjectLockMode: true,
        reportVersion: true,
        packageFormatVersion: true,
      },
    }),
  ]);
  // "Latest" for a package means: paired with the latest REPORT (2026-09-29).
  const newestReportVersion = reports[0]?.version ?? null;

  return {
    reports: reports.map((item, index) => ({
      id: item.id,
      version: item.version,
      generatedAtUtc: item.generatedAtUtc.toISOString(),
      sizeBytes: item.sizeBytes?.toString() ?? null,
      immutableRecorded: Boolean(item.storageObjectLockMode),
      latest: index === 0,
    })),
    verificationPackages: verificationPackages.map((item) => ({
      id: item.id,
      version: item.version,
      generatedAtUtc: item.generatedAtUtc?.toISOString() ?? null,
      packageType: item.packageType ?? null,
      sizeBytes: item.sizeBytes?.toString() ?? null,
      immutableRecorded: Boolean(item.storageObjectLockMode),
      /** The report version this package certifies (legacy rows: its own version). */
      certifiesReportVersion: item.reportVersion ?? item.version,
      sealed: (item.packageFormatVersion ?? 0) >= 5,
      latest:
        newestReportVersion !== null &&
        (item.reportVersion ?? item.version) === newestReportVersion,
    })),
  };
}

/**
 * ONE REPORT VERSION AND ITS PACKAGE ARTIFACTS — THE history the Artifacts &
 * Versions tab renders (and native reads).
 *
 * Every sealed package is its own artifact (2026-10-07): per report version,
 * the PRIMARY package (FULL_FORENSIC, or a legacy row) and the
 * EXTERNAL_DISCLOSURE package, each with its own package id, digest, seal key
 * and supersession. They belong to the report version they record in
 * `report_version` (enforced by the RGA-05 foreign key); a legacy package with
 * no recorded report version is paired by its own version number and says so.
 * A package whose report row does not exist is listed separately, never
 * attached to some other report.
 *
 * Only PUBLISHED rows are packages. A profile still being issued, or whose
 * last attempt failed, is reported as its lifecycle state (`issuance`) — never
 * as a package.
 *
 * No storage key, bucket or signed URL leaves this function. Digests are the
 * SHA-256 of the stored bytes, which a verifier is meant to compare.
 */
export type MatchedArtifactPackage = {
  /** THE package identity (the row id, carried inside packages since 2026-10-07). */
  packageId: string;
  /** FULL_FORENSIC | EXTERNAL_DISCLOSURE, or LEGACY (issued before profiles). */
  disclosureProfile: VerificationPackageProfileLabel;
  /** The issuance (report-generation request) that issued it, when recorded. */
  issuanceId: string | null;
  version: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  sha256: string | null;
  /** The report digest this package certifies (the full package embeds those bytes). */
  embeddedReportSha256: string | null;
  sealed: boolean;
  /** The seal key's exact registry identity, when recorded. */
  sealKey: { keyId: string; version: number; fingerprintSha256: string | null } | null;
  supersedesPackageId: string | null;
  immutableRecorded: boolean;
  pairing: "REPORT_VERSION" | "LEGACY_VERSION_NUMBER";
};

/** A package profile of a version that is not (yet) published. */
export type MatchedArtifactIssuance = {
  disclosureProfile: VerificationPackageProfileLabel;
  packageId: string;
  state: "RESERVED" | "FAILED";
  reservedAtUtc: string | null;
  failedAtUtc: string | null;
  terminalReason: string | null;
};

export type MatchedArtifactVersion = {
  reportVersion: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  sha256: string | null;
  immutableRecorded: boolean;
  /** FIRST_ISSUE | UPDATED_REPORT | null (written before the field existed). */
  issueKind: string | null;
  /** The bounded reason an UPDATED_REPORT was issued. */
  issueReason: string | null;
  latest: boolean;
  /** The published PRIMARY package (FULL_FORENSIC or legacy). */
  package: MatchedArtifactPackage | null;
  /** The published EXTERNAL_DISCLOSURE package — its own artifact. */
  externalDisclosure: MatchedArtifactPackage | null;
  /** Profiles of this version still being issued, or whose last attempt failed. */
  issuance: MatchedArtifactIssuance[];
  /**
   * The primary package's embedded report digest disagrees with this report's
   * stored digest. Never expected (the worker refuses it); surfaced, not hidden.
   */
  digestMismatch: boolean;
};

export type MatchedArtifactHistory = {
  versions: MatchedArtifactVersion[];
  /** Published packages whose report row does not exist (legacy consistency cases). */
  unpairedPackages: MatchedArtifactPackage[];
};

export async function listMatchedArtifactVersions(
  evidenceId: string,
): Promise<MatchedArtifactHistory> {
  const [reports, rows] = await Promise.all([
    prisma.report.findMany({
      where: { evidenceId },
      orderBy: [{ version: "desc" }],
      select: {
        version: true,
        generatedAtUtc: true,
        sizeBytes: true,
        pdfSha256: true,
        storageObjectLockMode: true,
        issueKind: true,
        issueReason: true,
      },
    }),
    // Every package row of the record, in any state: published rows are
    // packages, the others are lifecycle facts.
    prisma.verificationPackage.findMany({
      where: { evidenceId },
      orderBy: [{ version: "desc" }],
      select: {
        id: true,
        state: true,
        disclosureProfile: true,
        issuanceId: true,
        version: true,
        generatedAtUtc: true,
        sizeBytes: true,
        packageSha256: true,
        reportSha256: true,
        reportVersion: true,
        packageFormatVersion: true,
        sealSigningKeyId: true,
        sealSigningKeyVersion: true,
        sealSigningKeySha256: true,
        supersedesPackageId: true,
        storageObjectLockMode: true,
        reservedAtUtc: true,
        failedAtUtc: true,
        terminalReason: true,
      },
    }),
  ]);
  type Row = (typeof rows)[number];
  const toPackage = (p: Row): MatchedArtifactPackage => ({
    packageId: p.id,
    disclosureProfile: packageProfileLabel(p.disclosureProfile),
    issuanceId: p.issuanceId ?? null,
    version: p.version,
    generatedAtUtc: (p.generatedAtUtc ?? new Date(0)).toISOString(),
    sizeBytes: p.sizeBytes?.toString() ?? null,
    sha256: p.packageSha256 ?? null,
    embeddedReportSha256: p.reportSha256 ?? null,
    sealed: (p.packageFormatVersion ?? 0) >= 5,
    sealKey:
      p.sealSigningKeyId && p.sealSigningKeyVersion != null
        ? { keyId: p.sealSigningKeyId, version: p.sealSigningKeyVersion, fingerprintSha256: p.sealSigningKeySha256 ?? null }
        : null,
    supersedesPackageId: p.supersedesPackageId ?? null,
    immutableRecorded: Boolean(p.storageObjectLockMode),
    pairing: p.reportVersion != null ? "REPORT_VERSION" : "LEGACY_VERSION_NUMBER",
  });
  const isPrimary = (p: Row) => p.disclosureProfile == null || p.disclosureProfile === "FULL_FORENSIC";
  const published = rows.filter((p) => p.state === "PUBLISHED" && p.generatedAtUtc != null);
  const reportVersions = new Set(reports.map((r) => r.version));

  // The package certifying each report version, per kind: an explicit
  // report_version wins over a legacy row that only shares the number.
  const pick = (kind: (p: Row) => boolean) => {
    const byReport = new Map<number, Row>();
    for (const p of published.filter(kind)) {
      const certifies = p.reportVersion ?? p.version;
      if (!reportVersions.has(certifies)) continue;
      const existing = byReport.get(certifies);
      if (!existing || (existing.reportVersion == null && p.reportVersion != null)) {
        byReport.set(certifies, p);
      }
    }
    return byReport;
  };
  const primaryByReport = pick(isPrimary);
  const externalByReport = pick((p) => p.disclosureProfile === "EXTERNAL_DISCLOSURE");
  const paired = new Set([...primaryByReport.values(), ...externalByReport.values()]);

  return {
    versions: reports.map((r, index) => {
      const p = primaryByReport.get(r.version) ?? null;
      const ext = externalByReport.get(r.version) ?? null;
      return {
        reportVersion: r.version,
        generatedAtUtc: r.generatedAtUtc.toISOString(),
        sizeBytes: r.sizeBytes?.toString() ?? null,
        sha256: r.pdfSha256 ?? null,
        immutableRecorded: Boolean(r.storageObjectLockMode),
        issueKind: r.issueKind ?? null,
        issueReason: r.issueReason ?? null,
        latest: index === 0,
        package: p ? toPackage(p) : null,
        externalDisclosure: ext ? toPackage(ext) : null,
        issuance: rows
          .filter((x) => (x.reportVersion ?? x.version) === r.version && (x.state === "RESERVED" || x.state === "FAILED"))
          .map((x) => ({
            disclosureProfile: packageProfileLabel(x.disclosureProfile),
            packageId: x.id,
            state: x.state as "RESERVED" | "FAILED",
            reservedAtUtc: x.reservedAtUtc?.toISOString() ?? null,
            failedAtUtc: x.failedAtUtc?.toISOString() ?? null,
            terminalReason: x.terminalReason ?? null,
          })),
        digestMismatch: Boolean(
          p?.reportSha256 && r.pdfSha256 && p.reportSha256.toLowerCase() !== r.pdfSha256.toLowerCase(),
        ),
      };
    }),
    unpairedPackages: published.filter((p) => !paired.has(p)).map(toPackage),
  };
}
