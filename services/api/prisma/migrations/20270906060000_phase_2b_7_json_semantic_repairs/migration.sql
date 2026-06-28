-- Phase 2B.7 — JSON semantic repairs
--
-- Scope:
--   * workspace_governance_policies.metadata_redaction_default
--       boolean -> jsonb only when all existing values are NULL.
--   * cross_org_review_grants.scope
--       varchar/text -> jsonb object { "text": <old value> }.
--
-- Safety:
--   * no DROP columns
--   * no FK changes
--   * no destructive changes
--   * no outer BEGIN/COMMIT
--   * no invented governance meaning
--   * fail loudly if non-null boolean policy rows exist

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_governance_policies'
      AND column_name = 'metadata_redaction_default'
      AND data_type = 'boolean'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM "workspace_governance_policies"
      WHERE "metadata_redaction_default" IS NOT NULL
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot auto-convert workspace_governance_policies.metadata_redaction_default: non-null boolean values require manual semantic review';
    END IF;

    ALTER TABLE "workspace_governance_policies"
      ALTER COLUMN "metadata_redaction_default" DROP DEFAULT;

    ALTER TABLE "workspace_governance_policies"
      ALTER COLUMN "metadata_redaction_default" TYPE JSONB
      USING NULL::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cross_org_review_grants'
      AND column_name = 'scope'
      AND data_type IN ('character varying', 'text')
  ) THEN
    ALTER TABLE "cross_org_review_grants"
      ALTER COLUMN "scope" DROP DEFAULT;

    ALTER TABLE "cross_org_review_grants"
      ALTER COLUMN "scope" TYPE JSONB
      USING CASE
        WHEN "scope" IS NULL OR btrim("scope"::text) = '' THEN '{}'::jsonb
        ELSE jsonb_build_object('text', "scope"::text)
      END;
  END IF;
END $$;