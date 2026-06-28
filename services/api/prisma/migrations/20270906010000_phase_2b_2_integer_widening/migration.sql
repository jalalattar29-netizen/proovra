-- Phase 2B.2 — integer widening
--
-- Live precheck summary:
--   * 7 HIGH widening drifts
--   * all affected tables currently empty
--
-- Safety rules:
--   * widening only
--   * no narrowing
--   * no data rewrite beyond safe Postgres widen

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'external_review_invitation_deliveries'
       AND column_name = 'attempt'
       AND data_type = 'smallint'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_invitation_deliveries"
      ALTER COLUMN "attempt" TYPE INTEGER';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_versions'
       AND column_name = 'version_ordinal'
       AND data_type = 'smallint'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_versions"
      ALTER COLUMN "version_ordinal" TYPE INTEGER';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'redaction_policy_versions'
       AND column_name = 'version_ordinal'
       AND data_type = 'smallint'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_policy_versions"
      ALTER COLUMN "version_ordinal" TYPE INTEGER';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'video_timeline_events'
       AND column_name = 'start_ms'
       AND data_type = 'integer'
  ) THEN
    EXECUTE 'ALTER TABLE "video_timeline_events"
      ALTER COLUMN "start_ms" TYPE BIGINT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'video_timeline_events'
       AND column_name = 'end_ms'
       AND data_type = 'integer'
  ) THEN
    EXECUTE 'ALTER TABLE "video_timeline_events"
      ALTER COLUMN "end_ms" TYPE BIGINT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'video_frames'
       AND column_name = 'timestamp_ms'
       AND data_type = 'integer'
  ) THEN
    EXECUTE 'ALTER TABLE "video_frames"
      ALTER COLUMN "timestamp_ms" TYPE BIGINT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'video_frames'
       AND column_name = 'byte_size'
       AND data_type = 'integer'
  ) THEN
    EXECUTE 'ALTER TABLE "video_frames"
      ALTER COLUMN "byte_size" TYPE BIGINT';
  END IF;
END $$;

COMMIT;
