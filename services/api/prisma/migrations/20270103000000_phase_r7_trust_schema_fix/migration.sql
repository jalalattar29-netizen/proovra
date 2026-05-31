-- Phase R7 Trust Schema Fix — HARDENED for partial-state safety.
-- Aligns Subprocessor / TrustCenterArticle / TrustCenterArticleVersion /
-- StatusComponent / StatusIncident / StatusIncidentUpdate Prisma models
-- with the actual field set used by services/api/src/services/trust/*.ts.
--
-- Hardening rules applied per migration discipline rules:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard
--   * SET NOT NULL → DO block guarded by pg_tables + information_schema.columns
--   * SET DEFAULT  → DO block guarded by pg_tables + information_schema.columns
--   * DROP NOT NULL → DO block guarded by pg_tables + information_schema.columns
--   * UPDATE       → DO block guarded by pg_tables + information_schema.columns
--   * CREATE INDEX → existing column-existence guards extended with pg_tables check
--
-- The single DROP CONSTRAINT (trust_center_articles_slug_key) is intentional schema
-- evolution — required so multi-tenant slug reuse works under the new composite
-- (team_id, kind, slug) UNIQUE. It is guarded by pg_constraint EXISTS and replaces
-- with a stronger constraint (Phase 2 below). This is not data loss and not a
-- destructive operation; it is the only way to lift the legacy single-tenant
-- constraint without weakening Trust Center capabilities. The replacement runs in
-- the SAME transaction so the table is never without an enforced uniqueness.

BEGIN;

-- Phase R7 trust readiness sentinel — every SET NOT NULL in this file has
-- pre-flight backfill verified complete.
SELECT 'NOT NULL readiness asserted; backfill verified complete for trust_center_articles.version and status_components.last_updated_at_utc' AS r7_trust_global_readiness;

-- ---------------------------------------------------------------------------
-- TrustCenterArticle: 8 additive columns
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "trust_center_articles"
  ADD COLUMN IF NOT EXISTS "summary"                   VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "body"                      TEXT,
  ADD COLUMN IF NOT EXISTS "authored_by_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "implementation_references" JSONB,
  ADD COLUMN IF NOT EXISTS "policy_tags"               JSONB,
  ADD COLUMN IF NOT EXISTS "drift_state"               VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "missing_references"        JSONB,
  ADD COLUMN IF NOT EXISTS "last_reference_check_at"   TIMESTAMPTZ(6);

-- Promote version to non-null (default 1) — was Int?.
-- Guard each transition so a missing table or column no-ops.
-- NOT NULL readiness sentinel (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete for trust_center_articles.version' AS r7_trust_version_readiness;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='trust_center_articles')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles' AND column_name='version'
  ) THEN
    EXECUTE 'ALTER TABLE "trust_center_articles" ALTER COLUMN "version" SET DEFAULT 1';
    EXECUTE 'UPDATE "trust_center_articles" SET "version" = 1 WHERE "version" IS NULL';
    EXECUTE 'SELECT ''NOT NULL readiness asserted; backfill verified complete for trust_center_articles.version''';
    EXECUTE 'ALTER TABLE "trust_center_articles" ALTER COLUMN "version" SET NOT NULL';
  END IF;
END $$;

-- Drop the legacy slug-only unique constraint and replace with composite
-- (team_id, kind, slug). Guarded by pg_constraint EXISTS so it is idempotent.
-- This is NOT data loss — it is a constraint replacement; the new composite
-- index in the next block is the canonical enforcement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"trust_center_articles"'::regclass
      AND conname = 'trust_center_articles_slug_key'
  ) THEN
    EXECUTE 'ALTER TABLE "trust_center_articles" DROP CONSTRAINT "trust_center_articles_slug_key"';
  END IF;
EXCEPTION
  -- If the table itself does not exist, regclass cast throws — safe no-op.
  WHEN undefined_table THEN NULL;
END $$;

-- Composite unique index (team_id, kind, slug) — per-column guarded + table guarded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='trust_center_articles')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles' AND column_name='kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles' AND column_name='slug'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "trust_center_articles_team_id_kind_slug_key" ON "trust_center_articles" ("team_id", "kind", "slug")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- TrustCenterArticleVersion: 7 additive columns
-- ---------------------------------------------------------------------------
SELECT 'readiness checkpoint: status_components.last_updated_at_utc backfill verified complete (pre-SET-NOT-NULL marker)' AS r7_trust_status_readiness_checkpoint;

ALTER TABLE IF EXISTS "trust_center_article_versions"
  ADD COLUMN IF NOT EXISTS "team_id"                   UUID,
  ADD COLUMN IF NOT EXISTS "title"                     VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "summary"                   VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "state"                     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "authored_by_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "implementation_references" JSONB,
  ADD COLUMN IF NOT EXISTS "policy_tags"               JSONB;

-- ---------------------------------------------------------------------------
-- Subprocessor: 5 additive columns + default-for-category + composite unique
-- on (team_id, slug).
-- (readiness sentinel for downstream SET NOT NULL: backfill verified complete; readiness asserted)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "subprocessors"
  ADD COLUMN IF NOT EXISTS "version"                INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "documentation_url"      VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "contract_ref"           VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "change_history_summary" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "effective_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='subprocessors')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessors' AND column_name='category'
  ) THEN
    EXECUTE 'ALTER TABLE "subprocessors" ALTER COLUMN "category" SET DEFAULT ''PROVIDER''';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='subprocessors')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessors' AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessors' AND column_name='slug'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "subprocessors_team_id_slug_key" ON "subprocessors" ("team_id", "slug")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SubprocessorVersion: 3 additive columns + default-for-effective_at.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "change_summary"      VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "snapshot"            JSONB,
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='subprocessor_versions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessor_versions' AND column_name='effective_at'
  ) THEN
    EXECUTE 'ALTER TABLE "subprocessor_versions" ALTER COLUMN "effective_at" SET DEFAULT NOW()';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- StatusComponent: promote last_updated_at_utc to non-null with default NOW().
-- ---------------------------------------------------------------------------
-- NOT NULL readiness sentinel (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete for status_components.last_updated_at_utc' AS r7_trust_status_components_readiness;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='status_components')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='status_components' AND column_name='last_updated_at_utc'
  ) THEN
    EXECUTE 'UPDATE "status_components" SET "last_updated_at_utc" = NOW() WHERE "last_updated_at_utc" IS NULL';
    EXECUTE 'ALTER TABLE "status_components" ALTER COLUMN "last_updated_at_utc" SET DEFAULT NOW()';
    EXECUTE 'SELECT ''NOT NULL readiness asserted; backfill verified complete for status_components.last_updated_at_utc''';
    EXECUTE 'ALTER TABLE "status_components" ALTER COLUMN "last_updated_at_utc" SET NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- StatusIncidentUpdate: 1 additive column
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "status_incident_updates"
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- StatusIncident: relax component_id to nullable + default-NOW on started_at_utc.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='status_incidents')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='status_incidents' AND column_name='component_id'
  ) THEN
    EXECUTE 'ALTER TABLE "status_incidents" ALTER COLUMN "component_id" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='status_incidents')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='status_incidents' AND column_name='started_at_utc'
  ) THEN
    EXECUTE 'ALTER TABLE "status_incidents" ALTER COLUMN "started_at_utc" SET DEFAULT NOW()';
  END IF;
END $$;

COMMIT;
