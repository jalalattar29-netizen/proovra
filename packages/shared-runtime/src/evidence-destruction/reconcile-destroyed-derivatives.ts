/**
 * UC-0 (A2) — retroactive reconciliation of derived material on DESTROYED
 * tombstones.
 *
 * The P0-7 fix made forward destruction delete everything PROOVRA derived from
 * a record (thumbnails/frames/proxies and their objects, OCR/transcript/
 * extracted text, semantic chunks, search documents). Records destroyed BEFORE
 * that fix kept their derived rows — so `EvidencePartDerivedAsset` bytes on
 * an already-destroyed record still counted toward the workspace's storage.
 *
 * This sweep applies exactly that cleanup to records already in the DESTROYED
 * terminal state. It is:
 *
 *   - BOUNDED: it processes at most `recordLimit` tombstones per run, chosen by
 *     a precise join so it never scans live records' legitimate derivatives.
 *   - IDEMPOTENT: a cleaned tombstone no longer satisfies the selection, so a
 *     second run over the same data is a no-op.
 *   - HOLD-SAFE: a record with an ACTIVE legal hold is never touched (a
 *     DESTROYED record cannot be held, but the guard is explicit).
 *   - OBJECT-SAFE: derived objects are deleted through the SAME canonical
 *     storage port the executor uses; the platform wrote these objects under
 *     its own key scheme, so ownership is not guessed. Objects are deleted
 *     BEFORE the rows that point at them, so a row is never removed while its
 *     object still exists (which would leak the object).
 *   - OBSERVABLE: it returns bounded counts only — never evidence content.
 *   - DRY-RUN: `dryRun` reports what WOULD be reconciled and mutates nothing.
 */

import type { PrismaClient } from "@prisma/client";

import type { EvidenceDestructionStoragePort } from "./executor.js";

export type DestroyedDerivativeReconciliationResult = {
  dryRun: boolean;
  /** DESTROYED tombstones that still carried derived material and were scanned. */
  tombstonesScanned: number;
  /** Derived-asset ROWS removed (or that would be, under dryRun). */
  derivedAssetRowsRemoved: number;
  /** Bytes of those derived-asset rows — the storage reclaimed. */
  derivedBytesReclaimed: number;
  /** Derived objects deleted through the storage port. */
  derivedObjectsDeleted: number;
  /** Derived objects the port could not delete (left for a retry; row kept). */
  derivedObjectsFailed: number;
  /** Co-resident derived TEXT rows removed (no storage bytes, but derived). */
  ocrRowsRemoved: number;
  transcriptRowsRemoved: number;
  extractedTextRowsRemoved: number;
  semanticChunkRowsRemoved: number;
  searchDocumentRowsRemoved: number;
};

function emptyResult(dryRun: boolean): DestroyedDerivativeReconciliationResult {
  return {
    dryRun,
    tombstonesScanned: 0,
    derivedAssetRowsRemoved: 0,
    derivedBytesReclaimed: 0,
    derivedObjectsDeleted: 0,
    derivedObjectsFailed: 0,
    ocrRowsRemoved: 0,
    transcriptRowsRemoved: 0,
    extractedTextRowsRemoved: 0,
    semanticChunkRowsRemoved: 0,
    searchDocumentRowsRemoved: 0,
  };
}

/**
 * Select DESTROYED tombstones that STILL carry `EvidencePartDerivedAsset` rows
 * and are NOT under an active legal hold. Driven from the derived-asset table
 * so live records never enter the candidate set, bounded by `limit`.
 */
async function selectTombstonesWithDerivedMaterial(
  prisma: PrismaClient,
  limit: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ evidence_id: string }>>`
    SELECT DISTINCT d."evidence_id"
      FROM "evidence_part_derived_assets" d
      JOIN "evidence" e ON e."id" = d."evidence_id"
     WHERE e."lifecycle_state" = 'DESTROYED'
       AND NOT EXISTS (
         SELECT 1 FROM "evidence_legal_holds" h
          WHERE h."evidence_id" = e."id" AND h."status" = 'ACTIVE'
       )
     LIMIT ${limit}`;
  return rows.map((r) => r.evidence_id);
}

