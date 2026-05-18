-- =============================================================================
-- Production drift fix — 2026-05-08 evidence-operations-workspace migration
-- Idempotent, additive, safe for Neon.
--
-- Mirrors:
--   services/api/prisma/migrations/20260508133000_add_evidence_operations_workspace_features/migration.sql
--
-- Apply manually on production when the deployed API expects the following
-- tables but the database does not have them:
--
--   evidence_saved_views
--   evidence_reviewer_comments
--   evidence_legal_notes
--   evidence_annotations
--   evidence_ai_categorizations  <-- root of the Sentry P2021 reported
--
-- This script:
--   * Uses CREATE TYPE IF NOT EXISTS pattern via DO $$ blocks (Postgres
--     <14 compat — Neon Postgres 16 also accepts the IF NOT EXISTS form;
--     we use DO blocks for maximum portability).
--   * Uses CREATE TABLE IF NOT EXISTS for every table.
--   * Uses CREATE INDEX IF NOT EXISTS for every index.
--   * Uses DO $$ blocks to add foreign keys only when the constraint
--     does not already exist (NOT VALID then VALIDATE not needed since
--     the tables are empty on a fresh apply; the FKs are enforced
--     immediately on new rows).
--   * Touches no existing rows. No DROP. No ALTER of pre-existing columns.
--   * After successful run, `prisma migrate status` will still mark the
--     migration as "not applied" because we are NOT writing to the
--     `_prisma_migrations` history table on purpose — the operator
--     should follow up with `prisma migrate resolve --applied
--     20260508133000_add_evidence_operations_workspace_features` so
--     future deploys do not attempt to re-run the migration. See
--     "After applying" at the bottom of this file.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceCommentVisibility'
  ) THEN
    CREATE TYPE "EvidenceCommentVisibility" AS ENUM ('INTERNAL', 'TEAM');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceLegalNoteType'
  ) THEN
    CREATE TYPE "EvidenceLegalNoteType" AS ENUM (
      'GENERAL', 'PRIVILEGED', 'DISCLOSURE', 'REVIEW_BOUNDARY', 'HANDOFF'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationType'
  ) THEN
    CREATE TYPE "EvidenceAnnotationType" AS ENUM (
      'POINT', 'BOX', 'REGION', 'TIMESTAMP', 'TEXT'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationCoordinateSpace'
  ) THEN
    CREATE TYPE "EvidenceAnnotationCoordinateSpace" AS ENUM (
      'NORMALIZED', 'PIXEL', 'TIME_ONLY', 'DOCUMENT_PAGE'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceAiCategorizationStatus'
  ) THEN
    CREATE TYPE "EvidenceAiCategorizationStatus" AS ENUM (
      'DISABLED', 'PENDING', 'COMPLETED', 'FAILED'
    );
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_saved_views" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID         NOT NULL,
  "team_id"       UUID,
  "name"          VARCHAR(120) NOT NULL,
  "description"   VARCHAR(400),
  "filters_json"  JSONB        NOT NULL,
  "sort_key"      VARCHAR(64),
  "scope"         VARCHAR(32)  NOT NULL,
  "is_default"    BOOLEAN      NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_saved_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_reviewer_comments" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "visibility"     "EvidenceCommentVisibility" NOT NULL DEFAULT 'INTERNAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_reviewer_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_legal_notes" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "note_type"      "EvidenceLegalNoteType" NOT NULL DEFAULT 'GENERAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_legal_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_annotations" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"        UUID NOT NULL,
  "evidence_part_id"   UUID,
  "author_user_id"     UUID NOT NULL,
  "annotation_type"    "EvidenceAnnotationType" NOT NULL,
  "body"               TEXT,
  "page_number"        INTEGER,
  "media_timestamp_ms" INTEGER,
  "x"                  DOUBLE PRECISION,
  "y"                  DOUBLE PRECISION,
  "width"              DOUBLE PRECISION,
  "height"             DOUBLE PRECISION,
  "coordinate_space"   "EvidenceAnnotationCoordinateSpace" NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"         TIMESTAMPTZ(6),
  CONSTRAINT "evidence_annotations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_ai_categorizations" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"           UUID NOT NULL,
  "requested_by_user_id"  UUID NOT NULL,
  "status"                "EvidenceAiCategorizationStatus" NOT NULL DEFAULT 'PENDING',
  "categories_json"       JSONB,
  "suggested_tags_json"   JSONB,
  "risk_flags_json"       JSONB,
  "summary"               TEXT,
  "legal_disclaimer"      TEXT NOT NULL,
  "model"                 VARCHAR(120),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_ai_categorizations_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. Foreign keys (only added when missing)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_saved_views_owner_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_saved_views_team_id_fkey'
  ) THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_reviewer_comments_evidence_id_fkey'
  ) THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_reviewer_comments_author_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_legal_notes_evidence_id_fkey'
  ) THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_legal_notes_author_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_annotations_evidence_id_fkey'
  ) THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_annotations_evidence_part_id_fkey'
  ) THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_part_id_fkey"
      FOREIGN KEY ("evidence_part_id") REFERENCES "evidence_parts"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_annotations_author_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_ai_categorizations_evidence_id_fkey'
  ) THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_ai_categorizations_requested_by_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_requested_by_user_id_fkey"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_created_at_idx"
  ON "evidence_saved_views" ("owner_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_saved_views_team_id_created_at_idx"
  ON "evidence_saved_views" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_is_default_idx"
  ON "evidence_saved_views" ("owner_user_id", "is_default");

CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_evidence_id_created_at_idx"
  ON "evidence_reviewer_comments" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_author_user_id_idx"
  ON "evidence_reviewer_comments" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_deleted_at_idx"
  ON "evidence_reviewer_comments" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_legal_notes_evidence_id_created_at_idx"
  ON "evidence_legal_notes" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_legal_notes_author_user_id_idx"
  ON "evidence_legal_notes" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_legal_notes_deleted_at_idx"
  ON "evidence_legal_notes" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_id_created_at_idx"
  ON "evidence_annotations" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_part_id_idx"
  ON "evidence_annotations" ("evidence_part_id");
CREATE INDEX IF NOT EXISTS "evidence_annotations_author_user_id_idx"
  ON "evidence_annotations" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_annotations_deleted_at_idx"
  ON "evidence_annotations" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_evidence_id_created_at_idx"
  ON "evidence_ai_categorizations" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_requested_by_user_id_created_at_idx"
  ON "evidence_ai_categorizations" ("requested_by_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_status_idx"
  ON "evidence_ai_categorizations" ("status");

COMMIT;

-- =============================================================================
-- After applying
-- =============================================================================
--
-- 1. Confirm the targeted table now exists:
--      SELECT to_regclass('public.evidence_ai_categorizations');
--
-- 2. Confirm row count is 0 (fresh table):
--      SELECT count(*) FROM public.evidence_ai_categorizations;
--
-- 3. Mark the migration applied in Prisma's history so future
--    `prisma migrate deploy` runs do not re-attempt it:
--      pnpm --dir services/api prisma migrate resolve \
--        --applied 20260508133000_add_evidence_operations_workspace_features
--
-- 4. Re-run `prisma migrate status` and verify no migration is marked
--    as failed and no migration is missing.
--
-- 5. Hit GET /v1/evidence/<id>/ai-categorization — it should now return
--    200 with the empty/DISABLED default payload (no rows in the new
--    table is expected and represented as the empty default).
-- =============================================================================
