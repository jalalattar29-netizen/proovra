-- =============================================================================
-- Phase 24-J — Evidence OCR Text foundations
-- =============================================================================
--
-- Creates `evidence_ocr_text`: a dedicated store for extracted OCR text
-- per evidence item / multipart part. The PROOVRA brief carries a hard
-- "OCR foundations" mandate — the platform must be able to ingest +
-- store OCR output safely so it can later be indexed and searched.
--
-- This patch SHIPS THE SCHEMA ONLY. No OCR engine is wired up. The
-- discovery search service treats the table as a safe text source via
-- $queryRaw — Prisma models will be added in a follow-up regeneration.
--
-- Hard schema rules:
--   * One row per (evidence_id, part_id). `part_id` is nullable when
--     the evidence is single-part.
--   * Text is bounded by chunk and a separate `chunk_index` field so
--     a long document's OCR can be paginated without a single
--     gargantuan row.
--   * The engine identifier is bounded (varchar 40) — we never store
--     model versions / API keys / privileged metadata.
--   * `confidence` is a normalised [0, 1] float so consumers can
--     decide to ignore low-confidence segments.
--   * GOVERNANCE INVARIANT: the visibility scope is denormalised onto
--     this row so the search-document indexer can refuse to surface
--     OCR text from a record under legal hold / contributor-private
--     scope.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-evidence-ocr-text.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "evidence_ocr_text" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "part_id"                  UUID,
  "chunk_index"              INTEGER NOT NULL DEFAULT 0,
  "engine"                   VARCHAR(40) NOT NULL,
  "language_hint"            VARCHAR(16),
  "text"                     TEXT NOT NULL,
  "confidence"               REAL,
  "visibility_scope"         VARCHAR(24) NOT NULL DEFAULT 'TEAM',
  "redacted"                 BOOLEAN NOT NULL DEFAULT FALSE,
  "indexed_at_utc"           TIMESTAMPTZ(6),
  "extracted_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_ocr_text_chunk_index_nonneg"
    CHECK ("chunk_index" >= 0),
  CONSTRAINT "evidence_ocr_text_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "evidence_ocr_text_visibility_scope_bounded"
    CHECK ("visibility_scope" IN (
      'TEAM', 'REVIEWER_RESTRICTED', 'CONTRIBUTOR_PRIVATE', 'BLOCKED'
    ))
);

-- One OCR row per (evidence_id, part_id, chunk_index) so re-runs of the
-- engine upsert deterministically.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_ocr_text_uk"
  ON "evidence_ocr_text" ("evidence_id", COALESCE("part_id", '00000000-0000-0000-0000-000000000000'), "chunk_index");

-- Workspace-scoped lookups (the search indexer joins by evidence id +
-- team id; this index supports both).
CREATE INDEX IF NOT EXISTS "evidence_ocr_text_team_evidence_idx"
  ON "evidence_ocr_text" ("team_id", "evidence_id");

-- "Show me OCR rows that the engine wrote but the indexer has not yet
-- consumed". Used by the indexing-lag readiness check.
CREATE INDEX IF NOT EXISTS "evidence_ocr_text_unindexed_idx"
  ON "evidence_ocr_text" ("team_id", "extracted_at_utc" DESC)
  WHERE "indexed_at_utc" IS NULL;

COMMIT;
