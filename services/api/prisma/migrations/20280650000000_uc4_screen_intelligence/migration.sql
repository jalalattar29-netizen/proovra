-- =============================================================================
-- UC-4 — DERIVED screen intelligence.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Two additive, forward-only, idempotent changes.
-- Nothing is dropped, narrowed, or backfilled. A deployment still running the
-- prior build is unaffected until its code is replaced.
--
-- 1. Widen `media_intelligence_runs_kind_bounded` to admit the UC-4 run kind
--    `reconstruct_screen`. UC-4 reuses the durable MediaIntelligenceRun
--    lifecycle (claim/lease/fence/reconciler) on the existing media-intelligence
--    queue rather than introducing a second queue. The new set is a strict
--    SUPERSET of the old one, so no existing row can violate it and the ADD
--    cannot fail on legacy data. (CHECK constraints are invisible to
--    `prisma migrate diff`, so this needs no raw-schema-ownership entry.)
--
-- 2. Add two labels to `EvidenceExtractedTextKind` so UC-4 derived text is
--    persisted through the CANONICAL extracted-text authority (which already
--    feeds search and is swept by destruction), with honest provenance:
--      * OCR_SCREEN            — DERIVED_MACHINE_EXTRACTED (local Tesseract OCR)
--      * SCREEN_RECONSTRUCTION — DERIVED_RECONSTRUCTED    (reconstructed review)
--    `ADD VALUE IF NOT EXISTS` is idempotent; the datamodel declares both so the
--    enum residual is clean.
-- =============================================================================

-- 1. Run-kind catalog ---------------------------------------------------------
ALTER TABLE "media_intelligence_runs"
  DROP CONSTRAINT IF EXISTS "media_intelligence_runs_kind_bounded";

ALTER TABLE "media_intelligence_runs"
  ADD CONSTRAINT "media_intelligence_runs_kind_bounded"
  CHECK ("kind" IN (
    'analyze_metadata',
    'extract_exif',
    'extract_assets',
    'compute_duplicates',
    'compute_lineage',
    'wire_ocr_transcript',
    'reindex',
    'reconcile',
    'compute_perceptual_hashes',
    'extract_ocr_azure',
    'extract_transcript_deepgram',
    'extract_technical_metadata',
    'reconcile_ocr_similarity',
    'reconcile_transcript_similarity',
    -- UC-4.
    'reconstruct_screen'
  ));

-- 2. Extracted-text provenance kinds -----------------------------------------
ALTER TYPE "EvidenceExtractedTextKind" ADD VALUE IF NOT EXISTS 'OCR_SCREEN';
ALTER TYPE "EvidenceExtractedTextKind" ADD VALUE IF NOT EXISTS 'SCREEN_RECONSTRUCTION';

-- 3. Derived-asset kind catalog ----------------------------------------------
-- UC4-C declared `video_keyframe` / `screen_reconstruction` in code with a note
-- that `asset_kind` was a free VARCHAR — but the table in fact carries a bounded
-- CHECK (`evidence_part_derived_assets_kind_bounded`) enumerating the original
-- five kinds, so `recordDerivedAsset` would have been REJECTED at runtime for
-- both UC-4 kinds. (CHECK constraints are invisible to `prisma migrate diff`,
-- which is why raw-schema-verify never surfaced it.) Widen the catalog to a
-- strict SUPERSET — no existing row can violate it and the ADD cannot fail.
ALTER TABLE "evidence_part_derived_assets"
  DROP CONSTRAINT IF EXISTS "evidence_part_derived_assets_kind_bounded";

ALTER TABLE "evidence_part_derived_assets"
  ADD CONSTRAINT "evidence_part_derived_assets_kind_bounded"
  CHECK ("asset_kind" IN (
    'image_thumbnail',
    'video_frame',
    'audio_waveform',
    'low_res_proxy',
    'compact_review_preview',
    -- UC-4.
    'video_keyframe',
    'screen_reconstruction'
  ));
