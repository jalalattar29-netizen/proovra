-- =============================================================================
-- Phase 25 — Reviewer Operations Intelligence + SLA Engine
-- =============================================================================
-- Adds:
--   1. Three additive nullable columns on `evidence_review_workflows`
--      (assignment_due_at_utc, completion_due_at_utc, paused_reason,
--      active_escalation_id) + two indexes.
--   2. New table `review_escalations` (first-class escalation lifecycle).
--   3. New table `reviewer_workload_snapshots` (periodic per-reviewer
--      capacity snapshot).
--
-- Forward-only. No DROP / RENAME on existing surface. All ADD COLUMN
-- statements are NULLABLE; existing rows continue to work unchanged.
--
-- Rollback at the bottom of this file (commented). Apply by hand
-- inside a transaction if you need to back out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Additive columns on evidence_review_workflows
-- -----------------------------------------------------------------------------

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "assignment_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completion_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "paused_reason"         VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "active_escalation_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_assignment_due_at_utc_idx"
  ON "evidence_review_workflows" ("assignment_due_at_utc");

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_completion_due_at_utc_idx"
  ON "evidence_review_workflows" ("completion_due_at_utc");

-- -----------------------------------------------------------------------------
-- 2. review_escalations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "review_escalations" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "workflow_id"              UUID         NOT NULL,
  "workflow_instance_id"     UUID,
  "evidence_id"              UUID,
  "reason"                   VARCHAR(48)  NOT NULL,
  "severity"                 VARCHAR(16)  NOT NULL DEFAULT 'WARNING',
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  "safe_summary"             VARCHAR(400) NOT NULL,
  "created_by_user_id"       UUID,
  "assigned_to_user_id"      UUID,
  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "acknowledged_by_user_id"  UUID,
  "resolved_at_utc"          TIMESTAMPTZ(6),
  "resolved_by_user_id"      UUID,
  "resolution_note"          VARCHAR(400),
  "suppressed_at_utc"        TIMESTAMPTZ(6),
  "suppression_reason"       VARCHAR(400),
  "incident_id"              UUID,
  "fingerprint"              VARCHAR(80)  NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "review_escalations_pkey" PRIMARY KEY ("id")
);

-- Unique (team, fingerprint) prevents the reconcile job from spawning
-- two escalations for the same workflow + reason on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS "review_escalations_team_fingerprint_uk"
  ON "review_escalations" ("team_id", "fingerprint");

CREATE INDEX IF NOT EXISTS "review_escalations_team_status_idx"
  ON "review_escalations" ("team_id", "status");

CREATE INDEX IF NOT EXISTS "review_escalations_team_severity_idx"
  ON "review_escalations" ("team_id", "severity");

CREATE INDEX IF NOT EXISTS "review_escalations_team_reason_idx"
  ON "review_escalations" ("team_id", "reason");

CREATE INDEX IF NOT EXISTS "review_escalations_workflow_created_idx"
  ON "review_escalations" ("workflow_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "review_escalations_workflow_instance_idx"
  ON "review_escalations" ("workflow_instance_id");

CREATE INDEX IF NOT EXISTS "review_escalations_assigned_to_status_idx"
  ON "review_escalations" ("assigned_to_user_id", "status");

CREATE INDEX IF NOT EXISTS "review_escalations_incident_idx"
  ON "review_escalations" ("incident_id");

-- Foreign keys.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_team_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_workflow_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_workflow_id_fkey"
      FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_assigned_to_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_assigned_to_user_id_fkey"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_acknowledged_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_acknowledged_by_user_id_fkey"
      FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_resolved_by_user_id_fkey'
  ) THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_resolved_by_user_id_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. reviewer_workload_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "reviewer_workload_snapshots" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID         NOT NULL,
  "reviewer_user_id"            UUID         NOT NULL,
  "active_review_count"         INTEGER      NOT NULL DEFAULT 0,
  "overdue_review_count"        INTEGER      NOT NULL DEFAULT 0,
  "due_soon_review_count"       INTEGER      NOT NULL DEFAULT 0,
  "escalated_review_count"      INTEGER      NOT NULL DEFAULT 0,
  "needs_info_review_count"     INTEGER      NOT NULL DEFAULT 0,
  "capacity_score"              INTEGER      NOT NULL DEFAULT 100,
  "safe_note"                   VARCHAR(400),
  "computed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviewer_workload_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_reviewer_computed_idx"
  ON "reviewer_workload_snapshots"
     ("team_id", "reviewer_user_id", "computed_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_computed_idx"
  ON "reviewer_workload_snapshots" ("team_id", "computed_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_capacity_idx"
  ON "reviewer_workload_snapshots" ("team_id", "capacity_score");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_team_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_reviewer_user_id_fkey'
  ) THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_reviewer_user_id_fkey"
      FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- Run after apply to confirm the install. Each query must return > 0.
-- -----------------------------------------------------------------------------
--
-- SELECT 'review_escalations'         AS table_name, COUNT(*) AS exists_count
--   FROM information_schema.tables
--   WHERE table_name = 'review_escalations';
-- SELECT 'reviewer_workload_snapshots' AS table_name, COUNT(*) AS exists_count
--   FROM information_schema.tables
--   WHERE table_name = 'reviewer_workload_snapshots';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'evidence_review_workflows'
--     AND column_name IN ('assignment_due_at_utc','completion_due_at_utc','paused_reason','active_escalation_id');
-- SELECT indexname FROM pg_indexes
--   WHERE tablename IN ('review_escalations','reviewer_workload_snapshots','evidence_review_workflows')
--     AND indexname LIKE '%phase25%'
--      OR indexname IN (
--        'review_escalations_team_fingerprint_uk',
--        'reviewer_workload_snapshots_team_reviewer_computed_idx',
--        'evidence_review_workflows_assignment_due_at_utc_idx',
--        'evidence_review_workflows_completion_due_at_utc_idx'
--      );
--
-- -----------------------------------------------------------------------------
-- ROLLBACK (manual)
-- Apply inside a transaction. Order matters — drop FKs / indexes before
-- the tables, and drop columns last.
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "reviewer_workload_snapshots";
-- DROP TABLE IF EXISTS "review_escalations";
-- ALTER TABLE "evidence_review_workflows"
--   DROP COLUMN IF EXISTS "active_escalation_id",
--   DROP COLUMN IF EXISTS "paused_reason",
--   DROP COLUMN IF EXISTS "completion_due_at_utc",
--   DROP COLUMN IF EXISTS "assignment_due_at_utc";
-- DROP INDEX IF EXISTS "evidence_review_workflows_assignment_due_at_utc_idx";
-- DROP INDEX IF EXISTS "evidence_review_workflows_completion_due_at_utc_idx";
-- COMMIT;
