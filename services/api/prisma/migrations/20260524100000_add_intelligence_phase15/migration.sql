-- Phase 15 — Enterprise intelligence platform
--
-- Forward-only additive migration:
--   * 6 new enums (EvidenceIntelligenceJobKind, EvidenceIntelligenceJobStatus,
--     EvidenceExtractedTextKind, EvidenceExtractedTextStatus,
--     EvidenceEntityKind, EvidenceEntitySource, EvidenceSimilarityKind).
--   * 5 new tables (jobs, extracted texts, entities, semantic chunks,
--     similarities).
--   * No existing column altered.
--
-- All intelligence rows are ADVISORY ONLY. They never mutate the
-- evidence row, its custody chain, fileSha256, or fingerprint.
--
-- Rollback:
--   DROP TABLE IF EXISTS evidence_similarities;
--   DROP TABLE IF EXISTS evidence_semantic_chunks;
--   DROP TABLE IF EXISTS evidence_entities;
--   DROP TABLE IF EXISTS evidence_extracted_texts;
--   DROP TABLE IF EXISTS evidence_intelligence_jobs;
--   DROP TYPE  IF EXISTS "EvidenceSimilarityKind";
--   DROP TYPE  IF EXISTS "EvidenceEntitySource";
--   DROP TYPE  IF EXISTS "EvidenceEntityKind";
--   DROP TYPE  IF EXISTS "EvidenceExtractedTextStatus";
--   DROP TYPE  IF EXISTS "EvidenceExtractedTextKind";
--   DROP TYPE  IF EXISTS "EvidenceIntelligenceJobStatus";
--   DROP TYPE  IF EXISTS "EvidenceIntelligenceJobKind";

-- 1. Enums ----------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "EvidenceIntelligenceJobKind" AS ENUM (
    'OCR', 'TRANSCRIPT', 'ENTITY_EXTRACTION', 'EMBEDDING', 'SIMILARITY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceIntelligenceJobStatus" AS ENUM (
    'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceExtractedTextKind" AS ENUM (
    'OCR_PDF', 'OCR_IMAGE', 'PDF_TEXT', 'TRANSCRIPT_AUDIO', 'TRANSCRIPT_VIDEO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceExtractedTextStatus" AS ENUM (
    'PENDING', 'COMPLETED', 'FAILED', 'SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceEntityKind" AS ENUM (
    'PERSON', 'EMAIL', 'PHONE', 'ORG', 'LOCATION', 'DATE', 'REFERENCE_ID', 'URL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceEntitySource" AS ENUM (
    'OCR', 'TRANSCRIPT', 'METADATA', 'AI', 'MANUAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EvidenceSimilarityKind" AS ENUM (
    'HASH_DUPLICATE', 'FILENAME_SIMILAR', 'OCR_SIMILAR',
    'TRANSCRIPT_SIMILAR', 'METADATA_SIMILAR', 'EMBEDDING_SIMILAR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Tables ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_intelligence_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "kind" "EvidenceIntelligenceJobKind" NOT NULL,
  "status" "EvidenceIntelligenceJobStatus" NOT NULL DEFAULT 'PENDING',
  "provider" VARCHAR(64),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" VARCHAR(400),
  "scheduled_at_utc" TIMESTAMPTZ(6),
  "started_at_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_intelligence_jobs_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "evidence_intelligence_jobs_ev_kind_status_idx"
  ON "evidence_intelligence_jobs" ("evidence_id", "kind", "status");
CREATE INDEX IF NOT EXISTS "evidence_intelligence_jobs_team_status_created_idx"
  ON "evidence_intelligence_jobs" ("team_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_intelligence_jobs_status_scheduled_idx"
  ON "evidence_intelligence_jobs" ("status", "scheduled_at_utc");

CREATE TABLE IF NOT EXISTS "evidence_extracted_texts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "kind" "EvidenceExtractedTextKind" NOT NULL,
  "status" "EvidenceExtractedTextStatus" NOT NULL DEFAULT 'PENDING',
  "provider" VARCHAR(64) NOT NULL,
  "provider_version" VARCHAR(64),
  "language" VARCHAR(16),
  "text" TEXT,
  "confidence" DOUBLE PRECISION,
  "word_count" INTEGER,
  "duration_ms" INTEGER,
  "error_message" VARCHAR(400),
  "extracted_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_extracted_texts_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "evidence_extracted_texts_ev_kind_idx"
  ON "evidence_extracted_texts" ("evidence_id", "kind");
CREATE INDEX IF NOT EXISTS "evidence_extracted_texts_team_status_idx"
  ON "evidence_extracted_texts" ("team_id", "status");

CREATE TABLE IF NOT EXISTS "evidence_entities" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "kind" "EvidenceEntityKind" NOT NULL,
  "source" "EvidenceEntitySource" NOT NULL,
  "value" VARCHAR(512) NOT NULL,
  "normalized_value" VARCHAR(512),
  "confidence" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_entities_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "evidence_entities_ev_kind_idx"
  ON "evidence_entities" ("evidence_id", "kind");
CREATE INDEX IF NOT EXISTS "evidence_entities_team_kind_norm_idx"
  ON "evidence_entities" ("team_id", "kind", "normalized_value");

CREATE TABLE IF NOT EXISTS "evidence_semantic_chunks" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "chunk_index" INTEGER NOT NULL,
  "chunk_text" TEXT NOT NULL,
  "embedding_provider" VARCHAR(64),
  "embedding_model" VARCHAR(128),
  "embedding_dimensions" INTEGER,
  "embedding" BYTEA,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_semantic_chunks_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_semantic_chunks_ev_chunk_unique"
  ON "evidence_semantic_chunks" ("evidence_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "evidence_semantic_chunks_team_idx"
  ON "evidence_semantic_chunks" ("team_id");

CREATE TABLE IF NOT EXISTS "evidence_similarities" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "source_evidence_id" UUID NOT NULL,
  "target_evidence_id" UUID NOT NULL,
  "kind" "EvidenceSimilarityKind" NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "advisory_summary" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_similarities_source_fkey"
    FOREIGN KEY ("source_evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_similarities_target_fkey"
    FOREIGN KEY ("target_evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_similarities_pair_kind_unique"
  ON "evidence_similarities" ("source_evidence_id", "target_evidence_id", "kind");
CREATE INDEX IF NOT EXISTS "evidence_similarities_team_kind_score_idx"
  ON "evidence_similarities" ("team_id", "kind", "score" DESC);
CREATE INDEX IF NOT EXISTS "evidence_similarities_source_kind_idx"
  ON "evidence_similarities" ("source_evidence_id", "kind");
CREATE INDEX IF NOT EXISTS "evidence_similarities_target_kind_idx"
  ON "evidence_similarities" ("target_evidence_id", "kind");
