-- Phase 24 — Enterprise Evidence Discovery Platform
--
-- Forward-only additive migration:
--   * 2 new tables (evidence_search_documents, saved_search_views).
--   * No new enums (catalogs live in @proovra/shared and are stored
--     as bounded VARCHAR columns so they can grow without migrations).
--   * No existing column altered; no row mutated.
--
-- All Phase 24 rows are WORKSPACE-INTERNAL by design. Public verify,
-- OTS/TSA/anchor, report-v2, and verification package paths NEVER
-- read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS saved_search_views;
--   DROP TABLE IF EXISTS evidence_search_documents;

-- 1. evidence_search_documents -------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_search_documents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "document_type" VARCHAR(40) NOT NULL,
  "source_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "subtitle" VARCHAR(200),
  "summary" VARCHAR(400),
  "searchable_text" TEXT,
  "searchable_metadata_json" JSONB,
  "searchable_tags_json" JSONB,
  "visibility_scope_json" JSONB,
  "governance_scope_json" JSONB,
  "review_state" VARCHAR(40),
  "workflow_state" VARCHAR(40),
  "export_state" VARCHAR(40),
  "retention_state" VARCHAR(40),
  "legal_hold_state" VARCHAR(40),
  "contributor_scoped" BOOLEAN NOT NULL DEFAULT FALSE,
  "reviewer_restricted" BOOLEAN NOT NULL DEFAULT FALSE,
  "evidence_id" UUID,
  "workflow_instance_id" UUID,
  "workflow_step_instance_id" UUID,
  "case_id" UUID,
  "claim_ref" VARCHAR(128),
  "matter_ref" VARCHAR(128),
  "source_updated_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "indexed_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_search_documents_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE
);

-- Dedup compound: one row per (team, type, sourceId). Re-indexing a
-- single source UPSERTS this row rather than appending.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_search_documents_team_type_source_uk"
  ON "evidence_search_documents" ("team_id", "document_type", "source_id");

CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_source_updated_at_idx"
  ON "evidence_search_documents" ("team_id", "source_updated_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_document_type_idx"
  ON "evidence_search_documents" ("team_id", "document_type");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_workflow_state_idx"
  ON "evidence_search_documents" ("team_id", "workflow_state");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_review_state_idx"
  ON "evidence_search_documents" ("team_id", "review_state");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_legal_hold_state_idx"
  ON "evidence_search_documents" ("team_id", "legal_hold_state");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_export_state_idx"
  ON "evidence_search_documents" ("team_id", "export_state");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_contributor_scoped_idx"
  ON "evidence_search_documents" ("team_id", "contributor_scoped");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_reviewer_restricted_idx"
  ON "evidence_search_documents" ("team_id", "reviewer_restricted");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_evidence_id_idx"
  ON "evidence_search_documents" ("evidence_id");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_workflow_instance_id_idx"
  ON "evidence_search_documents" ("workflow_instance_id");
CREATE INDEX IF NOT EXISTS "evidence_search_documents_case_id_idx"
  ON "evidence_search_documents" ("case_id");

-- Postgres tsvector index for the free-text body. Built lazily via
-- expression — the column itself stays as TEXT so the indexer can
-- update it without an explicit cast. Future work can swap this for
-- a dedicated `tsvector` column + GIN.
CREATE INDEX IF NOT EXISTS "evidence_search_documents_searchable_text_trgm_idx"
  ON "evidence_search_documents" USING GIN (to_tsvector('simple', COALESCE("searchable_text", '')));

-- 2. saved_search_views --------------------------------------------------

CREATE TABLE IF NOT EXISTS "saved_search_views" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(400),
  "visibility" VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
  "query_json" JSONB NOT NULL,
  "pinned" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_used_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "saved_search_views_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "saved_search_views_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "saved_search_views_team_user_name_uk"
  ON "saved_search_views" ("team_id", "created_by_user_id", "name");
CREATE INDEX IF NOT EXISTS "saved_search_views_team_visibility_idx"
  ON "saved_search_views" ("team_id", "visibility");
CREATE INDEX IF NOT EXISTS "saved_search_views_team_pinned_idx"
  ON "saved_search_views" ("team_id", "pinned");
CREATE INDEX IF NOT EXISTS "saved_search_views_created_by_updated_at_idx"
  ON "saved_search_views" ("created_by_user_id", "updated_at" DESC);
