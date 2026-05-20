-- =============================================================================
-- Phase 31 — Media intelligence signals (read-only advisory layer)
-- =============================================================================
--
-- Single table that stores DETERMINISTIC advisory signals computed
-- by the Phase 31 analyzer service. The signals are NEVER:
--   * truth/authenticity/admissibility claims
--   * identity / face-recognition outputs
--   * manipulation conclusions
--   * legal determinations
--
-- They are bounded, explainable advisory notes — operator-visible
-- hints for reviewers, surfaced via the read API + future UI
-- panels. Custody / finalize / report flows NEVER block on these.
--
-- Hard custody rules encoded in the schema:
--   * `signal_type` is bounded by CHECK constraint matching the
--     service-layer SIGNAL_TYPES catalog exactly. Adding a type
--     requires both this constraint and a code change.
--   * `severity` ∈ {INFO, REVIEW_RECOMMENDED, ATTENTION}. The
--     vocabulary deliberately avoids "WARNING" / "CRITICAL" /
--     "ALERT" to keep tone advisory.
--   * `confidence` ∈ {LOW, MEDIUM, HIGH}. Bounded; analyzer
--     callers set this based on the strength of the underlying
--     deterministic check.
--   * `safe_summary` is bounded to 240 chars. The wording is
--     enforced by the service layer's safe-wording library — the
--     DB just bounds length.
--   * `status` tracks the operator-acknowledgement lifecycle
--     (PENDING → ACKNOWLEDGED, or PENDING → DISMISSED).
--   * `technical_details_json` is a bounded JSONB blob for
--     internal-only diagnostic state. Never exposed to public
--     verify / external reviewer surfaces. The route layer that
--     reads this table is responsible for projection.
--
-- Idempotency: re-running the analyzer for the same evidence
-- emits the same signals. The unique index on
--   (evidence_id, material_id, signal_type)
-- ensures retries don't create duplicate rows. The analyzer uses
-- ON CONFLICT to update `safe_summary` + `technical_details_json`
-- without resetting acknowledged status.
--
-- The patch is IDEMPOTENT + PARTIAL-STATE-SAFE:
--   * CREATE TABLE IF NOT EXISTS.
--   * CREATE INDEX IF NOT EXISTS.
--   * No destructive operations.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-media-intelligence-signals.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "media_intelligence_signals" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  -- NULL when the signal applies to the whole Evidence (e.g.
  -- DUPLICATE_HASH_MATCH against another Evidence). Non-NULL when
  -- the signal is tied to a specific EvidencePart.
  "material_id"              UUID,
  "signal_type"              VARCHAR(48) NOT NULL,
  "severity"                 VARCHAR(24) NOT NULL DEFAULT 'INFO',
  "confidence"               VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  -- Operator-readable summary. Bounded to 240 chars. The service-
  -- layer SafeWording library produces these from a closed set of
  -- templates so the tone stays advisory.
  "safe_summary"             VARCHAR(240) NOT NULL,
  -- Internal diagnostic JSON. Never exposed via public verify or
  -- external reviewer surfaces. Operator UI may render selected
  -- safe fields.
  "technical_details_json"   JSONB,
  -- Lifecycle: PENDING (default), ACKNOWLEDGED (reviewer marked
  -- as understood / not concerning), DISMISSED (reviewer marked
  -- as not actionable). No state for "confirmed manipulation" or
  -- similar — those determinations are out of platform scope.
  "status"                   VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "acknowledged_by_user_id"  UUID,
  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "engine_version"           VARCHAR(48) NOT NULL DEFAULT 'phase31-v1',
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "media_intelligence_signals_signal_type_bounded"
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
      'TRANSCRIPT_AVAILABLE'
    )),
  CONSTRAINT "media_intelligence_signals_severity_bounded"
    CHECK ("severity" IN ('INFO', 'REVIEW_RECOMMENDED', 'ATTENTION')),
  CONSTRAINT "media_intelligence_signals_confidence_bounded"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT "media_intelligence_signals_status_bounded"
    CHECK ("status" IN ('PENDING', 'ACKNOWLEDGED', 'DISMISSED'))
);

-- Idempotency: re-runs of the analyzer upsert into the same
-- (evidence_id, material_id, signal_type) tuple. NULL material_id
-- needs special handling because PG treats NULLs as distinct in
-- unique indexes — we use COALESCE on a sentinel UUID for the
-- partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_signals_evidence_material_type_uk"
  ON "media_intelligence_signals" (
    "evidence_id",
    COALESCE("material_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "signal_type"
  );

-- Per-team activity feed: "what intelligence has been generated
-- for my workspace recently?"
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_team_status_idx"
  ON "media_intelligence_signals" ("team_id", "status", "updated_at_utc" DESC);

-- Per-evidence drilldown: "all signals for this evidence record."
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_evidence_severity_idx"
  ON "media_intelligence_signals" ("evidence_id", "severity");

-- Operator queue: "which PENDING signals need triage?"
CREATE INDEX IF NOT EXISTS "media_intelligence_signals_pending_idx"
  ON "media_intelligence_signals" ("team_id", "created_at_utc" DESC)
  WHERE "status" = 'PENDING';

COMMIT;
