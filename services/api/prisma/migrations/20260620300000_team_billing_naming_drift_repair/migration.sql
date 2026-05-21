-- =============================================================================
-- Phase 32.6.3 — Team billing column naming drift repair (idempotent backfill)
-- =============================================================================
--
-- Root cause:
--   Four Team billing fields shipped on the Prisma model without `@map(...)`:
--     - Team.billingPlan      (PlanType)
--     - Team.billingStatus    (TeamBillingStatus)
--     - Team.includedSeats    (Int)
--     - Team.overSeatLimit    (Boolean)
--
--   No migration ever created these columns. Production was almost certainly
--   minted by `prisma db push` at some point, which would have created them
--   as quoted camelCase columns ("billingPlan", "billingStatus",
--   "includedSeats", "overSeatLimit"). The Prisma client has been reading and
--   writing those camelCase columns ever since.
--
--   `TeamBillingStatus` (enum) is in the same boat — referenced by Prisma but
--   never created by any migration. Same root cause: `prisma db push` minted
--   it directly.
--
--   Confirmed call sites that depend on these columns being readable:
--     - services/api/src/routes/analytics.routes.ts:293-297 (select clause)
--     - services/api/src/routes/analytics.routes.ts:416-447 (read loops)
--     - services/api/src/routes/evidence.routes.ts:3654-3661 (response shape)
--
-- Strategy (enterprise-safe, no data loss):
--   1. Schema fix (committed in services/api/prisma/schema.prisma): add
--      @map("snake_case") on all four fields. From this migration forward
--      Prisma writes to the snake_case columns exclusively.
--
--   2. Ensure the `TeamBillingStatus` enum exists in the DB (idempotent).
--
--   3. ADD COLUMN IF NOT EXISTS for the four snake_case columns with the
--      same defaults the Prisma model declares.
--
--   4. Defensively COPY data from any residual camelCase column into the
--      snake_case column where the snake_case value is still at its default.
--      Wrapped in DO blocks that check information_schema FIRST so this is
--      a no-op on greenfield deploys (which never had camelCase columns).
--
--   5. NOT DROPPING the camelCase columns here. That is intentional:
--      preserving them is the rollback path. A separate cleanup migration
--      will drop them after operators confirm zero residual divergence via
--      the verification queries embedded at the bottom of this file.
--
-- Rollback:
--   - Revert the four @map(...) annotations in schema.prisma.
--   - The camelCase columns still hold the original data — Prisma client
--     will resume reading/writing them as before.
--
-- Neon execution (operators):
--   This migration is applied via `prisma migrate deploy` in CI. To run
--   manually against a Neon branch:
--       psql "$DATABASE_URL" -f migration.sql
--   The file is idempotent; re-runs are safe.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Ensure `TeamBillingStatus` enum exists.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TeamBillingStatus') THEN
    CREATE TYPE "TeamBillingStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'PAST_DUE', 'CANCELED');
    RAISE NOTICE 'phase-32.6.3: created enum TeamBillingStatus';
  ELSE
    RAISE NOTICE 'phase-32.6.3: enum TeamBillingStatus already present (no-op)';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. ADD COLUMN IF NOT EXISTS for the four snake_case billing columns.
