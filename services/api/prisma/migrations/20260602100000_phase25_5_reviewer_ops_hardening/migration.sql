-- =============================================================================
-- Phase 25.5 — Reviewer Operations Hardening
-- =============================================================================
-- Adds:
--   1. Additive nullable / default-true columns on
--      `workspace_governance_policies` for Phase 25.5 SLA overrides
--      and step-up flags.
--   2. New `scope` column + indexes on `saved_search_views` so the
--      Phase 24 table can also hold Phase 25.5 reviewer-ops queue
--      views without a duplicate table.
--   3. New `reviewer_ops_reminders` table — dedup ledger for the
--      Phase 25.5 reminder engine.
--
-- Forward-only. All ADD COLUMN statements are NULLABLE or
-- DEFAULT-bearing so existing rows continue to work unchanged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. workspace_governance_policies — Phase 25.5 columns
-- -----------------------------------------------------------------------------

ALTER TABLE "workspace_governance_policies"
  ADD COLUMN IF NOT EXISTS "default_assignment_due_hours"        INTEGER,
  ADD COLUMN IF NOT EXISTS "default_completion_due_hours"        INTEGER,
  ADD COLUMN IF NOT EXISTS "default_due_soon_hours"              INTEGER,
  ADD COLUMN IF NOT EXISTS "require_step_up_for_approve"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "require_step_up_for_reject"          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "require_step_up_for_escalation_resolve" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "require_step_up_for_bulk"            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "reviewer_inactivity_hours"           INTEGER;

-- -----------------------------------------------------------------------------
-- 2. saved_search_views — scope discriminator (SEARCH | REVIEWER_OPS)
-- -----------------------------------------------------------------------------

ALTER TABLE "saved_search_views"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(24) NOT NULL DEFAULT 'SEARCH';

CREATE INDEX IF NOT EXISTS "saved_search_views_team_scope_idx"
  ON "saved_search_views" ("team_id", "scope");

CREATE INDEX IF NOT EXISTS "saved_search_views_team_scope_visibility_idx"
  ON "saved_search_views" ("team_id", "scope", "visibility");

-- -----------------------------------------------------------------------------
-- 3. reviewer_ops_reminders — dedup ledger
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "reviewer_ops_reminders" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "kind"                     VARCHAR(40)  NOT NULL,
  "dedup_key"                VARCHAR(80)  NOT NULL,
  "workflow_id"              UUID,
  "escalation_id"            UUID,
  "reviewer_user_id"         UUID,
  "safe_summary"             VARCHAR(400) NOT NULL,
  "communication_message_id" UUID,
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'SCHEDULED',
  "day_bucket"               VARCHAR(10)  NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviewer_ops_reminders_pkey" PRIMARY KEY ("id")
);

-- Unique (team, kind, dedupKey) is the primary dedup gate. The service
-- catches the duplicate-key error and treats it as "already scheduled".
CREATE UNIQUE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_kind_dedup_uk"
  ON "reviewer_ops_reminders" ("team_id", "kind", "dedup_key");

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_kind_created_idx"
  ON "reviewer_ops_reminders" ("team_id", "kind", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_workflow_idx"
  ON "reviewer_ops_reminders" ("team_id", "workflow_id");

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_reviewer_created_idx"
  ON "reviewer_ops_reminders" ("team_id", "reviewer_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_ops_reminders_team_status_idx"
  ON "reviewer_ops_reminders" ("team_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reviewer_ops_reminders_team_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_ops_reminders"
      ADD CONSTRAINT "reviewer_ops_reminders_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- Each query must return > 0 after a successful apply.
-- -----------------------------------------------------------------------------
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'workspace_governance_policies'
--     AND column_name IN (
--       'default_assignment_due_hours',
--       'default_completion_due_hours',
--       'default_due_soon_hours',
--       'require_step_up_for_approve',
--       'require_step_up_for_reject',
--       'require_step_up_for_escalation_resolve',
--       'require_step_up_for_bulk',
--       'reviewer_inactivity_hours'
--     );
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'saved_search_views' AND column_name = 'scope';
-- SELECT 'reviewer_ops_reminders' AS t, COUNT(*) FROM information_schema.tables
--   WHERE table_name = 'reviewer_ops_reminders';
-- SELECT indexname FROM pg_indexes
--   WHERE indexname IN (
--     'saved_search_views_team_scope_idx',
--     'reviewer_ops_reminders_team_kind_dedup_uk'
--   );
--
-- -----------------------------------------------------------------------------
-- ROLLBACK (manual)
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "reviewer_ops_reminders";
-- DROP INDEX IF EXISTS "saved_search_views_team_scope_idx";
-- DROP INDEX IF EXISTS "saved_search_views_team_scope_visibility_idx";
-- ALTER TABLE "saved_search_views" DROP COLUMN IF EXISTS "scope";
-- ALTER TABLE "workspace_governance_policies"
--   DROP COLUMN IF EXISTS "reviewer_inactivity_hours",
--   DROP COLUMN IF EXISTS "require_step_up_for_bulk",
--   DROP COLUMN IF EXISTS "require_step_up_for_escalation_resolve",
--   DROP COLUMN IF EXISTS "require_step_up_for_reject",
--   DROP COLUMN IF EXISTS "require_step_up_for_approve",
--   DROP COLUMN IF EXISTS "default_due_soon_hours",
--   DROP COLUMN IF EXISTS "default_completion_due_hours",
--   DROP COLUMN IF EXISTS "default_assignment_due_hours";
-- COMMIT;
