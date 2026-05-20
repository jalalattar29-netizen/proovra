-- =============================================================================
-- Phase 31.13 — Derived assets pipeline persistence
-- =============================================================================
--
-- Persists the bounded record for derived media artifacts (image
-- thumbnails this session; representative video frames + audio
-- waveforms when ffmpeg is added in a future phase).
--
-- Hard custody / privacy rules:
--
--   * Derived assets NEVER replace originals. The original
--     `evidence_parts` row is unchanged. The derived bytes are
--     stored in a separate S3 prefix with their own SHA-256.
--   * One row per (team_id, evidence_part_id, asset_kind) — a
--     given part can have multiple derived kinds (e.g. an
--     image_thumbnail and a future low_res_proxy), but only one
--     entry per kind. Re-running the worker UPDATES the existing
--     row.
--   * Bounded status enum so failures are auditable + bounded
--     last_error so stack traces / storage paths cannot leak.
--   * `derived_sha256` is the SHA-256 of the DERIVED bytes — NOT
--     the source. The source linkage lives in
--     `source_sha256_at_generation` which records the source
--     hash AT THE MOMENT the derived asset was generated, so
--     downstream consumers can verify the source has not been
--     mutated since (cross-checking against the canonical
--     `evidence_parts.sha256`).
--   * Storage internals (bucket, key) ARE persisted here because
--     the worker needs them to serve the bytes back. They are
--     NEVER projected to any API response — the read endpoint
--     emits ONLY `id`, `assetKind`, `derivedSha256`, `sizeBytes`,
--     `widthPx`, `heightPx`, `contentType`, `status`,
--     `generatedAtUtc` (and an opaque signed download token only
--     when the caller has explicit access).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS.
--
-- Apply with:
--   psql "$DATABASE_URL" \
--     -f services/api/sql/drift-patches/2026-05-20-evidence-part-derived-assets.sql
--
-- Rollback:
--   DROP TABLE IF EXISTS "evidence_part_derived_assets";

BEGIN;

CREATE TABLE IF NOT EXISTS "evidence_part_derived_assets" (
  "id"                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                           UUID NOT NULL,
  "evidence_id"                       UUID NOT NULL,
  "evidence_part_id"                  UUID NOT NULL,

  -- Bounded asset kind.
  -- image_thumbnail        — small image preview (this phase, via sharp)
  -- video_frame            — representative video frame (future, via ffmpeg)
  -- audio_waveform         — waveform image preview (future, via ffmpeg)
  -- low_res_proxy          — full-asset low-resolution proxy (future)
  -- compact_review_preview — compact reviewer-facing preview (future)
  "asset_kind"                        VARCHAR(48) NOT NULL,

  -- Bounded lifecycle status.
  -- PENDING      — row created; worker not yet started
  -- PROCESSING   — worker has the job
  -- COMPLETED    — bytes generated + stored
  -- FAILED       — worker tried + gave up (last_error carries reason)
  -- UNSUPPORTED  — capability detection refused (no sharp/ffmpeg)
  "status"                            VARCHAR(24) NOT NULL DEFAULT 'PENDING',

  -- Derived bytes provenance.
  "derived_sha256"                    VARCHAR(64),
  "size_bytes"                        INTEGER,
  "content_type"                      VARCHAR(80),
  "width_px"                          INTEGER,
  "height_px"                         INTEGER,

  -- Source linkage. The source hash AT THE MOMENT the derived
  -- asset was generated. Lets downstream consumers verify the
  -- source has not been mutated since (they cross-check against
  -- the canonical evidence_parts.sha256).
  "source_sha256_at_generation"       VARCHAR(64),

  -- Storage reference — INTERNAL USE ONLY. Never projected to
  -- any API response. The read API serves the bytes via the
  -- bounded download endpoint (with auth checks) that reads
  -- these columns internally.
  "storage_bucket"                    VARCHAR(255),
  "storage_key"                       VARCHAR(512),

  -- Bounded error summary for failed generations.
  "last_error"                        VARCHAR(240),

  -- Provenance.
  "engine_version"                    VARCHAR(48) NOT NULL DEFAULT 'sharp-v0-phase31-v1',
  "generated_at_utc"                  TIMESTAMPTZ(6),
  "created_at_utc"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_part_derived_assets_kind_bounded"
    CHECK ("asset_kind" IN (
      'image_thumbnail',
      'video_frame',
      'audio_waveform',
      'low_res_proxy',
      'compact_review_preview'
    )),
  CONSTRAINT "evidence_part_derived_assets_status_bounded"
    CHECK ("status" IN (
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'UNSUPPORTED'
    )),
  CONSTRAINT "evidence_part_derived_assets_dim_w_bounded"
    CHECK ("width_px" IS NULL OR ("width_px" > 0 AND "width_px" <= 200000)),
  CONSTRAINT "evidence_part_derived_assets_dim_h_bounded"
    CHECK ("height_px" IS NULL OR ("height_px" > 0 AND "height_px" <= 200000)),
  CONSTRAINT "evidence_part_derived_assets_size_bounded"
    CHECK ("size_bytes" IS NULL OR ("size_bytes" >= 0 AND "size_bytes" <= 50000000))
);

-- One row per (team, part, kind). Re-running the worker upserts.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_derived_assets_team_part_kind_uk"
  ON "evidence_part_derived_assets" ("team_id", "evidence_part_id", "asset_kind");

-- Per-evidence drilldown.
CREATE INDEX IF NOT EXISTS "evidence_part_derived_assets_evidence_idx"
  ON "evidence_part_derived_assets" ("evidence_id");

-- Operator backlog visibility — failures + pending lookups.
CREATE INDEX IF NOT EXISTS "evidence_part_derived_assets_status_updated_idx"
  ON "evidence_part_derived_assets" ("status", "updated_at_utc" DESC);

COMMIT;
