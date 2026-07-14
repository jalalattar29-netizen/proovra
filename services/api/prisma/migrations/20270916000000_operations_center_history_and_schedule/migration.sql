-- Operations Center — persistent history snapshots, notification schedule
-- settings (quiet hours / timezone / digest bookkeeping), and per-preference
-- email delivery frequency.
--
-- ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
-- guarded index creation. No destructive or data-mutating statements.
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. operations_inbox_snapshots — persistent per-user history of surfaced
--    Operations Center items. Operational audit records; NOT part of the
--    legal evidence chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "operations_inbox_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "item_key" VARCHAR(200) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(200),
  "team_id" UUID,
  "org_id" UUID,
  "category" VARCHAR(64) NOT NULL,
  "severity" VARCHAR(16) NOT NULL,
  "priority" VARCHAR(4) NOT NULL,
  "title" VARCHAR(300) NOT NULL,
  "body" VARCHAR(1200) NOT NULL,
  "href" VARCHAR(300) NOT NULL,
  "due_at_utc" TIMESTAMPTZ(6),
  "source_occurred_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "first_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "read_at_utc" TIMESTAMPTZ(6),
  "dismissed_at_utc" TIMESTAMPTZ(6),
  "snoozed_until_utc" TIMESTAMPTZ(6),
  "resolved_at_utc" TIMESTAMPTZ(6),
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "operations_inbox_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_item_key_key"
  ON "operations_inbox_snapshots"("user_id", "item_key");
CREATE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_last_seen_at_utc_idx"
  ON "operations_inbox_snapshots"("user_id", "last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_category_last_seen_at_u_idx"
  ON "operations_inbox_snapshots"("user_id", "category", "last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_resolved_at_utc_idx"
  ON "operations_inbox_snapshots"("user_id", "resolved_at_utc");
CREATE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_read_at_utc_idx"
  ON "operations_inbox_snapshots"("user_id", "read_at_utc");
CREATE INDEX IF NOT EXISTS "operations_inbox_snapshots_user_id_team_id_idx"
  ON "operations_inbox_snapshots"("user_id", "team_id");

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    BEGIN
      ALTER TABLE "operations_inbox_snapshots"
        ADD CONSTRAINT "operations_inbox_snapshots_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. notification_schedule_settings — per (user, workspace) timezone,
--    quiet hours, and digest bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "notification_schedule_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
  "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  "quiet_start_minute" INTEGER NOT NULL DEFAULT 1320,
  "quiet_end_minute" INTEGER NOT NULL DEFAULT 420,
  "quiet_critical_override" BOOLEAN NOT NULL DEFAULT true,
  "last_hourly_digest_at" TIMESTAMPTZ(6),
  "last_daily_digest_at" TIMESTAMPTZ(6),
  "last_weekly_digest_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "notification_schedule_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_schedule_settings_user_id_team_id_key"
  ON "notification_schedule_settings"("user_id", "team_id");
CREATE INDEX IF NOT EXISTS "notification_schedule_settings_team_id_idx"
  ON "notification_schedule_settings"("team_id");

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    BEGIN
      ALTER TABLE "notification_schedule_settings"
        ADD CONSTRAINT "notification_schedule_settings_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
  IF to_regclass('public.teams') IS NOT NULL THEN
    BEGIN
      ALTER TABLE "notification_schedule_settings"
        ADD CONSTRAINT "notification_schedule_settings_team_id_fkey"
        FOREIGN KEY ("team_id") REFERENCES "teams"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. workspace_notification_preferences.frequency — email delivery cadence
--    (IMMEDIATE | HOURLY | DAILY | WEEKLY | OFF). Additive with default.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.workspace_notification_preferences') IS NOT NULL THEN
    ALTER TABLE "workspace_notification_preferences"
      ADD COLUMN IF NOT EXISTS "frequency" VARCHAR(16) NOT NULL DEFAULT 'IMMEDIATE';
  END IF;
END $$;
