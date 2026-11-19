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
  /**
   * PRO-AI1Z-02 — the reader's closed records (`hiddenRecordIdsInWorkspace`):
   * a peer a restricted case closes to them is not named, and a trashed peer
   * is not offered. Omitted only by machine callers.
   */
  hiddenEvidenceIds?: readonly string[],
): Promise<DbSimilarity[]> {
  const rows = await client.evidenceSimilarity.findMany({
    where: {
      OR: [
        { sourceEvidenceId: evidenceId },
        { targetEvidenceId: evidenceId },
      ],
    },
    orderBy: [{ kind: "asc" }, { score: "desc" }],
  });
  if (hiddenEvidenceIds === undefined) return rows;
  const peerOf = (r: DbSimilarity) => (r.sourceEvidenceId === evidenceId ? r.targetEvidenceId : r.sourceEvidenceId);
  const peers = [...new Set(rows.map(peerOf))];
  const live = new Set(
    peers.length
      ? (await client.evidence.findMany({ where: { id: { in: peers }, deletedAt: null }, select: { id: true } })).map((e) => e.id)
      : [],
  );
  const hidden = new Set(hiddenEvidenceIds);
  return rows.filter((r) => live.has(peerOf(r)) && !hidden.has(peerOf(r)));
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
