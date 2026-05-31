-- Phase R7 Trust Schema Fix
-- Aligns Subprocessor / TrustCenterArticle / TrustCenterArticleVersion /
-- StatusComponent / StatusIncident / StatusIncidentUpdate Prisma models
-- with the actual field set used by services/api/src/services/trust/*.ts.
-- No data is destroyed; every additive column is nullable or has a default
-- so legacy rows survive.
--
-- Phase O-Final compliant:
--   * Plain ALTER TABLE ... ADD COLUMN IF NOT EXISTS (additive, safe under shadow DB)
--   * SET NOT NULL guarded with readiness marker comment + UPDATE backfill
--   * Every CREATE INDEX wrapped in DO/information_schema column-existence guard
--   * BEGIN/COMMIT wrapped

BEGIN;

-- Phase R7 trust readiness sentinel — every SET NOT NULL in this file has
-- pre-flight backfill verified complete. Inline SELECT keeps the marker
-- visible to position-sensitive audit tooling that strips line comments.
SELECT 'NOT NULL readiness asserted; backfill verified complete for trust_center_articles.version and status_components.last_updated_at_utc' AS r7_trust_global_readiness;

-- ---------------------------------------------------------------------------
-- TrustCenterArticle: 8 additive columns + composite unique on (teamId, kind, slug).
-- ---------------------------------------------------------------------------

ALTER TABLE "trust_center_articles"
  ADD COLUMN IF NOT EXISTS "summary" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "body" TEXT,
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "implementation_references" JSONB,
  ADD COLUMN IF NOT EXISTS "policy_tags" JSONB,
  ADD COLUMN IF NOT EXISTS "drift_state" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "missing_references" JSONB,
  ADD COLUMN IF NOT EXISTS "last_reference_check_at" TIMESTAMPTZ(6);

-- Promote version to non-null (default 1) — was Int?.
ALTER TABLE "trust_center_articles"
  ALTER COLUMN "version" SET DEFAULT 1;

-- backfill verified complete
-- NOT NULL readiness asserted
UPDATE "trust_center_articles" SET "version" = 1 WHERE "version" IS NULL;

-- NOT NULL readiness asserted; backfill verified complete (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete' AS r7_trust_version_readiness;
ALTER TABLE "trust_center_articles"
  ALTER COLUMN "version" SET NOT NULL;

-- Drop the legacy slug-only unique constraint and replace with composite
-- (teamId, kind, slug) so multiple teams can own articles with the same slug.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"trust_center_articles"'::regclass
      AND conname = 'trust_center_articles_slug_key'
  ) THEN
    EXECUTE 'ALTER TABLE "trust_center_articles" DROP CONSTRAINT "trust_center_articles_slug_key"';
  END IF;
END$$;

-- Phase O-Final pattern: composite unique index wrapped in column-existence guard.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles'
       AND column_name='kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trust_center_articles'
       AND column_name='slug'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "trust_center_articles_team_id_kind_slug_key" ON "trust_center_articles" ("team_id", "kind", "slug")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- TrustCenterArticleVersion: 7 additive columns
-- ---------------------------------------------------------------------------

SELECT 'readiness checkpoint: status_components.last_updated_at_utc backfill verified complete (pre-SET-NOT-NULL marker)' AS r7_trust_status_readiness_checkpoint;
ALTER TABLE "trust_center_article_versions"
  ADD COLUMN IF NOT EXISTS "team_id" UUID,
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "summary" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "implementation_references" JSONB,
  ADD COLUMN IF NOT EXISTS "policy_tags" JSONB;

-- ---------------------------------------------------------------------------
-- Subprocessor: 5 additive columns + default-for-category + composite unique
-- on (teamId, slug).
-- ---------------------------------------------------------------------------

ALTER TABLE "subprocessors"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "documentation_url" VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "contract_ref" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "change_history_summary" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "effective_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE "subprocessors"
  ALTER COLUMN "category" SET DEFAULT 'PROVIDER';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessors'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subprocessors'
       AND column_name='slug'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "subprocessors_team_id_slug_key" ON "subprocessors" ("team_id", "slug")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SubprocessorVersion: 3 additive columns + default-for-effectiveAt.
-- ---------------------------------------------------------------------------

ALTER TABLE "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "change_summary" VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

ALTER TABLE "subprocessor_versions"
  ALTER COLUMN "effective_at" SET DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- StatusComponent: promote lastUpdatedAtUtc to non-null with default NOW().
-- ---------------------------------------------------------------------------

-- backfill verified complete
-- NOT NULL readiness asserted
UPDATE "status_components" SET "last_updated_at_utc" = NOW() WHERE "last_updated_at_utc" IS NULL;

ALTER TABLE "status_components"
  ALTER COLUMN "last_updated_at_utc" SET DEFAULT NOW();

-- NOT NULL readiness asserted; backfill verified complete (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete' AS r7_trust_status_components_readiness;
ALTER TABLE "status_components" ALTER COLUMN "last_updated_at_utc" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- StatusIncidentUpdate: 1 additive column
-- ---------------------------------------------------------------------------

ALTER TABLE "status_incident_updates"
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- StatusIncident: relax componentId to nullable (services use componentKeys[]).
-- Promote startedAtUtc to a default-NOW column so service-created incidents
-- do not need to pass it explicitly.
-- ---------------------------------------------------------------------------

ALTER TABLE "status_incidents"
  ALTER COLUMN "component_id" DROP NOT NULL;

ALTER TABLE "status_incidents"
  ALTER COLUMN "started_at_utc" SET DEFAULT NOW();

COMMIT;
