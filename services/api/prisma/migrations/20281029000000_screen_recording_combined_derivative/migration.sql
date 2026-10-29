-- =============================================================================
-- 2026-10-29 — the DERIVED combined screen recording.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Three constraint SWAPS, each to a strict SUPERSET
-- of the set it replaces, so no existing row can violate the new constraint and
-- no ADD can fail on legacy data. Nothing is dropped for good, narrowed,
-- rewritten or backfilled; an image that predates this migration never writes
-- the new values, so it is unaffected (safe before the code and after a
-- rollback). Idempotent (DROP ... IF EXISTS, then ADD).
--
-- WHY: a continuous screen recording sealed before single-file recording is
-- preserved as N ORIGINAL segment parts + its continuity manifest. PROOVRA now
-- derives ONE combined MP4 from them (verified against the sealed digests,
-- joined in sequence, gaps kept) as an explicitly labelled DERIVED asset with
-- multi-source lineage. The originals, the manifest and every digest,
-- signature, custody event and fingerprint stay untouched.
--
-- 1. `media_intelligence_runs_kind_bounded` admits the run kind
--    `combine_screen_recording` (it rides the existing media-intelligence queue
--    and the durable MediaIntelligenceRun claim/lease/fence/reconciler).
-- 2. `evidence_part_derived_assets_kind_bounded` admits the asset kind
--    `screen_recording_combined`.
-- 3. `evidence_part_derived_assets_size_bounded` is raised from 50,000,000 to
--    671,088,640 bytes (640 MiB): the continuous-session ceiling (512 MiB,
--    CAPTURE_LIMITS.maxContinuousSessionBytes) plus container / re-encode
--    overhead (SCREEN_RECORDING_COMBINE_BOUNDS.maxOutputBytes). It still fits
--    the INT4 `size_bytes` column. The lower bound (>= 0) is unchanged.
--
-- (CHECK constraints are invisible to `prisma migrate diff`; the datamodel is
-- unchanged apart from comments.) Each ADD validates the table under its
-- ACCESS EXCLUSIVE lock — both tables are small (one row per run / per derived
-- artifact); apply outside a derived-asset burst.
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
    'reconstruct_screen',
    -- 2026-10-29.
    'combine_screen_recording'
  ));

-- 2. Derived-asset kind catalog -----------------------------------------------
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
    'video_keyframe',
    'screen_reconstruction',
    -- 2026-10-29.
    'screen_recording_combined'
  ));

-- 3. Derived-asset size bound -------------------------------------------------
ALTER TABLE "evidence_part_derived_assets"
  DROP CONSTRAINT IF EXISTS "evidence_part_derived_assets_size_bounded";

ALTER TABLE "evidence_part_derived_assets"
  ADD CONSTRAINT "evidence_part_derived_assets_size_bounded"
  CHECK ("size_bytes" IS NULL OR ("size_bytes" >= 0 AND "size_bytes" <= 671088640));
