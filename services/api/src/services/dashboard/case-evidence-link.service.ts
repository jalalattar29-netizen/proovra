/**
 * Phase 32.8C+++++ — CaseEvidenceLink cross-case intelligence readers.
 *
 * Many-to-many evidence ↔ case linkage. Since the Track 1B closure the
 * CaseEvidenceLink table is the ONLY case↔evidence relationship source
 * (the legacy `Evidence.caseId` column was dropped by migration
 * 20271105000000_evidence_case_id_removal); the lazy backfill that used
 * to hydrate this table from the column is gone with it.
 *
 * Hard rules:
 *   - Reader failures NEVER block evidence/report/package flows.
 *   - Bounded queries.
 */

import { prisma } from "../../db.js";

export type CaseEvidenceLinkRole =
  | "PRIMARY"
  | "SUPPORTING"
  | "RELATED"
  | "DUPLICATE"
  | "DERIVED"
  | "CONTEXT";

export type CaseEvidenceLinkSource =
  | "USER"
  | "SYSTEM"
  | "IMPORT"
  | "INTAKE"
  | "WORKFLOW";

/**
 * Cross-case intelligence reader: returns evidence rows linked to
 * multiple cases within the workspace. Bounded result.
 */
export async function listEvidenceLinkedToMultipleCases(input: {
  teamId: string;
  limit?: number;
}): Promise<
  Array<{
    evidenceId: string;
    caseCount: number;
    caseIds: string[];
  }>
> {
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

    const out: Array<{
      evidenceId: string;
      caseCount: number;
      caseIds: string[];
    }> = [];
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
  } catch {
    return [];
  }
}

/**
 * Returns case clusters: cases that share at least one evidence row with
 * another case. Bounded result, used for the cross-case intelligence
 * section.
 */
export async function listCaseSharedEvidenceClusters(input: {
  teamId: string;
  limit?: number;
}): Promise<
  Array<{
    caseId: string;
    sharedEvidenceCount: number;
  }>
> {
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
    if (evidenceIds.length === 0) return [];

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
  } catch {
    return [];
  }
}
