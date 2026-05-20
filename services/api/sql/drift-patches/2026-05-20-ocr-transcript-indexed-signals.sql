-- =============================================================================
-- Phase 31.20 — widen media_intelligence_signals.signal_type CHECK to
-- include the two new "indexed" markers (OCR_INDEXED + TRANSCRIPT_INDEXED).
-- =============================================================================
--
-- Background:
--   The Phase 31.20 OCR / transcript producers emit two signal types per
--   surface:
--     * OCR_AVAILABLE       — at least one non-redacted, non-blocked
--                              `evidence_ocr_text` row exists for the
--                              evidence record.
--     * OCR_INDEXED         — at least one of those rows has
--                              `indexed_at_utc IS NOT NULL` (the search
--                              projection has consumed it).
--     * TRANSCRIPT_AVAILABLE — symmetric for `evidence_transcript_segments`.
--     * TRANSCRIPT_INDEXED   — symmetric.
--
--   The two AVAILABLE signal types are already in the catalog and the
--   schema CHECK constraint. This patch adds the two _INDEXED signal
--   types to the CHECK constraint so the indexing producer can insert
--   them without violating the bounded vocabulary.
--
-- Hard schema rules preserved:
--   * `signal_type` remains bounded by CHECK constraint.
--   * No destructive operations — DROP then ADD is the standard pattern
--     for widening a CHECK constraint without losing the bound.
--   * Idempotent: re-running this patch is a no-op (the DROP is
--     conditional and the ADD overwrites the constraint).
--
-- Rollback:
--   To revert, run the same DROP CONSTRAINT then re-issue the previous
--   ADD CONSTRAINT (see 2026-05-20-evidence-part-exif-summaries.sql line
--   77-101 for the previous bounded list).
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-ocr-transcript-indexed-signals.sql

BEGIN;

ALTER TABLE "media_intelligence_signals"
  DROP CONSTRAINT IF EXISTS "media_intelligence_signals_signal_type_bounded";

ALTER TABLE "media_intelligence_signals"
  ADD CONSTRAINT "media_intelligence_signals_signal_type_bounded"
    CHECK ("signal_type" IN (
      'EXIF_MISSING',
      'EXIF_TIMESTAMP_MISMATCH',
      'CLIENT_SERVER_TIME_GAP',
      'MIME_EXTENSION_MISMATCH',
      'CODEC_CONTAINER_OBSERVATION',
      'SCREENSHOT_LIKE_FILENAME',
      'DUPLICATE_HASH_MATCH',
      'SIMILAR_FILE_CANDIDATE',
      'POSSIBLE_DERIVATIVE_FILE',
      'TRANSCODING_LINEAGE_CANDIDATE',
      'AUDIO_METADATA_OBSERVATION',
      'VIDEO_DURATION_OBSERVATION',
      'FRAME_EXTRACTION_AVAILABLE',
      'THUMBNAIL_AVAILABLE',
      'OCR_AVAILABLE',
      'OCR_INDEXED',
      'TRANSCRIPT_AVAILABLE',
      'TRANSCRIPT_INDEXED',
      'DEVICE_METADATA_OBSERVATION'
    ));

COMMIT;