export async function reconcileDestroyedDerivedAssets(
  prisma: PrismaClient,
  storage: EvidenceDestructionStoragePort,
  opts: { dryRun: boolean; recordLimit?: number },
): Promise<DestroyedDerivativeReconciliationResult> {
  const recordLimit = Math.max(1, Math.min(opts.recordLimit ?? 200, 1000));
  const result = emptyResult(opts.dryRun);

  const tombstoneIds = await selectTombstonesWithDerivedMaterial(prisma, recordLimit);
  if (tombstoneIds.length === 0) return result;

  for (const evidenceId of tombstoneIds) {
    result.tombstonesScanned += 1;

    const derivedAssets = await prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId },
      select: {
        id: true,
        storageBucket: true,
        storageKey: true,
        sizeBytes: true,
      },
    });

    // 1. Delete the derived OBJECTS first, through the canonical port. A row is
    //    only removed once its object is gone (or was never stored), so an
    //    object is never orphaned by a deleted pointer.
    const rowsSafeToRemove: string[] = [];
    let bytesForThisRecord = 0;
    let objectFailuresThisRecord = 0;
    for (const asset of derivedAssets) {
      const hasObject = Boolean(asset.storageBucket && asset.storageKey);
      if (!hasObject) {
        // No object to leak — the row is safe to remove.
        rowsSafeToRemove.push(asset.id);
        bytesForThisRecord += asset.sizeBytes ?? 0;
        continue;
      }
      if (opts.dryRun) {
        result.derivedObjectsDeleted += 1;
        rowsSafeToRemove.push(asset.id);
        bytesForThisRecord += asset.sizeBytes ?? 0;
        continue;
      }
      const res = await storage.deleteObject({
        bucket: asset.storageBucket as string,
        key: asset.storageKey as string,
      });
      if (res.ok) {
        result.derivedObjectsDeleted += 1;
        rowsSafeToRemove.push(asset.id);
        bytesForThisRecord += asset.sizeBytes ?? 0;
      } else {
        // Leave the row so its object is retried next run — never delete a
        // pointer to an object that still exists.
        result.derivedObjectsFailed += 1;
        objectFailuresThisRecord += 1;
      }
    }

    if (opts.dryRun) {
      result.derivedAssetRowsRemoved += derivedAssets.length;
      result.derivedBytesReclaimed += bytesForThisRecord;
      // Count the co-resident derived text rows that WOULD be removed.
      const [ocr, transcript, extracted, chunk, searchDoc] = await Promise.all([
        prisma.evidenceOcrText.count({ where: { evidenceId } }),
        prisma.evidenceTranscriptSegment.count({ where: { evidenceId } }),
        prisma.evidenceExtractedText.count({ where: { evidenceId } }),
        prisma.evidenceSemanticChunk.count({ where: { evidenceId } }),
        prisma.evidenceSearchDocument.count({ where: { evidenceId } }),
      ]);
      result.ocrRowsRemoved += ocr;
      result.transcriptRowsRemoved += transcript;
      result.extractedTextRowsRemoved += extracted;
      result.semanticChunkRowsRemoved += chunk;
      result.searchDocumentRowsRemoved += searchDoc;
      continue;
    }

    // 2. Remove the rows whose objects are gone, plus the co-resident derived
    //    text rows, in one transaction. The derived text tables carry no
    //    storage bytes but are the same "derived from content" material the
    //    executor removes; a fully-cleaned object set means the record is done.
    const allObjectsCleared = objectFailuresThisRecord === 0;
    await prisma.$transaction(async (tx) => {
      if (rowsSafeToRemove.length > 0) {
        const removed = await tx.evidencePartDerivedAsset.deleteMany({
          where: { id: { in: rowsSafeToRemove } },
        });
        result.derivedAssetRowsRemoved += removed.count;
        result.derivedBytesReclaimed += bytesForThisRecord;
      }
      // Only clear the derived text once every derived object for the record is
      // gone — otherwise a later retry still has work and the record is not done.
      if (allObjectsCleared) {
        const ocr = await tx.evidenceOcrText.deleteMany({ where: { evidenceId } });
        const transcript = await tx.evidenceTranscriptSegment.deleteMany({ where: { evidenceId } });
        const extracted = await tx.evidenceExtractedText.deleteMany({ where: { evidenceId } });
        const chunk = await tx.evidenceSemanticChunk.deleteMany({ where: { evidenceId } });
        const searchDoc = await tx.evidenceSearchDocument.deleteMany({ where: { evidenceId } });
        result.ocrRowsRemoved += ocr.count;
        result.transcriptRowsRemoved += transcript.count;
        result.extractedTextRowsRemoved += extracted.count;
        result.semanticChunkRowsRemoved += chunk.count;
        result.searchDocumentRowsRemoved += searchDoc.count;
      }
    });
  }

  return result;
}
