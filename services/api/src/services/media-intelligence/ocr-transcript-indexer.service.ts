/**
 * Phase 31.20 — OCR / transcript indexing producer (INDEX_EXISTING_ONLY mode).
 *
 * Reads existing rows from `evidence_ocr_text` and
 * `evidence_transcript_segments` (both tables shipped in Phase 24-J)
 * and emits bounded `media_intelligence_signals` rows:
 *
 *   OCR_AVAILABLE        — at least one non-redacted, non-blocked OCR
 *                          chunk exists for the evidence.
 *   OCR_INDEXED          — at least one of those rows has
 *                          `indexed_at_utc IS NOT NULL`.
 *   TRANSCRIPT_AVAILABLE — symmetric for transcript_segments.
 *   TRANSCRIPT_INDEXED   — symmetric.
 *
 * This is the INDEX_EXISTING_ONLY producer: it does NOT extract any
 * new OCR or transcript content. It surfaces presence and indexing-
 * status signals derived from whatever rows the source tables
 * already contain. Producer mode gates:
 *
 *   * NOT_CONFIGURED      → no-op (caller short-circuits before
 *                            invoking this service).
 *   * INDEX_EXISTING_ONLY → run this service.
 *   * LOCAL_TESSERACT /
 *     LOCAL_WHISPER /
 *     VENDOR_CLOUD        → still run this service to backfill
 *                            signals for any pre-existing rows;
 *                            the active producer additionally
 *                            writes new rows that this service
 *                            will pick up on the next reconcile.
 *
 * Hard rules enforced here:
 *   * NEVER reads `text` content for label/summary — only counts of
 *     bounded rows (chunk_index, segment_index).
 *   * NEVER returns raw OCR / transcript text to the caller. Only
 *     signal counts + bounded safe_summary strings.
 *   * Filters out `redacted = true` rows and
 *     `visibility_scope = 'BLOCKED'` rows.
 *   * Team-anchored at every read.
 *   * Idempotent: re-runs upsert by (evidence_id, signal_type) so
 *     concurrent or repeated invocations don't multiply rows.
 *   * NEVER throws — failure collapses to `{ ok: false, reason }`.
 *   * Bounded query — paginated by team_id with a hard upper bound
 *     (default 500 evidence ids per call). The caller (worker
 *     processor) sweeps through pages.
 *
 * Idempotency:
 *   Signals are upserted with the same ON CONFLICT clause the
 *   analyzer uses (evidence_id + material_id + signal_type). For
 *   the AVAILABLE / INDEXED markers we use `material_id = NULL`
 *   (whole-evidence scope), so the conflict key collapses to
 *   (evidence_id, signal_type).
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeSummary } from "./signal-catalog.js";

// =============================================================================
// Public input + output types
// =============================================================================

export type IndexExistingInput = {
  teamId: string;
  /** Optional bound on number of evidence rows scanned in this call.
   *  Default 500. Hard cap 5000 to prevent unbounded scans on very
   *  large workspaces. */
  evidenceBatchSize?: number;
};

export type IndexExistingResult = {
  ok: boolean;
  // Number of OCR rows present (non-redacted, non-blocked) across
  // the scanned evidence batch. Bounded count only — never text.
  ocrRowsPresent: number;
  ocrEvidenceCount: number;
  // Number of OCR rows already indexed (indexed_at_utc IS NOT NULL).
  ocrRowsIndexed: number;
  ocrEvidenceIndexedCount: number;
  // Symmetric counts for transcript.
  transcriptRowsPresent: number;
  transcriptEvidenceCount: number;
  transcriptRowsIndexed: number;
  transcriptEvidenceIndexedCount: number;
  // Signal upsert counts.
  signalsUpserted: number;
  // Bounded error code on failure paths.
  reason?: string;
};

// =============================================================================
// Service
// =============================================================================