--    Defaults mirror the Prisma model declarations.
-- -----------------------------------------------------------------------------
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "billing_plan"     "PlanType"            NOT NULL DEFAULT 'FREE';
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "billing_status"   "TeamBillingStatus"   NOT NULL DEFAULT 'INACTIVE';
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "included_seats"   INTEGER               NOT NULL DEFAULT 0;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "over_seat_limit"  BOOLEAN               NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------------
-- 3. Backfill from camelCase residue → snake_case where the snake_case
--    column is still at its default and the camelCase column holds a
--    non-default value. The information_schema guard makes this a no-op
--    on greenfield deploys.
--
--    "Default value" here means:
--      billing_plan = 'FREE'        (original default)
--      billing_status = 'INACTIVE'  (original default)
--      included_seats = 0           (original default)
--      over_seat_limit = false      (original default)
--
--    The WHERE clause is conservative: only overwrite the snake_case
--    column when it is at the default AND the camelCase column has been
--    set to something else. This prevents overwriting deliberate writes
--    that have already gone through the patched Prisma client.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  has_billing_plan_camel    BOOLEAN;
  has_billing_status_camel  BOOLEAN;
  has_included_seats_camel  BOOLEAN;
  has_over_seat_limit_camel BOOLEAN;
  rows_backfilled           INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'teams' AND column_name = 'billingPlan'
  ) INTO has_billing_plan_camel;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'teams' AND column_name = 'billingStatus'
  ) INTO has_billing_status_camel;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'teams' AND column_name = 'includedSeats'
  ) INTO has_included_seats_camel;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'teams' AND column_name = 'overSeatLimit'
  ) INTO has_over_seat_limit_camel;

  IF has_billing_plan_camel THEN
    EXECUTE 'UPDATE "teams"
             SET "billing_plan" = "billingPlan"
             WHERE "billing_plan" = ''FREE''
               AND "billingPlan" IS NOT NULL
               AND "billingPlan" <> ''FREE''';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.3: teams.billing_plan backfilled % rows from "billingPlan"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.3: teams.billing_plan backfill skipped (camelCase residue absent)';
  END IF;

  IF has_billing_status_camel THEN
    EXECUTE 'UPDATE "teams"
             SET "billing_status" = "billingStatus"
             WHERE "billing_status" = ''INACTIVE''
               AND "billingStatus" IS NOT NULL
               AND "billingStatus" <> ''INACTIVE''';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.3: teams.billing_status backfilled % rows from "billingStatus"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.3: teams.billing_status backfill skipped (camelCase residue absent)';
  END IF;

  IF has_included_seats_camel THEN
    EXECUTE 'UPDATE "teams"
             SET "included_seats" = "includedSeats"
             WHERE "included_seats" = 0
               AND "includedSeats" IS NOT NULL
               AND "includedSeats" <> 0';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.3: teams.included_seats backfilled % rows from "includedSeats"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.3: teams.included_seats backfill skipped (camelCase residue absent)';
  END IF;

  IF has_over_seat_limit_camel THEN
    EXECUTE 'UPDATE "teams"
             SET "over_seat_limit" = "overSeatLimit"
             WHERE "over_seat_limit" = false
               AND "overSeatLimit" IS NOT NULL
               AND "overSeatLimit" = true';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.3: teams.over_seat_limit backfilled % rows from "overSeatLimit"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.3: teams.over_seat_limit backfill skipped (camelCase residue absent)';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- Post-migration verification queries (operator-run, not part of the
-- migration transaction). Each must return zero rows before a follow-up
-- cleanup migration drops the camelCase columns:
--
--   SELECT count(*) FROM "teams"
--     WHERE billing_plan = 'FREE'
--       AND "billingPlan" IS NOT NULL
--       AND "billingPlan" <> 'FREE';
--
--   SELECT count(*) FROM "teams"
--     WHERE billing_status = 'INACTIVE'
--       AND "billingStatus" IS NOT NULL
--       AND "billingStatus" <> 'INACTIVE';
--
--   SELECT count(*) FROM "teams"
--     WHERE included_seats = 0
--       AND "includedSeats" IS NOT NULL
--       AND "includedSeats" <> 0;
--
--   SELECT count(*) FROM "teams"
--     WHERE over_seat_limit = false
--       AND "overSeatLimit" IS NOT NULL
--       AND "overSeatLimit" = true;
--
-- The cleanup migration is intentionally NOT shipped here; it should run
-- after the verification queries return zero AND at least one full billing
-- cycle has executed against the snake_case columns under the patched
-- Prisma client.
-- =============================================================================
