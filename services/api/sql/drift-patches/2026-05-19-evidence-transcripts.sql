-- =============================================================================
-- Phase 24-J — Evidence Transcript foundations
-- =============================================================================
--
-- Creates `evidence_transcript_segments`: a dedicated store for
-- per-segment transcripts of audio / video evidence. Each row is a
-- single transcript segment with millisecond start/end offsets so the
-- timeline-discovery surface can deep-link to the exact moment.
--
-- This patch SHIPS THE SCHEMA ONLY. No transcription engine is wired
-- up. The Discovery search service treats this as a safe text source
-- once a row's `redacted = false` AND `visibility_scope <> 'BLOCKED'`.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-transcripts.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "evidence_transcript_segments" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "part_id"                  UUID,
  "segment_index"            INTEGER NOT NULL,
  "start_ms"                 INTEGER NOT NULL,
  "end_ms"                   INTEGER NOT NULL,
  "speaker_id"               VARCHAR(64),
  "engine"                   VARCHAR(40) NOT NULL,
  "language_hint"            VARCHAR(16),
  "text"                     TEXT NOT NULL,
  "confidence"               REAL,
  "visibility_scope"         VARCHAR(24) NOT NULL DEFAULT 'TEAM',
  "redacted"                 BOOLEAN NOT NULL DEFAULT FALSE,
  "indexed_at_utc"           TIMESTAMPTZ(6),
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_transcript_segments_segment_index_nonneg"
    CHECK ("segment_index" >= 0),
  CONSTRAINT "evidence_transcript_segments_offsets_nonneg"
    CHECK ("start_ms" >= 0 AND "end_ms" >= "start_ms"),
  CONSTRAINT "evidence_transcript_segments_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "evidence_transcript_segments_visibility_scope_bounded"
    CHECK ("visibility_scope" IN (
      'TEAM', 'REVIEWER_RESTRICTED', 'CONTRIBUTOR_PRIVATE', 'BLOCKED'
    ))
);

-- One segment per (evidence_id, part_id, segment_index).
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_transcript_segments_uk"
  ON "evidence_transcript_segments" (
    "evidence_id",
    COALESCE("part_id", '00000000-0000-0000-0000-000000000000'),
    "segment_index"
  );

-- Workspace-scoped lookups.
CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_team_evidence_idx"
  ON "evidence_transcript_segments" ("team_id", "evidence_id");

-- Indexing-lag readiness check support: segments waiting for the
-- indexer to consume them.
CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_unindexed_idx"
  ON "evidence_transcript_segments" ("team_id", "extracted_at_utc" DESC)
  WHERE "indexed_at_utc" IS NULL;

COMMIT;
