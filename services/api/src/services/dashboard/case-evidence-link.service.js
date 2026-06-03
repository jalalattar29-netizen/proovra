/**
 * Phase 32.8C+++++ — CaseEvidenceLink writer + reader.
 *
 * Many-to-many evidence ↔ case linkage. The legacy `Evidence.caseId`
 * singular column remains in place for backwards-compatible reads; this
 * table is the canonical source for richer linkage (role, source,
 * linkedBy, reason).
 *
 * Hard rules:
 *   - Lazy backfill from `Evidence.caseId` is idempotent: each evidence
 *     with caseId set gets a single PRIMARY-role link, source SYSTEM.
 *   - Writer failures NEVER block evidence/report/package flows.
 *   - Bounded queries, bounded reason text.
 */
import { prisma } from "../../db.js";
/**
 * Lazy backfill from Evidence.caseId. Reads a bounded slice of evidence
 * with caseId set and creates idempotent PRIMARY links. Never throws.
 * Returns the count of links actually inserted.
 */
export async function backfillCaseEvidenceLinks(input) {
    let persisted = 0;
    let skipped = 0;
    let failed = 0;
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    try {
        const evidence = await prisma.evidence.findMany({
            where: {
                teamId: input.teamId,
                caseId: { not: null },
            },
            take: limit,
            orderBy: { updatedAt: "desc" },
            select: {
                id: true,
                teamId: true,
                caseId: true,
            },
        });
        for (const e of evidence) {
            if (!e.caseId || !e.teamId) {
                skipped += 1;
                continue;
            }
            try {
                const existing = await prisma.caseEvidenceLink.findUnique({
                    where: {
                        caseId_evidenceId_role: {
                            caseId: e.caseId,
                            evidenceId: e.id,
                            role: "PRIMARY",
                        },
                    },
                    select: { id: true },
                });
                if (existing) {
                    skipped += 1;
                    continue;
                }
                await prisma.caseEvidenceLink.create({
                    data: {
                        teamId: e.teamId,
                        caseId: e.caseId,
                        evidenceId: e.id,
                        role: "PRIMARY",
                        source: "SYSTEM",
                        reason: "backfilled from Evidence.caseId",
                    },
                });
                persisted += 1;
            }
            catch {
                failed += 1;
            }
        }
    }
    catch {
        /* Outer read failure — return partial counts. */
    }
    return { persisted, skipped, failed };
}
/**
 * Cross-case intelligence reader: returns evidence rows linked to
 * multiple cases within the workspace. Bounded result.
 */
export async function listEvidenceLinkedToMultipleCases(input) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    try {
        const grouped = await prisma.caseEvidenceLink.groupBy({
            by: ["evidenceId"],
            where: { teamId: input.teamId },
            _count: { caseId: true },
            having: { caseId: { _count: { gt: 1 } } },
            orderBy: { _count: { caseId: "desc" } },
            take: limit,
        });
        const out = [];
        for (const g of grouped) {
            const links = await prisma.caseEvidenceLink.findMany({
                where: { teamId: input.teamId, evidenceId: g.evidenceId },
                take: 10,
                orderBy: { linkedAtUtc: "desc" },
                select: { caseId: true },
            });
            const caseIds = Array.from(new Set(links.map((l) => l.caseId)));
            out.push({
                evidenceId: g.evidenceId,
                caseCount: caseIds.length,
                caseIds,
            });
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * Returns case clusters: cases that share at least one evidence row with
 * another case. Bounded result, used for the cross-case intelligence
 * section.
 */
export async function listCaseSharedEvidenceClusters(input) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    try {
        // Find evidence linked to >1 cases, then group by case.
        const multi = await prisma.caseEvidenceLink.groupBy({
            by: ["evidenceId"],
            where: { teamId: input.teamId },
            _count: { caseId: true },
            having: { caseId: { _count: { gt: 1 } } },
            orderBy: { evidenceId: "asc" },
            take: 500,
        });
        const evidenceIds = multi.map((m) => m.evidenceId);
        if (evidenceIds.length === 0)
            return [];
        const grouped = await prisma.caseEvidenceLink.groupBy({
            by: ["caseId"],
            where: {
                teamId: input.teamId,
                evidenceId: { in: evidenceIds },
            },
            _count: { evidenceId: true },
            orderBy: { _count: { evidenceId: "desc" } },
            take: limit,
        });
        return grouped.map((g) => ({
            caseId: g.caseId,
            sharedEvidenceCount: g._count.evidenceId,
        }));
    }
    catch {
        return [];
    }
}
