/**
 * Phase HOME-RECORDS-BY-TYPE — workspace-scoped aggregation that
 * powers the Home "Records by primary type" donut.
 *
 * Replaces the previous client-side classification over the latest-
 * 100 evidence list. That UX presented a SAMPLE as if it were the
 * whole workspace; this service returns counts over EVERY active
 * non-deleted Evidence row in the caller's scope.
 *
 * Two aggregates are returned:
 *
 *   records  — one count per Evidence row, classified by the
 *              parent's (mimeType, type, captureMethod). A multipart
 *              parent counts ONCE in its primary bucket.
 *
 *   files    — one count per EvidencePart row, classified by the
 *              part's mimeType alone. A multipart Evidence with
 *              5 images + 1 video + 1 PDF contributes 5+1+1 = 7
 *              file counts. This is the "Preserved files by type"
 *              concept — clearly distinct from records.
 *
 * Scope rules (mirror trust-summary.service.ts to keep parity):
 *   - Personal workspace: include `team_id = X` AND legacy
 *     `owner_user_id = OWNER AND team_id IS NULL` rows.
 *   - Team / org workspace: strict `team_id = X` only.
 *   - Both modes exclude soft-deleted Evidence
 *     (`deleted_at IS NULL`). Files inherit the parent's exclusion
 *     via the Prisma relation predicate.
 *
 * Read-only. Never mutates. Safe to call on every Home render.
 */

import {
  classifyEvidenceCategory,
  emptyRecordsByTypeAggregate,
  type RecordsByTypeAggregate,
  type RecordsByTypeCategory,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";

export type RecordsByTypeResponse = {
  /** Evidence-row aggregation — the canonical "Records by type" donut. */
  records: RecordsByTypeAggregate;
  /** EvidencePart-row aggregation — "Preserved files by type" view. */
  files: RecordsByTypeAggregate;
};

export async function buildRecordsByType(input: {
  teamId: string;
}): Promise<RecordsByTypeResponse> {
  const scopeWhere = await workspaceEvidenceWhere(input.teamId, prisma);

  // RECORDS — every active Evidence row's (mimeType, type, captureMethod).
  // Single bounded query: only the three columns the classifier reads.
  const evidenceRows = await prisma.evidence.findMany({
    where: { AND: [scopeWhere, { deletedAt: null }] },
    select: { mimeType: true, type: true, captureMethod: true },
  });

  const records = emptyRecordsByTypeAggregate();
  for (const ev of evidenceRows) {
    const category = classifyEvidenceCategory({
      mimeType: ev.mimeType,
      type: ev.type,
      captureMethod: ev.captureMethod,
    });
    records.byCategory[category] = (records.byCategory[category] ?? 0) + 1;
    records.total += 1;
  }

  // FILES — every EvidencePart belonging to an active Evidence in scope.
  // Parts don't carry the parent's `type` / `captureMethod`, so the
  // classifier is fed `mimeType` only. The relation filter inherits
  // the parent's scope + deletedAt:null.
  const partRows = await prisma.evidencePart.findMany({
    where: {
      evidence: { AND: [scopeWhere, { deletedAt: null }] },
    },
    select: { mimeType: true },
  });

  const files = emptyRecordsByTypeAggregate();
  for (const p of partRows) {
    const category = classifyEvidenceCategory({ mimeType: p.mimeType });
    files.byCategory[category] = (files.byCategory[category] ?? 0) + 1;
    files.total += 1;
  }

  return { records, files };
}

// Re-export for route-layer convenience.
export type { RecordsByTypeAggregate, RecordsByTypeCategory };
