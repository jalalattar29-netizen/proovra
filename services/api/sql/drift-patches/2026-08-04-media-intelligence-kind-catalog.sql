-- PHASE 12 — POINT 5 drift patch: widen media_intelligence_runs.kind.
--
-- Mirror of migration 20271114000000_point5_media_intelligence_kind_catalog.
-- Absorbed by that migration; see 2026-08-04-media-intelligence-kind-catalog.sql
-- See that file for the full rationale; the short version is that the CHECK
-- constraint enumerated eight kinds while the worker implemented twelve, so
-- four kinds that producers actually enqueue could not have a run row inserted
-- for them at all.
--
-- Idempotent and superset-only: DROP IF EXISTS then ADD, and every previously
-- valid value stays valid, so no existing row can violate the new constraint.

BEGIN;

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
    'reconcile_transcript_similarity'
  ));

COMMIT;
