import { prisma } from "../../db.js";
import { readExternalDisclosureArtifact } from "../reports/external-disclosure-artifact.js";

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
    prisma.verificationPackage.findMany({
      where: { evidenceId },
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
      generatedAtUtc: item.generatedAtUtc.toISOString(),
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
 * ONE IMMUTABLE REPORT/PACKAGE PAIR per report version — THE history the
 * Artifacts & Versions tab renders (and native reads).
 *
 * Two independent lists (reports, packages) let a surface draw package v2 beside
 * report v1. Here the pairing is the database's own: a package belongs to the
 * report version it records in `report_version` (enforced by the RGA-05 foreign
 * key), and a legacy package with no recorded report version is paired by its
 * own version number and says so (`pairing: "LEGACY_VERSION_NUMBER"`). A package
 * whose report row does not exist is listed separately, never attached to some
 * other report.
 *
 * No storage key, bucket or signed URL leaves this function. Digests are the
 * SHA-256 of the stored bytes, which a verifier is meant to compare.
 */
export type MatchedArtifactPackage = {
  /** THE package identity (the row id; carried inside packages issued since 2026-10-07). */
  packageId: string;
  /** FULL_FORENSIC, or LEGACY for a package issued before disclosure profiles. */
  disclosureProfile: "FULL_FORENSIC" | "LEGACY";
  /** The EXTERNAL_DISCLOSURE companion issued with it, when one exists. */
  externalDisclosure: { packageId: string; sha256: string | null; sizeBytes: string | null } | null;
  version: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  sha256: string | null;
  /** The report digest this package embeds (format 5 binds it in the seal). */
  embeddedReportSha256: string | null;
  sealed: boolean;
  immutableRecorded: boolean;
  pairing: "REPORT_VERSION" | "LEGACY_VERSION_NUMBER";
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
  package: MatchedArtifactPackage | null;
  /**
   * The package's embedded report digest disagrees with this report's stored
   * digest. Never expected (the worker refuses it); surfaced, not hidden.
   */
  digestMismatch: boolean;
};

export type MatchedArtifactHistory = {
  versions: MatchedArtifactVersion[];
  /** Packages whose report row does not exist (legacy consistency cases). */
  unpairedPackages: MatchedArtifactPackage[];
};

export async function listMatchedArtifactVersions(
  evidenceId: string,
): Promise<MatchedArtifactHistory> {
  const [reports, packages] = await Promise.all([
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
    prisma.verificationPackage.findMany({
      where: { evidenceId },
      orderBy: [{ version: "desc" }],
      select: {
        id: true,
        disclosureProfile: true,
        externalDisclosureArtifact: true,
        version: true,
        generatedAtUtc: true,
        sizeBytes: true,
        packageSha256: true,
        reportSha256: true,
        reportVersion: true,
        packageFormatVersion: true,
        storageObjectLockMode: true,
      },
    }),
  ]);
  const toPackage = (p: (typeof packages)[number]): MatchedArtifactPackage => {
    const ext = readExternalDisclosureArtifact(p.externalDisclosureArtifact);
    return {
    packageId: p.id,
    disclosureProfile: p.disclosureProfile === "FULL_FORENSIC" ? "FULL_FORENSIC" : "LEGACY",
    externalDisclosure: ext ? { packageId: ext.packageId, sha256: ext.packageSha256, sizeBytes: ext.sizeBytes } : null,
    version: p.version,
    generatedAtUtc: p.generatedAtUtc.toISOString(),
    sizeBytes: p.sizeBytes?.toString() ?? null,
    sha256: p.packageSha256 ?? null,
    embeddedReportSha256: p.reportSha256 ?? null,
    sealed: (p.packageFormatVersion ?? 0) >= 5,
    immutableRecorded: Boolean(p.storageObjectLockMode),
    pairing: p.reportVersion != null ? "REPORT_VERSION" : "LEGACY_VERSION_NUMBER",
    };
  };
  const reportVersions = new Set(reports.map((r) => r.version));
  // The package certifying each report version: an explicit report_version wins
  // over a legacy row that only shares the number.
  const byReport = new Map<number, (typeof packages)[number]>();
  for (const p of packages) {
    const certifies = p.reportVersion ?? p.version;
    if (!reportVersions.has(certifies)) continue;
    const existing = byReport.get(certifies);
    if (!existing || (existing.reportVersion == null && p.reportVersion != null)) {
      byReport.set(certifies, p);
    }
  }
  const paired = new Set([...byReport.values()]);
  return {
    versions: reports.map((r, index) => {
      const p = byReport.get(r.version) ?? null;
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
        digestMismatch: Boolean(
          p?.reportSha256 && r.pdfSha256 && p.reportSha256.toLowerCase() !== r.pdfSha256.toLowerCase(),
        ),
      };
    }),
    unpairedPackages: packages.filter((p) => !paired.has(p)).map(toPackage),
  };
}
