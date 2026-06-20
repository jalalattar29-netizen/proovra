-- Phase: Contact Sales lead capture — sibling to demo_requests.
--
-- Phase O-Final safety pattern:
--   * CREATE TYPE wrapped in DO + EXCEPTION block so re-running is safe.
--   * CREATE TABLE uses IF NOT EXISTS.
--   * Every CREATE INDEX is wrapped in a DO block guarded by an
--     information_schema.columns existence check for each referenced
--     column. The classifier in services/api/scripts/full-migration-audit.mjs
--     accepts this as CREATE_INDEX_GUARDED (MEDIUM), not INDEX_COLUMN_RISK.
--   * Purely additive: no DROP, no RENAME, no UPDATE/DELETE on existing
--     tables.
--
-- No subscriptions mutated. No existing demo_requests rows touched.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Enum types
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'ContactSalesStatus'
  ) THEN
    CREATE TYPE "ContactSalesStatus" AS ENUM (
      'NEW',
      'REVIEWED',
      'CONTACTED',
      'QUALIFIED',
      'REJECTED',
      'ARCHIVED'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'ContactSalesPriority'
  ) THEN
    CREATE TYPE "ContactSalesPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 2. contact_sales_requests table
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contact_sales_requests" (
  "id"                  UUID DEFAULT gen_random_uuid() NOT NULL,
  "full_name"           VARCHAR(160) NOT NULL,
  "work_email"          VARCHAR(320) NOT NULL,
  "organization"        VARCHAR(180) NOT NULL,
  "job_title"           VARCHAR(120),
  "country"             VARCHAR(120),
  "team_size"           VARCHAR(64),

  "discussion_topic"    VARCHAR(64)  NOT NULL,
  "stage"               VARCHAR(64)  NOT NULL,
  "current_challenge"   TEXT         NOT NULL,
  "deployment_timeline" VARCHAR(64),
  "estimated_users"     VARCHAR(64),
  "additional_details"  TEXT,

  "source"              VARCHAR(120),
  "source_page"         VARCHAR(120),
  "source_path"         VARCHAR(512),
  "referrer"            VARCHAR(2048),
  "utm_source"          VARCHAR(160),
  "utm_medium"          VARCHAR(160),
  "utm_campaign"        VARCHAR(160),
  "utm_term"            VARCHAR(160),
  "utm_content"         VARCHAR(160),

  "status"              "ContactSalesStatus"   NOT NULL DEFAULT 'NEW',
  "priority"            "ContactSalesPriority" NOT NULL DEFAULT 'NORMAL',
  "is_spam"             BOOLEAN                NOT NULL DEFAULT FALSE,

  "email_sent_at"       TIMESTAMPTZ(6),
  "webhook_sent_at"     TIMESTAMPTZ(6),

  "reviewed_at"         TIMESTAMPTZ(6),
  "reviewed_by_user_id" UUID,
  "notes"               TEXT,

  "ip_address"          VARCHAR(45),
  "user_agent"          VARCHAR(512),

  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_sales_requests_pkey" PRIMARY KEY ("id")
);

-- ──────────────────────────────────────────────────────────────────────
-- 3. Indexes — Phase O-Final guarded by column existence checks
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'status'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "contact_sales_requests_status_created_at_idx"
             ON "contact_sales_requests" ("status", "created_at" DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'priority'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "contact_sales_requests_priority_created_at_idx"
             ON "contact_sales_requests" ("priority", "created_at" DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'work_email'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "contact_sales_requests_work_email_idx"
             ON "contact_sales_requests" ("work_email")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'organization'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "contact_sales_requests_organization_idx"
             ON "contact_sales_requests" ("organization")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_sales_requests'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "contact_sales_requests_created_at_idx"
             ON "contact_sales_requests" ("created_at" DESC)';
  END IF;
END $$;
