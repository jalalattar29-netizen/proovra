-- Phase 2B.5 — enum alignment
--
-- Live precheck summary:
--   * text-backed enum drift only on:
--       reports.last_verified_source_snapshot
--       verification_views.verification_status_snapshot
--       teams.billing_plan
--       teams.billing_status
--       demo_requests.lead_quality
--       demo_requests.lead_track
--       demo_requests.recommended_action
--   * enum-map false positives on workflow_review_decisions and MFA
--     are fixed in the audit script, not in the DB
--   * missing enum value: CustodyEventType.CAPTURE_TRUST_EVENT
--
-- Safety rules:
--   * no destructive enum changes
--   * validate every stored value before cast
--   * create enum types only when absent

DO $$
DECLARE
  teams_billing_plan_had_default BOOLEAN := FALSE;
  teams_billing_status_had_default BOOLEAN := FALSE;
  demo_lead_quality_had_default BOOLEAN := FALSE;
  demo_lead_track_had_default BOOLEAN := FALSE;
  demo_recommended_action_had_default BOOLEAN := FALSE;
  BEGIN
  BEGIN
    CREATE TYPE "VerificationSource" AS ENUM (
      'REPORT_GENERATED',
      'PUBLIC_VERIFY_VIEWED',
      'TECHNICAL_VERIFICATION_CHECKED'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "VerificationStatus" AS ENUM (
      'MATERIALS_AVAILABLE',
      'RECORDED_INTEGRITY_VERIFIED',
      'REVIEW_REQUIRED',
      'FAILED'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "PlanType" AS ENUM (
      'FREE',
      'PAYG',
      'PRO',
      'TEAM',
      'ENTERPRISE'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "TeamBillingStatus" AS ENUM (
      'INACTIVE',
      'ACTIVE',
      'PAST_DUE',
      'CANCELED'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "DemoLeadQuality" AS ENUM (
      'LOW',
      'MEDIUM',
      'HIGH'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "DemoLeadTrack" AS ENUM (
      'DISCOVERY',
      'SALES',
      'ENTERPRISE'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE TYPE "DemoRecommendedAction" AS ENUM (
      'reply_with_resources',
      'offer_demo',
      'route_enterprise'
    );
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  IF EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typname = 'CustodyEventType'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typname = 'CustodyEventType'
       AND e.enumlabel = 'CAPTURE_TRUST_EVENT'
  ) THEN
    EXECUTE 'ALTER TYPE "CustodyEventType" ADD VALUE ''CAPTURE_TRUST_EVENT''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reports'
       AND column_name = 'last_verified_source_snapshot'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "reports"
       WHERE "last_verified_source_snapshot" IS NOT NULL
         AND "last_verified_source_snapshot" NOT IN (
           'REPORT_GENERATED',
           'PUBLIC_VERIFY_VIEWED',
           'TECHNICAL_VERIFICATION_CHECKED'
         )
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert reports.last_verified_source_snapshot to VerificationSource: invalid values exist';
    END IF;

    EXECUTE 'ALTER TABLE "reports" ALTER COLUMN "last_verified_source_snapshot" DROP DEFAULT';
    EXECUTE 'ALTER TABLE "reports"
      ALTER COLUMN "last_verified_source_snapshot" TYPE "VerificationSource"
      USING CASE
        WHEN "last_verified_source_snapshot" IS NULL THEN NULL
        ELSE "last_verified_source_snapshot"::"VerificationSource"
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_views'
       AND column_name = 'verification_status_snapshot'
       AND data_type = 'text'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM "verification_views"
       WHERE "verification_status_snapshot" IS NOT NULL
         AND "verification_status_snapshot" NOT IN (
           'MATERIALS_AVAILABLE',
           'RECORDED_INTEGRITY_VERIFIED',
           'REVIEW_REQUIRED',
           'FAILED'
         )
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert verification_views.verification_status_snapshot to VerificationStatus: invalid values exist';
    END IF;

    EXECUTE 'ALTER TABLE "verification_views" ALTER COLUMN "verification_status_snapshot" DROP DEFAULT';
    EXECUTE 'ALTER TABLE "verification_views"
      ALTER COLUMN "verification_status_snapshot" TYPE "VerificationStatus"
      USING CASE
        WHEN "verification_status_snapshot" IS NULL THEN NULL
        ELSE "verification_status_snapshot"::"VerificationStatus"
      END';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'billing_plan'
       AND data_type = 'text'
  ) THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'teams'
         AND column_name = 'billing_plan'
         AND column_default IS NOT NULL
    ) INTO teams_billing_plan_had_default;
    IF EXISTS (
      SELECT 1 FROM "teams"
       WHERE "billing_plan" IS NOT NULL
         AND "billing_plan" NOT IN ('FREE', 'PAYG', 'PRO', 'TEAM', 'ENTERPRISE')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert teams.billing_plan to PlanType: invalid values exist';
    END IF;
    IF teams_billing_plan_had_default THEN
      EXECUTE 'ALTER TABLE "teams" ALTER COLUMN "billing_plan" DROP DEFAULT';
    END IF;
    EXECUTE 'ALTER TABLE "teams"
      ALTER COLUMN "billing_plan" TYPE "PlanType"
      USING "billing_plan"::"PlanType"';
    IF teams_billing_plan_had_default THEN
      EXECUTE 'ALTER TABLE "teams" ALTER COLUMN "billing_plan" SET DEFAULT ''FREE''::"PlanType"';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'billing_status'
       AND data_type = 'text'
  ) THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'teams'
         AND column_name = 'billing_status'
         AND column_default IS NOT NULL
    ) INTO teams_billing_status_had_default;
    IF EXISTS (
      SELECT 1 FROM "teams"
       WHERE "billing_status" IS NOT NULL
         AND "billing_status" NOT IN ('INACTIVE', 'ACTIVE', 'PAST_DUE', 'CANCELED')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert teams.billing_status to TeamBillingStatus: invalid values exist';
    END IF;
    IF teams_billing_status_had_default THEN
      EXECUTE 'ALTER TABLE "teams" ALTER COLUMN "billing_status" DROP DEFAULT';
    END IF;
    EXECUTE 'ALTER TABLE "teams"
      ALTER COLUMN "billing_status" TYPE "TeamBillingStatus"
      USING "billing_status"::"TeamBillingStatus"';
    IF teams_billing_status_had_default THEN
      EXECUTE 'ALTER TABLE "teams" ALTER COLUMN "billing_status" SET DEFAULT ''INACTIVE''::"TeamBillingStatus"';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'demo_requests'
       AND column_name = 'lead_quality'
       AND data_type = 'text'
  ) THEN

      SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'demo_requests'
         AND column_name = 'lead_quality'
         AND column_default IS NOT NULL
    ) INTO demo_lead_quality_had_default;
    IF EXISTS (
      SELECT 1 FROM "demo_requests"
       WHERE "lead_quality" IS NOT NULL
         AND "lead_quality" NOT IN ('LOW', 'MEDIUM', 'HIGH')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert demo_requests.lead_quality to DemoLeadQuality: invalid values exist';
    END IF;
    IF demo_lead_quality_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests" ALTER COLUMN "lead_quality" DROP DEFAULT';
    END IF;
    EXECUTE 'ALTER TABLE "demo_requests"
      ALTER COLUMN "lead_quality" TYPE "DemoLeadQuality"
      USING CASE
        WHEN "lead_quality" IS NULL THEN NULL
        ELSE "lead_quality"::"DemoLeadQuality"
      END';
    IF demo_lead_quality_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests" ALTER COLUMN "lead_quality" SET DEFAULT ''LOW''::"DemoLeadQuality"';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'demo_requests'
       AND column_name = 'lead_track'
       AND data_type = 'text'
  ) THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'demo_requests'
         AND column_name = 'lead_track'
         AND column_default IS NOT NULL
    ) INTO demo_lead_track_had_default;
    IF EXISTS (
      SELECT 1 FROM "demo_requests"
       WHERE "lead_track" IS NOT NULL
         AND "lead_track" NOT IN ('DISCOVERY', 'SALES', 'ENTERPRISE')
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert demo_requests.lead_track to DemoLeadTrack: invalid values exist';
    END IF;
        IF demo_lead_track_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests"
        ALTER COLUMN "lead_track" DROP DEFAULT';
    END IF;
    EXECUTE 'ALTER TABLE "demo_requests"
      ALTER COLUMN "lead_track" TYPE "DemoLeadTrack"
      USING CASE
        WHEN "lead_track" IS NULL THEN NULL
        ELSE "lead_track"::"DemoLeadTrack"
      END';

    IF demo_lead_track_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests"
        ALTER COLUMN "lead_track"
        SET DEFAULT ''DISCOVERY''::"DemoLeadTrack"';
    END IF;

END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'demo_requests'
       AND column_name = 'recommended_action'
       AND data_type = 'text'
  ) THEN
      SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'demo_requests'
        AND column_name = 'recommended_action'
        AND column_default IS NOT NULL
    )
    INTO demo_recommended_action_had_default;
    IF EXISTS (
      SELECT 1 FROM "demo_requests"
       WHERE "recommended_action" IS NOT NULL
         AND "recommended_action" NOT IN (
           'reply_with_resources',
           'offer_demo',
           'route_enterprise'
         )
       LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot convert demo_requests.recommended_action to DemoRecommendedAction: invalid values exist';
    END IF;
        IF demo_recommended_action_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests"
        ALTER COLUMN "recommended_action" DROP DEFAULT';
    END IF;
    EXECUTE 'ALTER TABLE "demo_requests"
      ALTER COLUMN "recommended_action" TYPE "DemoRecommendedAction"
      USING CASE
        WHEN "recommended_action" IS NULL THEN NULL
        ELSE "recommended_action"::"DemoRecommendedAction"
      END';
          IF demo_recommended_action_had_default THEN
      EXECUTE 'ALTER TABLE "demo_requests"
        ALTER COLUMN "recommended_action"
        SET DEFAULT ''reply_with_resources''::"DemoRecommendedAction"';
    END IF;
  END IF;
END $$;
