import { prisma } from "../../db.js";
export async function listEvidenceArtifacts(evidenceId) {
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
            },
        }),
    ]);
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
        verificationPackages: verificationPackages.map((item, index) => ({
            id: item.id,
            version: item.version,
            generatedAtUtc: item.generatedAtUtc.toISOString(),
            packageType: item.packageType ?? null,
            storageKey: item.storageKey,
            sizeBytes: item.sizeBytes?.toString() ?? null,
            immutableRecorded: Boolean(item.storageObjectLockMode),
            latest: index === 0,
        })),
    };
}
