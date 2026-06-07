-- Minimal proven drift repair for Trust Center / Status / Subprocessor tables.
-- This migration only adds the missing `effective_at` column for the
-- historical version tables that are required by runtime seeding and
-- schema-compatible projection logic.

ALTER TABLE "subprocessor_versions"
ADD COLUMN IF NOT EXISTS "effective_at" timestamp with time zone NULL;

ALTER TABLE "trust_center_article_versions"
ADD COLUMN IF NOT EXISTS "effective_at" timestamp with time zone NULL;

ALTER TABLE "status_component"
ADD COLUMN IF NOT EXISTS "namespace" text NOT NULL DEFAULT 'default';

COMMENT ON COLUMN "status_component"."namespace" IS 'Namespace scope for status component grouping and migration stability.';
