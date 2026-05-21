-- =============================================================================
-- Phase 32.6.2 — Reviewer Ops naming drift repair (idempotent backfill)
-- =============================================================================
--
-- Root cause:
--   Five Prisma fields on reviewer_ops models were missing `@map("snake_case")`
--   annotations:
--     - ReviewEscalation.safeSummary           -> safe_summary
--     - ReviewEscalation.resolutionNote        -> resolution_note
--     - ReviewerWorkloadSnapshot.safeNote      -> safe_note
--     - ReviewerOpsReminder.dedupKey           -> dedup_key
--     - ReviewerOpsReminder.safeSummary        -> safe_summary
--
--   Without @map, the Prisma client emits quoted camelCase column names in
--   INSERT/SELECT SQL ("safeSummary", "resolutionNote", "safeNote",
--   "dedupKey"). Migrations created snake_case columns. In production this
--   produced TWO physical columns per affected field — one that migrations
--   manage, one that the Prisma client actually reads and writes.
--
--   Symptoms:
--     - Runtime schema validation marked reviewer_ops degraded.
--     - SELECTs through Prisma returned NULL safe summaries / notes even
--       though the snake_case columns had data (and vice versa).
--
-- Strategy (enterprise-safe, no data loss):
--   1. Schema fix (committed in services/api/prisma/schema.prisma): add
--      @map(...) on all five fields. From this migration forward Prisma
--      writes to the snake_case columns exclusively.
--
--   2. This migration: defensively COPY data from any residual camelCase
--      column into the snake_case column where the snake_case value is
--      NULL. Wrapped in DO blocks that check information_schema FIRST so
--      this is a no-op on greenfield deploys (which only ever had
--      snake_case columns).
--
--   3. NOT DROPPING the camelCase columns here. That is intentional:
--      preserving them is the rollback path. A separate cleanup migration
--      will drop them after operators confirm the snake_case columns hold
--      every row's data (e.g. by running the verification SELECTs at the
--      bottom of this file and getting zero rows back).
--
-- Rollback:
--   - Revert the five @map(...) annotations in schema.prisma.
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
-- review_escalations: safeSummary -> safe_summary, resolutionNote -> resolution_note
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  has_camel_safe_summary    BOOLEAN;
  has_snake_safe_summary    BOOLEAN;
  has_camel_resolution_note BOOLEAN;
  has_snake_resolution_note BOOLEAN;
  rows_backfilled           INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'review_escalations'
      AND column_name = 'safeSummary'
  ) INTO has_camel_safe_summary;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'review_escalations'
      AND column_name = 'safe_summary'
  ) INTO has_snake_safe_summary;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'review_escalations'
      AND column_name = 'resolutionNote'
  ) INTO has_camel_resolution_note;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'review_escalations'
      AND column_name = 'resolution_note'
  ) INTO has_snake_resolution_note;

  -- Backfill safe_summary from "safeSummary" where snake_case is NULL or empty.
  -- safe_summary is NOT NULL in schema, but if duplicate columns coexist the
  -- migration that added the NOT NULL constraint may have left rows with the
  -- column populated by the snake_case default; we only overwrite NULLs.
  IF has_camel_safe_summary AND has_snake_safe_summary THEN
    EXECUTE 'UPDATE "review_escalations"
             SET "safe_summary" = "safeSummary"
             WHERE ("safe_summary" IS NULL OR "safe_summary" = '''')
               AND "safeSummary" IS NOT NULL
               AND "safeSummary" <> ''''';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.2: review_escalations.safe_summary backfilled % rows from "safeSummary"', rows_backfilled;
  ELSIF has_camel_safe_summary AND NOT has_snake_safe_summary THEN
    RAISE NOTICE 'phase-32.6.2: review_escalations has "safeSummary" but no safe_summary — unexpected; investigate before dropping camelCase';
  ELSE
    RAISE NOTICE 'phase-32.6.2: review_escalations.safe_summary backfill skipped (camelCase residue absent)';
  END IF;

  IF has_camel_resolution_note AND has_snake_resolution_note THEN
    EXECUTE 'UPDATE "review_escalations"
             SET "resolution_note" = "resolutionNote"
             WHERE "resolution_note" IS NULL
               AND "resolutionNote" IS NOT NULL';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.2: review_escalations.resolution_note backfilled % rows from "resolutionNote"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.2: review_escalations.resolution_note backfill skipped (camelCase residue absent)';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- reviewer_workload_snapshots: safeNote -> safe_note
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  has_camel BOOLEAN;
  has_snake BOOLEAN;
  rows_backfilled INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_workload_snapshots'
      AND column_name = 'safeNote'
  ) INTO has_camel;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_workload_snapshots'
      AND column_name = 'safe_note'
  ) INTO has_snake;

  IF has_camel AND has_snake THEN
    EXECUTE 'UPDATE "reviewer_workload_snapshots"
             SET "safe_note" = "safeNote"
             WHERE "safe_note" IS NULL
               AND "safeNote" IS NOT NULL';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.2: reviewer_workload_snapshots.safe_note backfilled % rows from "safeNote"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.2: reviewer_workload_snapshots.safe_note backfill skipped (camelCase residue absent)';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- reviewer_ops_reminders: dedupKey -> dedup_key, safeSummary -> safe_summary
