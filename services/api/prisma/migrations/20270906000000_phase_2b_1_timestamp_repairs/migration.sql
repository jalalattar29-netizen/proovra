-- Phase 2B.1 — timestamp repairs
--
-- Live precheck summary:
--   * 9 HIGH timestamp drifts
--   * 8 affected tables currently empty
--   * evidence_search_documents.updated_at has 647 rows, 0 NULLs
--   * existing naive values are treated as UTC application timestamps
--
-- Safety rules:
--   * No drops
--   * No column renames
--   * No fake timestamp backfills
--   * Convert only when the current DB type is timestamp without time zone

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_saved_views'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_saved_views"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_legal_holds'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_legal_holds"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_extracted_texts'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_extracted_texts"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'discussion_threads'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "discussion_threads"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'trusted_devices'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "trusted_devices"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_workflow_instances'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_workflow_instances"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_workflow_step_instances'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_workflow_step_instances"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_workflow_visibility_decisions'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_workflow_visibility_decisions"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_search_documents'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_search_documents"
      ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(6)
      USING CASE
        WHEN "updated_at" IS NULL THEN NULL
        ELSE "updated_at" AT TIME ZONE ''UTC''
      END';
  END IF;
END $$;

COMMIT;
