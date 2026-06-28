-- Phase 2B.7 — JSON semantic repairs
--
-- Live precheck summary:
--   * workspace_governance_policies.metadata_redaction_default
--       DB type = boolean, live precheck found no non-null samples
--   * cross_org_review_grants.scope
--       DB type = varchar, canonical service shape is JSON { text: ... }
--
-- Safety rules:
--   * do not blindly cast scalars to JSON
--   * do not invent governance meaning
--   * fail loudly if unexpected non-null boolean policy rows appear

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'workspace_governance_policies'
       AND column_name = 'metadata_redaction_default'
       AND data_type = 'boolean'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "workspace_governance_policies"
       WHERE "metadata_redaction_default" IS NOT NULL
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot auto-convert workspace_governance_policies.metadata_redaction_default: non-null boolean values require manual semantic review';
    END IF;
    EXECUTE 'ALTER TABLE "workspace_governance_policies"
      ALTER COLUMN "metadata_redaction_default" TYPE JSONB
      USING NULL::jsonb';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'cross_org_review_grants'
       AND column_name = 'scope'
       AND data_type IN ('character varying', 'text')
  ) THEN
    EXECUTE 'ALTER TABLE "cross_org_review_grants"
      ALTER COLUMN "scope" TYPE JSONB
      USING CASE
        WHEN "scope" IS NULL OR btrim("scope") = '''' THEN ''{}''::jsonb
        ELSE jsonb_build_object(''text'', "scope")
      END';
  END IF;
END $$;

COMMIT;
