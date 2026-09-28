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
        storageKey: true,
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
        storageKey: true,
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
      storageKey: item.storageKey,
      sizeBytes: item.sizeBytes?.toString() ?? null,
      immutableRecorded: Boolean(item.storageObjectLockMode),
      latest: index === 0,
    })),
    verificationPackages: verificationPackages.map((item) => ({
      id: item.id,
      version: item.version,
      generatedAtUtc: item.generatedAtUtc.toISOString(),
      packageType: item.packageType ?? null,
      storageKey: item.storageKey,
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
