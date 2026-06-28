-- Phase 2B.6 — UUID and identifier alignment
--
-- Live precheck summary:
--   * reviewer_ops_reminders text->uuid candidates: invalid UUID count = 0
--   * evidence_exchange_package_builds.id text->uuid candidate: invalid UUID count = 0
--   * step_up_challenges.resource_id drift is directionally DB-wrong:
--     service input is bounded string, not UUID-only
--   * duplicate_decisions.* and external_review_invitation_deliveries.bulk_batch_id
--     are fixed in schema.prisma because the DB is already canonical there
--
-- Safety rules:
--   * validate text->uuid before cast
--   * do not force non-UUID identifiers
--   * preserve bounded string semantics where the service accepts strings

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'step_up_challenges'
       AND column_name = 'resource_id'
       AND data_type = 'uuid'
  ) THEN
    EXECUTE 'ALTER TABLE "step_up_challenges"
      ALTER COLUMN "resource_id" TYPE VARCHAR(128)
      USING CASE
        WHEN "resource_id" IS NULL THEN NULL
        ELSE "resource_id"::text
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviewer_ops_reminders'
       AND column_name = 'id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "reviewer_ops_reminders"
       WHERE "id" IS NOT NULL
         AND "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders"
      ALTER COLUMN "id" TYPE UUID
      USING CASE
        WHEN "id" IS NULL THEN NULL
        ELSE "id"::uuid
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviewer_ops_reminders'
       AND column_name = 'workflow_id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "reviewer_ops_reminders"
       WHERE "workflow_id" IS NOT NULL
         AND "workflow_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.workflow_id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders"
      ALTER COLUMN "workflow_id" TYPE UUID
      USING CASE
        WHEN "workflow_id" IS NULL THEN NULL
        ELSE "workflow_id"::uuid
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviewer_ops_reminders'
       AND column_name = 'escalation_id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "reviewer_ops_reminders"
       WHERE "escalation_id" IS NOT NULL
         AND "escalation_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.escalation_id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders"
      ALTER COLUMN "escalation_id" TYPE UUID
      USING CASE
        WHEN "escalation_id" IS NULL THEN NULL
        ELSE "escalation_id"::uuid
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviewer_ops_reminders'
       AND column_name = 'reviewer_user_id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "reviewer_ops_reminders"
       WHERE "reviewer_user_id" IS NOT NULL
         AND "reviewer_user_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert reviewer_ops_reminders.reviewer_user_id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "reviewer_ops_reminders"
      ALTER COLUMN "reviewer_user_id" TYPE UUID
      USING CASE
        WHEN "reviewer_user_id" IS NULL THEN NULL
        ELSE "reviewer_user_id"::uuid
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_exchange_package_builds'
       AND column_name = 'id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "evidence_exchange_package_builds"
       WHERE "id" IS NOT NULL
         AND "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert evidence_exchange_package_builds.id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_exchange_package_builds"
      ALTER COLUMN "id" TYPE UUID
      USING CASE
        WHEN "id" IS NULL THEN NULL
        ELSE "id"::uuid
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_exchange_package_builds'
       AND column_name = 'package_id'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "evidence_exchange_package_builds"
       WHERE "package_id" IS NOT NULL
         AND "package_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert evidence_exchange_package_builds.package_id to UUID: invalid values exist';
    END IF;
    EXECUTE 'ALTER TABLE "evidence_exchange_package_builds"
      ALTER COLUMN "package_id" TYPE UUID
      USING CASE
        WHEN "package_id" IS NULL THEN NULL
        ELSE "package_id"::uuid
      END';
  END IF;
END $$;

COMMIT;
