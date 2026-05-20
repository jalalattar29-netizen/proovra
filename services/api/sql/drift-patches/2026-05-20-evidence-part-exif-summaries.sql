-- =============================================================================
-- Phase 31.8 — Bounded per-EvidencePart EXIF summary persistence
-- =============================================================================
--
-- Adds the persistence layer for the EXIF extractor library shipped in
-- Phase 31.7. The extractor itself is a pure function over byte input
-- (see `services/api/src/services/media-intelligence/exif-extractor.service.ts`);
-- this table records the BOUNDED projection produced by the worker
-- after a successful S3 fetch + parse.
--
-- Hard custody / privacy rules:
--   * One row per (team_id, evidence_part_id). Re-running the
--     extractor UPDATES the row in place (idempotent).
--   * Raw GPS is NEVER stored. We persist only `has_gps` (boolean).
--     Operators with explicit policy approval can re-extract with
--     `allow_raw_gps` at runtime; the persistence layer refuses to
--     keep it.
--   * Strings bounded: camera_make / camera_model / software each
--     VARCHAR(64), matching the extractor's STRING_FIELD_MAX.
--   * Date fields are TIMESTAMPTZ — exifr returns Date objects which
--     the extractor reproduces as ISO UTC.
--   * dimensions bounded by smallint range; orientation 1..8 per
--     EXIF spec.
--   * exifr_engine_version captured so a future format change can be
--     reasoned about without re-deriving from raw bytes.
--   * status / error bounded so failed extractions don't pollute
--     operator surfaces.
--
-- Anti-leak: NO storage_key, NO storage_bucket, NO multipart_upload_id,
-- NO signed_url. The evidence_part_id link is the only join key.
--
-- Side change: the existing `media_intelligence_runs_kind_bounded`
-- CHECK is widened to include `extract_exif` so the existing run-
-- tracker can record EXIF extraction lifecycle alongside the other 7
-- analyzer kinds. Backward-compatible: previous values stay valid.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS. The CHECK swap is
-- done by DROP + ADD inside the transaction so a partial application
-- never leaves the constraint with an inconsistent vocabulary.
--
-- Neon (or any PostgreSQL) application command:
--   psql "$DATABASE_URL" \
--     -f services/api/sql/drift-patches/2026-05-20-evidence-part-exif-summaries.sql

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Widen the runs CHECK to include extract_exif
-- -----------------------------------------------------------------------------

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
    'reconcile'
  ));

-- -----------------------------------------------------------------------------
-- 1b. Widen the signals CHECK to include DEVICE_METADATA_OBSERVATION
-- -----------------------------------------------------------------------------
--
-- The Phase 31.8 analyzer emits this signal when the real EXIF
-- extractor recorded at least one bounded device field (make /
-- model / dimensions / software). NEVER classifies the device.

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
    'TRANSCRIPT_AVAILABLE',
    'DEVICE_METADATA_OBSERVATION'
  ));

-- -----------------------------------------------------------------------------
-- 2. EXIF summary table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_part_exif_summaries" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "evidence_part_id"         UUID NOT NULL,

  -- High-level signal: did the parser find ANY recognised EXIF tag?
  -- false === no EXIF (e.g. PNG without tEXt blocks, or stripped).
  "exif_present"             BOOLEAN NOT NULL DEFAULT FALSE,

  -- Bounded time fields. exifr surfaces these as Date objects. We
  -- persist as TZ-aware timestamptz — the extractor documents that
  -- DateTimeOriginal is naive-local in the EXIF spec and surfaces a
  -- best-effort ISO. Downstream consumers know to interpret with
  -- care; the SAFE_SUMMARY library carries the wording.
  "date_time_original_utc"   TIMESTAMPTZ(6),
  "create_date_utc"          TIMESTAMPTZ(6),

  -- Image dimensions. NULL if the parser couldn't extract them.
  "image_width_px"           INTEGER,
  "image_height_px"          INTEGER,

  -- Device metadata. NULL when missing / rejected by sanitisation.
  -- Bounded to 64 chars — matches the extractor's
  -- STRING_FIELD_MAX constant.
  "camera_make"              VARCHAR(64),
  "camera_model"             VARCHAR(64),
  "software"                 VARCHAR(64),

  -- GPS presence flag only. Raw coordinates NEVER stored. A future
  -- policy layer that wants to expose raw GPS will need to either
  -- (a) re-extract on demand with `allow_raw_gps: true`, or (b)
  -- add a separate, RBAC-gated column. We deliberately keep this
  -- table redaction-safe by default.
  "has_gps"                  BOOLEAN NOT NULL DEFAULT FALSE,

  -- EXIF orientation flag (1..8) per the EXIF spec. NULL when
  -- absent.
  "orientation"              SMALLINT,

  -- Provenance + lifecycle.
  "engine_version"           VARCHAR(48) NOT NULL DEFAULT 'exifr-v7-phase31-v1',
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "extracted_bytes"          INTEGER NOT NULL DEFAULT 0,

  -- Operator-readable status. Useful when the extractor refused
  -- the bytes (e.g. parse_failed, input_too_large).
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'OK',
  "last_error"               VARCHAR(240),

  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_part_exif_summaries_dim_w_bounded"
    CHECK ("image_width_px" IS NULL OR ("image_width_px" > 0 AND "image_width_px" <= 200000)),
  CONSTRAINT "evidence_part_exif_summaries_dim_h_bounded"
    CHECK ("image_height_px" IS NULL OR ("image_height_px" > 0 AND "image_height_px" <= 200000)),
  CONSTRAINT "evidence_part_exif_summaries_orientation_bounded"
    CHECK ("orientation" IS NULL OR ("orientation" >= 1 AND "orientation" <= 8)),
  CONSTRAINT "evidence_part_exif_summaries_status_bounded"
    CHECK ("status" IN (
      'OK',
      'PARSE_FAILED',
      'UNSUPPORTED_FORMAT',
      'INPUT_TOO_LARGE',
      'EMPTY_INPUT',
      'FETCH_FAILED'
    ))
);

-- One row per (team, evidence_part). Per-team unique so cross-tenant
-- enumeration is impossible at the index layer; the evidence_part_id
-- is globally unique but we anchor on team for defence in depth.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_exif_summaries_team_part_uk"
  ON "evidence_part_exif_summaries" ("team_id", "evidence_part_id");

-- Per-evidence lookup (used by the analyzer).
CREATE INDEX IF NOT EXISTS "evidence_part_exif_summaries_evidence_idx"
  ON "evidence_part_exif_summaries" ("evidence_id");

-- Operator backlog visibility.
CREATE INDEX IF NOT EXISTS "evidence_part_exif_summaries_status_updated_idx"
  ON "evidence_part_exif_summaries" ("status", "updated_at_utc" DESC);

COMMIT;