--
-- dedup_key participates in @@unique([teamId, kind, dedupKey]). The backfill
-- only fires on rows where dedup_key IS NULL, so it cannot introduce a
-- conflict with an existing populated dedup_key value. If two NULL rows have
-- the same "dedupKey" value the second UPDATE would violate the unique
-- constraint — we surface that as a NOTICE and let the operator triage rather
-- than swallowing the conflict.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  has_camel_dedup_key       BOOLEAN;
  has_snake_dedup_key       BOOLEAN;
  has_camel_safe_summary    BOOLEAN;
  has_snake_safe_summary    BOOLEAN;
  rows_backfilled           INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_ops_reminders'
      AND column_name = 'dedupKey'
  ) INTO has_camel_dedup_key;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_ops_reminders'
      AND column_name = 'dedup_key'
  ) INTO has_snake_dedup_key;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_ops_reminders'
      AND column_name = 'safeSummary'
  ) INTO has_camel_safe_summary;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviewer_ops_reminders'
      AND column_name = 'safe_summary'
  ) INTO has_snake_safe_summary;

  IF has_camel_dedup_key AND has_snake_dedup_key THEN
    BEGIN
      EXECUTE 'UPDATE "reviewer_ops_reminders"
               SET "dedup_key" = "dedupKey"
               WHERE ("dedup_key" IS NULL OR "dedup_key" = '''')
                 AND "dedupKey" IS NOT NULL
                 AND "dedupKey" <> ''''';
      GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
      RAISE NOTICE 'phase-32.6.2: reviewer_ops_reminders.dedup_key backfilled % rows from "dedupKey"', rows_backfilled;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'phase-32.6.2: reviewer_ops_reminders.dedup_key backfill hit unique_violation — duplicate "dedupKey" values across NULL snake_case rows; operator must reconcile before re-running';
    END;
  ELSE
    RAISE NOTICE 'phase-32.6.2: reviewer_ops_reminders.dedup_key backfill skipped (camelCase residue absent)';
  END IF;

  IF has_camel_safe_summary AND has_snake_safe_summary THEN
    EXECUTE 'UPDATE "reviewer_ops_reminders"
             SET "safe_summary" = "safeSummary"
             WHERE ("safe_summary" IS NULL OR "safe_summary" = '''')
               AND "safeSummary" IS NOT NULL
               AND "safeSummary" <> ''''';
    GET DIAGNOSTICS rows_backfilled = ROW_COUNT;
    RAISE NOTICE 'phase-32.6.2: reviewer_ops_reminders.safe_summary backfilled % rows from "safeSummary"', rows_backfilled;
  ELSE
    RAISE NOTICE 'phase-32.6.2: reviewer_ops_reminders.safe_summary backfill skipped (camelCase residue absent)';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- Post-migration verification queries (operator-run, not part of the
-- migration transaction). Each must return zero rows before a follow-up
-- cleanup migration drops the camelCase columns:
--
--   SELECT count(*) FROM "review_escalations"
--     WHERE (safe_summary IS NULL OR safe_summary = '')
--       AND ("safeSummary" IS NOT NULL AND "safeSummary" <> '');
--
--   SELECT count(*) FROM "review_escalations"
--     WHERE resolution_note IS NULL AND "resolutionNote" IS NOT NULL;
--
--   SELECT count(*) FROM "reviewer_workload_snapshots"
--     WHERE safe_note IS NULL AND "safeNote" IS NOT NULL;
--
--   SELECT count(*) FROM "reviewer_ops_reminders"
--     WHERE (dedup_key IS NULL OR dedup_key = '')
--       AND ("dedupKey" IS NOT NULL AND "dedupKey" <> '');
--
--   SELECT count(*) FROM "reviewer_ops_reminders"
--     WHERE (safe_summary IS NULL OR safe_summary = '')
--       AND ("safeSummary" IS NOT NULL AND "safeSummary" <> '');
--
-- The cleanup migration is intentionally NOT shipped here; it should run
-- after the verification queries return zero and at least one full reconcile
-- cycle has executed against the snake_case columns under the patched
-- Prisma client.
-- =============================================================================
