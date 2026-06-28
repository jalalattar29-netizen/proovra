-- Phase 2B.5 — enum alignment
-- Clean, idempotent, production-safe rewrite.

-- Scope:
--   * Create required enum types if absent.
--   * Add missing CustodyEventType.CAPTURE_TRUST_EVENT if absent.
--   * Convert text-backed enum columns to Prisma enum types.
--   * Skip conversion automatically if a column is already converted.
--   * Drop legacy CHECK constraints on columns being converted to native enums.
--------------------------------------------------------------------------------

-- Safety:
--   * no DROP columns
--   * no FK changes
--   * no destructive enum changes
--   * no outer BEGIN/COMMIT
--   * all value checks cast column values to text
--   * all enum casts use ::text::EnumName
--   * defaults are dropped before conversion and restored only where appropriate

DO $$
BEGIN
BEGIN
CREATE TYPE "VerificationSource" AS ENUM (
'REPORT_GENERATED',
'PUBLIC_VERIFY_VIEWED',
'TECHNICAL_VERIFICATION_CHECKED'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "VerificationStatus" AS ENUM (
'MATERIALS_AVAILABLE',
'RECORDED_INTEGRITY_VERIFIED',
'REVIEW_REQUIRED',
'FAILED'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "PlanType" AS ENUM (
'FREE',
'PAYG',
'PRO',
'TEAM',
'ENTERPRISE'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "TeamBillingStatus" AS ENUM (
'INACTIVE',
'ACTIVE',
'PAST_DUE',
'CANCELED'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "DemoLeadQuality" AS ENUM (
'LOW',
'MEDIUM',
'HIGH'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "DemoLeadTrack" AS ENUM (
'DISCOVERY',
'SALES',
'ENTERPRISE'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;

BEGIN
CREATE TYPE "DemoRecommendedAction" AS ENUM (
'reply_with_resources',
'offer_demo',
'route_enterprise'
);
EXCEPTION WHEN duplicate_object THEN
NULL;
END;
END $$;

DO $$
BEGIN
IF EXISTS (
SELECT 1
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
AND t.typname = 'CustodyEventType'
)
AND NOT EXISTS (
SELECT 1
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
AND t.typname = 'CustodyEventType'
AND e.enumlabel = 'CAPTURE_TRUST_EVENT'
) THEN
ALTER TYPE "CustodyEventType" ADD VALUE 'CAPTURE_TRUST_EVENT';
END IF;
END $$;

-- reports.last_verified_source_snapshot: text -> VerificationSource
DO $$
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'reports'
AND column_name = 'last_verified_source_snapshot'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "reports"
WHERE "last_verified_source_snapshot" IS NOT NULL
AND "last_verified_source_snapshot"::text NOT IN (
'REPORT_GENERATED',
'PUBLIC_VERIFY_VIEWED',
'TECHNICAL_VERIFICATION_CHECKED'
)
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert reports.last_verified_source_snapshot to VerificationSource: invalid values exist';
END IF;

```
ALTER TABLE "reports"
  ALTER COLUMN "last_verified_source_snapshot" DROP DEFAULT;

ALTER TABLE "reports"
  ALTER COLUMN "last_verified_source_snapshot" TYPE "VerificationSource"
  USING "last_verified_source_snapshot"::text::"VerificationSource";
```

END IF;
END $$;

-- verification_views.verification_status_snapshot: text -> VerificationStatus
DO $$
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'verification_views'
AND column_name = 'verification_status_snapshot'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "verification_views"
WHERE "verification_status_snapshot" IS NOT NULL
AND "verification_status_snapshot"::text NOT IN (
'MATERIALS_AVAILABLE',
'RECORDED_INTEGRITY_VERIFIED',
'REVIEW_REQUIRED',
'FAILED'
)
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert verification_views.verification_status_snapshot to VerificationStatus: invalid values exist';
END IF;

```
ALTER TABLE "verification_views"
  ALTER COLUMN "verification_status_snapshot" DROP DEFAULT;

ALTER TABLE "verification_views"
  ALTER COLUMN "verification_status_snapshot" TYPE "VerificationStatus"
  USING "verification_status_snapshot"::text::"VerificationStatus";
```

END IF;
END $$;

-- teams.billing_plan: text -> PlanType
DO $$
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'teams'
AND column_name = 'billing_plan'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "teams"
WHERE "billing_plan" IS NOT NULL
AND "billing_plan"::text NOT IN ('FREE', 'PAYG', 'PRO', 'TEAM', 'ENTERPRISE')
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert teams.billing_plan to PlanType: invalid values exist';
END IF;

```
ALTER TABLE "teams"
  ALTER COLUMN "billing_plan" DROP DEFAULT;

ALTER TABLE "teams"
  ALTER COLUMN "billing_plan" TYPE "PlanType"
  USING "billing_plan"::text::"PlanType";

ALTER TABLE "teams"
  ALTER COLUMN "billing_plan" SET DEFAULT 'FREE'::"PlanType";
```

END IF;
END $$;

-- teams.billing_status: text -> TeamBillingStatus
DO $$
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'teams'
AND column_name = 'billing_status'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "teams"
WHERE "billing_status" IS NOT NULL
AND "billing_status"::text NOT IN ('INACTIVE', 'ACTIVE', 'PAST_DUE', 'CANCELED')
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert teams.billing_status to TeamBillingStatus: invalid values exist';
END IF;

```
ALTER TABLE "teams"
  ALTER COLUMN "billing_status" DROP DEFAULT;

ALTER TABLE "teams"
  ALTER COLUMN "billing_status" TYPE "TeamBillingStatus"
  USING "billing_status"::text::"TeamBillingStatus";

ALTER TABLE "teams"
  ALTER COLUMN "billing_status" SET DEFAULT 'INACTIVE'::"TeamBillingStatus";
```

END IF;
END $$;

-- demo_requests.lead_quality: text -> DemoLeadQuality
DO $$
DECLARE
constraint_name TEXT;
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'demo_requests'
AND column_name = 'lead_quality'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "demo_requests"
WHERE "lead_quality" IS NOT NULL
AND "lead_quality"::text NOT IN ('LOW', 'MEDIUM', 'HIGH')
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert demo_requests.lead_quality to DemoLeadQuality: invalid values exist';
END IF;

```
FOR constraint_name IN
  SELECT c.conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'demo_requests'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%lead_quality%'
LOOP
  EXECUTE format('ALTER TABLE "demo_requests" DROP CONSTRAINT IF EXISTS %I', constraint_name);
END LOOP;

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_quality" DROP DEFAULT;

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_quality" TYPE "DemoLeadQuality"
  USING "lead_quality"::text::"DemoLeadQuality";

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_quality" SET DEFAULT 'LOW'::"DemoLeadQuality";
```

END IF;
END $$;

-- demo_requests.lead_track: text -> DemoLeadTrack
DO $$
DECLARE
constraint_name TEXT;
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'demo_requests'
AND column_name = 'lead_track'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "demo_requests"
WHERE "lead_track" IS NOT NULL
AND "lead_track"::text NOT IN ('DISCOVERY', 'SALES', 'ENTERPRISE')
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert demo_requests.lead_track to DemoLeadTrack: invalid values exist';
END IF;

```
FOR constraint_name IN
  SELECT c.conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'demo_requests'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%lead_track%'
LOOP
  EXECUTE format('ALTER TABLE "demo_requests" DROP CONSTRAINT IF EXISTS %I', constraint_name);
END LOOP;

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_track" DROP DEFAULT;

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_track" TYPE "DemoLeadTrack"
  USING "lead_track"::text::"DemoLeadTrack";

ALTER TABLE "demo_requests"
  ALTER COLUMN "lead_track" SET DEFAULT 'DISCOVERY'::"DemoLeadTrack";
```

END IF;
END $$;

-- demo_requests.recommended_action: text -> DemoRecommendedAction
DO $$
DECLARE
constraint_name TEXT;
BEGIN
IF EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'demo_requests'
AND column_name = 'recommended_action'
AND udt_name = 'text'
) THEN
IF EXISTS (
SELECT 1
FROM "demo_requests"
WHERE "recommended_action" IS NOT NULL
AND "recommended_action"::text NOT IN (
'reply_with_resources',
'offer_demo',
'route_enterprise'
)
LIMIT 1
) THEN
RAISE EXCEPTION 'Cannot convert demo_requests.recommended_action to DemoRecommendedAction: invalid values exist';
END IF;

```
FOR constraint_name IN
  SELECT c.conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'demo_requests'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%recommended_action%'
LOOP
  EXECUTE format('ALTER TABLE "demo_requests" DROP CONSTRAINT IF EXISTS %I', constraint_name);
END LOOP;

ALTER TABLE "demo_requests"
  ALTER COLUMN "recommended_action" DROP DEFAULT;

ALTER TABLE "demo_requests"
  ALTER COLUMN "recommended_action" TYPE "DemoRecommendedAction"
  USING "recommended_action"::text::"DemoRecommendedAction";

ALTER TABLE "demo_requests"
  ALTER COLUMN "recommended_action" SET DEFAULT 'reply_with_resources'::"DemoRecommendedAction";
```

END IF;
END $$;