export async function indexExistingOcrAndTranscript(
  input: IndexExistingInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexExistingResult> {
  const batchSize = Math.max(
    1,
    Math.min(input.evidenceBatchSize ?? 500, 5000),
  );
  const empty = (reason?: string): IndexExistingResult => ({
    ok: false,
    ocrRowsPresent: 0,
    ocrEvidenceCount: 0,
    ocrRowsIndexed: 0,
    ocrEvidenceIndexedCount: 0,
    transcriptRowsPresent: 0,
    transcriptEvidenceCount: 0,
    transcriptRowsIndexed: 0,
    transcriptEvidenceIndexedCount: 0,
    signalsUpserted: 0,
    reason,
  });
  bump("ocr_indexer_started_total");

  // 1) OCR availability + indexing counts. Per-evidence aggregation
  //    so we can emit one OCR_AVAILABLE signal per evidence (whole-
  //    evidence scope; material_id = NULL).
  let ocrAvailRows: Array<{
    evidence_id: string;
    chunk_count: number;
    indexed_count: number;
  }> = [];
  try {
    ocrAvailRows = (await client.$queryRawUnsafe(
      `SELECT "evidence_id",
              COUNT(*)::int AS "chunk_count",
              COUNT(*) FILTER (WHERE "indexed_at_utc" IS NOT NULL)::int AS "indexed_count"
         FROM "evidence_ocr_text"
        WHERE "team_id" = $1
          AND "redacted" = false
          AND "visibility_scope" <> 'BLOCKED'
        GROUP BY "evidence_id"
        ORDER BY "evidence_id"
        LIMIT $2`,
      input.teamId,
      batchSize,
    )) as Array<{
      evidence_id: string;
      chunk_count: number;
      indexed_count: number;
    }>;
  } catch (err) {
    return empty(
      err instanceof Error
        ? `ocr_query_failed:${err.message.slice(0, 40)}`
        : "ocr_query_failed",
    );
  }

  // 2) Transcript availability + indexing counts.
  let transcriptAvailRows: Array<{
    evidence_id: string;
    segment_count: number;
    indexed_count: number;
  }> = [];
  try {
    transcriptAvailRows = (await client.$queryRawUnsafe(
      `SELECT "evidence_id",
              COUNT(*)::int AS "segment_count",
              COUNT(*) FILTER (WHERE "indexed_at_utc" IS NOT NULL)::int AS "indexed_count"
         FROM "evidence_transcript_segments"
        WHERE "team_id" = $1
          AND "redacted" = false
          AND "visibility_scope" <> 'BLOCKED'
        GROUP BY "evidence_id"
        ORDER BY "evidence_id"
        LIMIT $2`,
      input.teamId,
      batchSize,
    )) as Array<{
      evidence_id: string;
      segment_count: number;
      indexed_count: number;
    }>;
  } catch (err) {
    return empty(
      err instanceof Error
        ? `transcript_query_failed:${err.message.slice(0, 40)}`
        : "transcript_query_failed",
    );
  }

  // 3) Aggregate + upsert signals.
  let signalsUpserted = 0;
  let ocrRowsPresent = 0;
  let ocrRowsIndexed = 0;
  let transcriptRowsPresent = 0;
  let transcriptRowsIndexed = 0;
  let ocrEvidenceIndexedCount = 0;
  let transcriptEvidenceIndexedCount = 0;

  for (const r of ocrAvailRows) {
    ocrRowsPresent += r.chunk_count;
    ocrRowsIndexed += r.indexed_count;
    // OCR_AVAILABLE: emit when chunk_count > 0 (always true here
    // since the GROUP BY filtered to evidence_ids with at least one
    // row).
    const availOk = await upsertWholeEvidenceSignal(client, {
      teamId: input.teamId,
      evidenceId: r.evidence_id,
      signalType: "OCR_AVAILABLE",
      severity: "INFO",
      confidence: "HIGH",
      safeSummaryText: safeSummary({ type: "OCR_AVAILABLE" }),
    });
    if (availOk) signalsUpserted += 1;

    if (r.indexed_count > 0) {
      ocrEvidenceIndexedCount += 1;
      const indexedOk = await upsertWholeEvidenceSignal(client, {
        teamId: input.teamId,
        evidenceId: r.evidence_id,
        signalType: "OCR_INDEXED",
        severity: "INFO",
        confidence: "HIGH",
        safeSummaryText: safeSummary({
          type: "OCR_INDEXED",
          chunkCount: r.indexed_count,
        }),
      });
      if (indexedOk) signalsUpserted += 1;
    }
  }

  for (const r of transcriptAvailRows) {
    transcriptRowsPresent += r.segment_count;
    transcriptRowsIndexed += r.indexed_count;
    const availOk = await upsertWholeEvidenceSignal(client, {
      teamId: input.teamId,
      evidenceId: r.evidence_id,
      signalType: "TRANSCRIPT_AVAILABLE",
      severity: "INFO",
      confidence: "HIGH",
      safeSummaryText: safeSummary({ type: "TRANSCRIPT_AVAILABLE" }),
    });
    if (availOk) signalsUpserted += 1;

    if (r.indexed_count > 0) {
      transcriptEvidenceIndexedCount += 1;
      const indexedOk = await upsertWholeEvidenceSignal(client, {
        teamId: input.teamId,
        evidenceId: r.evidence_id,
        signalType: "TRANSCRIPT_INDEXED",
        severity: "INFO",
        confidence: "HIGH",
        safeSummaryText: safeSummary({
          type: "TRANSCRIPT_INDEXED",
          segmentCount: r.indexed_count,
        }),
      });
      if (indexedOk) signalsUpserted += 1;
    }
  }

  bump("ocr_indexer_completed_total");
  return {
    ok: true,
    ocrRowsPresent,
    ocrEvidenceCount: ocrAvailRows.length,
    ocrRowsIndexed,
    ocrEvidenceIndexedCount,
    transcriptRowsPresent,
    transcriptEvidenceCount: transcriptAvailRows.length,
    transcriptRowsIndexed,
    transcriptEvidenceIndexedCount,
    signalsUpserted,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

type UpsertSignalInput = {
  teamId: string;
  evidenceId: string;
  signalType:
    | "OCR_AVAILABLE"
    | "OCR_INDEXED"
    | "TRANSCRIPT_AVAILABLE"
    | "TRANSCRIPT_INDEXED";
  severity: "INFO" | "REVIEW_RECOMMENDED" | "ATTENTION";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  safeSummaryText: string;
};

async function upsertWholeEvidenceSignal(
  client: PrismaClient,
  input: UpsertSignalInput,
): Promise<boolean> {
  try {
    // material_id = NULL → whole-evidence scope. The unique key
    // includes COALESCE(material_id, sentinel) so this collapses to
    // (evidence_id, signal_type) idempotently.
    await client.$executeRawUnsafe(
      `INSERT INTO "media_intelligence_signals"
         ("team_id", "evidence_id", "material_id", "signal_type",
          "severity", "confidence", "safe_summary", "technical_details_json")
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL)
       ON CONFLICT (
         "evidence_id",
         COALESCE("material_id", '00000000-0000-0000-0000-000000000000'::uuid),
         "signal_type"
       ) DO UPDATE SET
         "safe_summary" = EXCLUDED."safe_summary",
         "severity" = EXCLUDED."severity",
         "confidence" = EXCLUDED."confidence",
         "updated_at_utc" = NOW()`,
      input.teamId,
      input.evidenceId,
      input.signalType,
      input.severity,
      input.confidence,
      input.safeSummaryText,
    );
    return true;
  } catch {
    // Per-row failures are best-effort; the caller is bounded.
    return false;
  }
}
