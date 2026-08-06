-- PHASE 12 — POINT 5: widen media_intelligence_runs.kind to the real catalog.
--
-- OWNER_MIGRATION_PENDING. Forward-only, guarded, idempotent.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `media_intelligence_runs_kind_bounded` still enumerated the eight kinds that
-- existed when the table was created. Since then the worker gained four more
-- and producers enqueue all four:
--
--   * compute_perceptual_hashes   (Wave 2 — pHash/dHash producer)
--   * extract_ocr_azure           (Wave 4 — Azure Document Intelligence)
--   * extract_transcript_deepgram (Wave 4 — Deepgram)
--   * extract_technical_metadata  (Enterprise Technical Metadata layer)
--
-- The constraint REJECTED every one of them. That is the root cause behind a
-- defect chain found in Point 5, not merely a stale enum: because a run row
-- could not be inserted for those kinds, `enqueueMediaIntelligenceAnalysis`
-- was given an OPTIONAL `runId`, and the finalization fan-out then called it
-- with none. Those jobs ran with no durable row to record PROCESSING /
-- COMPLETED / FAILED on — invisible to operators and unrecoverable by any
-- reconciler, because there was nothing to find.
--
-- Point 5 also adds two kinds. The text-similarity promotion path used to be
-- selected by an optional `textKind` field on the queue payload that NO
-- producer anywhere set, so the branch was unreachable. It is now addressed by
-- run kind instead, which is why these two appear:
--
--   * reconcile_ocr_similarity
--   * reconcile_transcript_similarity
--
-- `compute_duplicates` and `compute_lineage` are RETAINED. No producer enqueues
-- them and no queue accepts them, but historical rows exist and narrowing the
-- constraint would make those rows unreadable through any path that revalidates.
--
-- GUARDS
-- ---------------------------------------------------------------------------
--   * DROP ... IF EXISTS then ADD, so a re-run after a partial apply is a clean
--     no-op;
--   * the new set is a strict SUPERSET of the old one, so no existing row can
--     violate it and the ADD cannot fail on legacy data;
--   * no column is altered or dropped, so a deployment still running the prior
--     build is unaffected until its code is replaced.

ALTER TABLE "media_intelligence_runs"
  DROP CONSTRAINT IF EXISTS "media_intelligence_runs_kind_bounded";

ALTER TABLE "media_intelligence_runs"
  ADD CONSTRAINT "media_intelligence_runs_kind_bounded"
  CHECK ("kind" IN (
    -- Original eight.
    'analyze_metadata',
    'extract_exif',
    'extract_assets',
    'compute_duplicates',
    'compute_lineage',
    'wire_ocr_transcript',
    'reindex',
    'reconcile',
    -- Implemented by the worker, enqueued by producers, rejected by the DB
    -- until this migration.
    'compute_perceptual_hashes',
    'extract_ocr_azure',
    'extract_transcript_deepgram',
    'extract_technical_metadata',
    -- PHASE 12 POINT 5 — the text-similarity passes, now addressed by run kind
    -- rather than by an unreachable payload field.
    'reconcile_ocr_similarity',
    'reconcile_transcript_similarity'
  ));

-- Absorbs drift patch: 2026-08-04-media-intelligence-kind-catalog.sql
