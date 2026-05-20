-- =============================================================================
-- Phase 31.22 — reviewer_ops drift consolidation patch.
-- =============================================================================
--
-- Reviewer_ops subsystem reported `runtime.schema_validation.degraded`
-- at API startup because at least one of the registered fields below
-- is missing in the production database. The canonical migration that
-- creates them lives at:
--
--   services/api/prisma/migrations/
--     20260601100000_add_reviewer_operations_phase25/migration.sql
--
-- That migration is idempotent (every CREATE / ALTER guarded by
-- IF NOT EXISTS) but won't run if Prisma believes it has already
-- been applied OR if the `_prisma_migrations` ledger drifted on this
-- environment. This drift patch is the safe-by-construction operator
-- recovery: run it directly via psql to bring the schema up to spec
-- WITHOUT touching the Prisma migration ledger.
--
-- Hard rules preserved:
--   * No DROP. No data migration. No destructive operations.
--   * Every CREATE / ALTER guarded by IF NOT EXISTS / NOT EXISTS.
--   * Wrapped in BEGIN / COMMIT for atomicity.
--   * Idempotent: re-running this patch is a no-op once applied.
--
-- The fields registered by `services/api/src/runtime/schema-validation.ts`
-- under the reviewer_ops subsystem are:
--   * table  evidence_review_workflows
--   * column evidence_review_workflows.assignment_due_at_utc (critical)
--   * column evidence_review_workflows.completion_due_at_utc (critical)
--   * column evidence_review_workflows.paused_reason         (critical)
--   * column evidence_review_workflows.active_escalation_id  (critical)
--   * table  evidence_review_workflow_events                 (critical)
--   * table  review_escalations                              (critical)
--   * index  review_escalations.review_escalations_team_fingerprint_uk (critical)
--   * table  reviewer_workload_snapshots                     (critical)
--   * table  reviewer_ops_reminders                          (important)
--   * table  saved_search_views                              (important)
--   * column saved_search_views.scope                        (critical)
--   * column saved_search_views.query_json                   (critical)
--   * column saved_search_views.visibility                   (important)
--   * column saved_search_views.pinned                       (important)
--   * column saved_search_views.last_used_at_utc             (important)
--
-- This patch reissues only the Phase 25 reviewer-operations additions
-- (the largest cluster). The saved_search_views.scope column is
-- already covered by 2026-05-19-saved-search-views-scope.sql.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-20-reviewer-ops-phase25-consolidation.sql
--
-- Verification (post-apply):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN (
--      'evidence_review_workflows','evidence_review_workflow_events',
--      'review_escalations','reviewer_workload_snapshots',
--      'reviewer_ops_reminders'
--    );
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'evidence_review_workflows'
--      AND column_name IN (
--        'assignment_due_at_utc','completion_due_at_utc',
--        'paused_reason','active_escalation_id'
--      );
--   SELECT indexname FROM pg_indexes
--    WHERE indexname = 'review_escalations_team_fingerprint_uk';
--
-- Rollback: see the rollback block at the bottom of
--   services/api/prisma/migrations/20260601100000_add_reviewer_operations_phase25/migration.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Additive columns on evidence_review_workflows.
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
-- 2. review_escalations table + indexes + FKs.
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
-- 3. reviewer_workload_snapshots table + indexes + FKs.
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

COMMIT;
