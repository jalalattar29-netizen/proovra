/**
 * Phase 15 — Similarity hints between evidence rows (read side).
 *
 * Findings live on `evidence_similarities` and are ADVISORY: "possible
 * related evidence", never "same evidence confirmed". The service never
 * merges, deletes, or modifies an evidence row.
 *
 * The detectors that wrote these rows (hash / filename / OCR / transcript)
 * were reachable only through POST /v1/intelligence/evidence/:id/reconcile-similarity,
 * retired by owner decision (2026-09-16). With no caller left they were
 * removed (2026-09-17); stored findings remain readable here.
 */

import type { EvidenceSimilarity as DbSimilarity, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------

export async function listSimilaritiesForEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbSimilarity[]> {
  return client.evidenceSimilarity.findMany({
    where: {
      OR: [
        { sourceEvidenceId: evidenceId },
        { targetEvidenceId: evidenceId },
      ],
    },
    orderBy: [{ kind: "asc" }, { score: "desc" }],
  });
}

export function projectSimilarity(
  row: DbSimilarity,
  forEvidenceId: string,
): {
  id: string;
  kind: string;
  otherEvidenceId: string;
  score: number;
  advisorySummary: string | null;
  createdAt: string;
} {
  const other =
    row.sourceEvidenceId === forEvidenceId
      ? row.targetEvidenceId
      : row.sourceEvidenceId;
  return {
    id: row.id,
    kind: row.kind,
    otherEvidenceId: other,
    score: row.score,
    advisorySummary: row.advisorySummary,
    createdAt: row.createdAt.toISOString(),
  };
}
