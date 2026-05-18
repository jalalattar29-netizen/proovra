-- =============================================================================
-- Phase 27.5 — Governance operationalization.
--
-- Adds five operational tables that turn the configured Phase 27 governance
-- (retention policies, holds, lifecycle, destruction queue) into an enforceable
-- runtime:
--
--   1. governance_reconciliation_runs    — every worker run is recorded
--   2. destruction_executions            — per-attempt destruction state with
--                                          partial-failure recovery support
--   3. immutable_storage_checks          — DB ↔ S3 Object Lock drift tracking
--   4. governance_notifications          — dedupe + delivery state for
--                                          operator-facing governance alerts
--   5. governance_export_snapshots       — compliance lineage frozen per
--                                          export (hash + payload)
--
-- Hard rules:
--   - Forward-only. No DROP. No data backfill.
--   - Every FK guarded by DO $$ pg_constraint $$ block (idempotent).
--   - All enums use IF NOT EXISTS guards.
--   - All tables / indexes / constraints use IF NOT EXISTS where supported.
--
-- Verification queries are at the end. Rollback SQL is at the very bottom as
-- a comment — DO NOT auto-run; operator must paste manually after assessment.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceReconciliationKind') THEN
    CREATE TYPE "GovernanceReconciliationKind" AS ENUM (
      'RETENTION',
      'IMMUTABLE_STORAGE',
      'LIFECYCLE_DRIFT',
      'DESTRUCTION_SWEEP'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceReconciliationStatus') THEN
    CREATE TYPE "GovernanceReconciliationStatus" AS ENUM (
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'PARTIAL'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DestructionExecutionStatus') THEN
    CREATE TYPE "DestructionExecutionStatus" AS ENUM (
      'PLANNED',
      'EXECUTING',
      'STORAGE_DELETED',
      'TOMBSTONED',
      'COMPLETED',
      'FAILED',
      'ROLLED_BACK'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImmutableStorageCheckOutcome') THEN
    CREATE TYPE "ImmutableStorageCheckOutcome" AS ENUM (
      'OK',
      'MISSING_LOCK',
      'RETENTION_MISMATCH',
      'LEGAL_HOLD_MISMATCH',
      'COMPLIANCE_MODE_MISMATCH',
      'STORAGE_UNAVAILABLE',
      'EVIDENCE_NOT_FOUND'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceNotificationKind') THEN
    CREATE TYPE "GovernanceNotificationKind" AS ENUM (
      'DESTRUCTION_PENDING',
      'DESTRUCTION_APPROVED',
      'DESTRUCTION_EXECUTED',
      'DESTRUCTION_BLOCKED',
      'LEGAL_HOLD_PLACED',
      'LEGAL_HOLD_RELEASED',
      'RETENTION_CONFLICT',
      'RETENTION_EXTENSION_APPLIED',
      'LIFECYCLE_DRIFT',
      'IMMUTABLE_RECONCILIATION_FAILURE',
      'GOVERNANCE_INCIDENT_RAISED',
      'EXPORT_BLOCKED',
      'POLICY_OVERRIDE',
      'REVIEW_OVERDUE'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceNotificationSeverity') THEN
    CREATE TYPE "GovernanceNotificationSeverity" AS ENUM (
      'INFO',
      'WARNING',
      'HIGH',
      'CRITICAL'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceNotificationDeliveryStatus') THEN
    CREATE TYPE "GovernanceNotificationDeliveryStatus" AS ENUM (
      'PENDING',
      'SENT',
      'SUPPRESSED',
      'FAILED'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GovernanceExportSnapshotKind') THEN
    CREATE TYPE "GovernanceExportSnapshotKind" AS ENUM (
      'EVIDENCE_PACKAGE',
      'CASE_EXPORT',
      'AUDIT_EXPORT',
      'COMPLIANCE_BUNDLE'
    );
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- Table: governance_reconciliation_runs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "governance_reconciliation_runs" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                 UUID,
  "kind"                    "GovernanceReconciliationKind" NOT NULL,
  "trigger"                 VARCHAR(32) NOT NULL,
  "status"                  "GovernanceReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
  "started_at_utc"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at_utc"         TIMESTAMPTZ(6),
  "lock_key"                VARCHAR(128) NOT NULL,
  "triggered_by_user_id"    UUID,
  "scanned_count"           INTEGER NOT NULL DEFAULT 0,
  "matched_count"           INTEGER NOT NULL DEFAULT 0,
  "created_count"           INTEGER NOT NULL DEFAULT 0,
  "skipped_count"           INTEGER NOT NULL DEFAULT 0,
  "failed_count"            INTEGER NOT NULL DEFAULT 0,
  "incident_count"          INTEGER NOT NULL DEFAULT 0,
  "error_summary"           VARCHAR(2000),
  "metadata"                JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_reconciliation_runs_team_id_fkey') THEN
    ALTER TABLE "governance_reconciliation_runs"
      ADD CONSTRAINT "governance_reconciliation_runs_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_reconciliation_runs_triggered_by_user_id_fkey') THEN
    ALTER TABLE "governance_reconciliation_runs"
      ADD CONSTRAINT "governance_reconciliation_runs_triggered_by_user_id_fkey"
      FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "governance_reconciliation_runs_team_id_kind_started_at_idx"
  ON "governance_reconciliation_runs" ("team_id", "kind", "started_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "governance_reconciliation_runs_kind_status_idx"
  ON "governance_reconciliation_runs" ("kind", "status");
CREATE INDEX IF NOT EXISTS "governance_reconciliation_runs_lock_key_idx"
  ON "governance_reconciliation_runs" ("lock_key");

-- -----------------------------------------------------------------------------
-- Table: destruction_executions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "destruction_executions" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "evidence_id"              UUID NOT NULL,
  "destruction_review_id"    UUID NOT NULL,
  "status"                   "DestructionExecutionStatus" NOT NULL DEFAULT 'PLANNED',
  "phase"                    VARCHAR(48) NOT NULL,
  "attempt_count"            INTEGER NOT NULL DEFAULT 0,
  "planned_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "started_at_utc"           TIMESTAMPTZ(6),
  "storage_deleted_at_utc"   TIMESTAMPTZ(6),
  "tombstoned_at_utc"        TIMESTAMPTZ(6),
  "completed_at_utc"         TIMESTAMPTZ(6),
  "failed_at_utc"            TIMESTAMPTZ(6),
  "rolled_back_at_utc"       TIMESTAMPTZ(6),
  "executed_by_user_id"      UUID,
  "certificate_hash"         VARCHAR(128),
  "lineage_hash"             VARCHAR(128),
  "error_code"               VARCHAR(64),
  "error_detail"             VARCHAR(2000),
  "metadata"                 JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_executions_team_id_fkey') THEN
    ALTER TABLE "destruction_executions"
      ADD CONSTRAINT "destruction_executions_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_executions_evidence_id_fkey') THEN
    ALTER TABLE "destruction_executions"
      ADD CONSTRAINT "destruction_executions_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_executions_review_id_fkey') THEN
    ALTER TABLE "destruction_executions"
      ADD CONSTRAINT "destruction_executions_review_id_fkey"
      FOREIGN KEY ("destruction_review_id") REFERENCES "destruction_reviews"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_executions_executed_by_user_id_fkey') THEN
    ALTER TABLE "destruction_executions"
      ADD CONSTRAINT "destruction_executions_executed_by_user_id_fkey"
      FOREIGN KEY ("executed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "destruction_executions_team_id_status_idx"
  ON "destruction_executions" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "destruction_executions_review_id_status_idx"
  ON "destruction_executions" ("destruction_review_id", "status");
CREATE INDEX IF NOT EXISTS "destruction_executions_evidence_id_status_idx"
  ON "destruction_executions" ("evidence_id", "status");
CREATE INDEX IF NOT EXISTS "destruction_executions_planned_at_idx"
  ON "destruction_executions" ("planned_at_utc" DESC);

-- -----------------------------------------------------------------------------
-- Table: immutable_storage_checks
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "immutable_storage_checks" (
  "id"                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                    UUID NOT NULL,
  "evidence_id"                UUID NOT NULL,
  "outcome"                    "ImmutableStorageCheckOutcome" NOT NULL DEFAULT 'OK',
  "checked_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "db_retention_until_utc"     TIMESTAMPTZ(6),
  "db_legal_hold_active"       BOOLEAN NOT NULL DEFAULT false,
  "db_immutable"               BOOLEAN NOT NULL DEFAULT false,
  "storage_retain_until_utc"   TIMESTAMPTZ(6),
  "storage_legal_hold_active"  BOOLEAN,
  "storage_compliance_mode"    VARCHAR(32),
  "raised_incident_id"         UUID,
  "drift_summary"              VARCHAR(400),
  "metadata"                   JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'immutable_storage_checks_team_id_fkey') THEN
    ALTER TABLE "immutable_storage_checks"
      ADD CONSTRAINT "immutable_storage_checks_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'immutable_storage_checks_evidence_id_fkey') THEN
    ALTER TABLE "immutable_storage_checks"
      ADD CONSTRAINT "immutable_storage_checks_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "immutable_storage_checks_team_outcome_checked_at_idx"
  ON "immutable_storage_checks" ("team_id", "outcome", "checked_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "immutable_storage_checks_evidence_checked_at_idx"
  ON "immutable_storage_checks" ("evidence_id", "checked_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "immutable_storage_checks_raised_incident_idx"
  ON "immutable_storage_checks" ("raised_incident_id");

-- -----------------------------------------------------------------------------
-- Table: governance_notifications
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "governance_notifications" (
  "id"                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                     UUID NOT NULL,
  "kind"                        "GovernanceNotificationKind" NOT NULL,
  "severity"                    "GovernanceNotificationSeverity" NOT NULL DEFAULT 'INFO',
  "dedupe_key"                  VARCHAR(180) NOT NULL,
  "title"                       VARCHAR(200) NOT NULL,
  "summary"                     VARCHAR(1000) NOT NULL,
  "related_evidence_id"         UUID,
  "related_review_id"           UUID,
  "related_hold_id"             UUID,
  "related_policy_id"           UUID,
  "related_incident_id"         UUID,
  "first_seen_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at_utc"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "occurrence_count"            INTEGER NOT NULL DEFAULT 1,
  "delivery_status"             "GovernanceNotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "delivery_attempts"           INTEGER NOT NULL DEFAULT 0,
  "last_delivery_at_utc"        TIMESTAMPTZ(6),
  "channels"                    TEXT[] NOT NULL DEFAULT '{}',
  "recipient_user_ids"          UUID[] NOT NULL DEFAULT '{}',
  "acknowledged_at_utc"         TIMESTAMPTZ(6),
  "acknowledged_by_user_id"     UUID,
  "metadata"                    JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_notifications_team_id_fkey') THEN
    ALTER TABLE "governance_notifications"
      ADD CONSTRAINT "governance_notifications_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_notifications_related_evidence_id_fkey') THEN
    ALTER TABLE "governance_notifications"
      ADD CONSTRAINT "governance_notifications_related_evidence_id_fkey"
      FOREIGN KEY ("related_evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'governance_notifications_team_kind_dedupe_unique'
  ) THEN
    ALTER TABLE "governance_notifications"
      ADD CONSTRAINT "governance_notifications_team_kind_dedupe_unique"
      UNIQUE ("team_id", "kind", "dedupe_key");
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "governance_notifications_team_delivery_idx"
  ON "governance_notifications" ("team_id", "delivery_status");
CREATE INDEX IF NOT EXISTS "governance_notifications_team_kind_last_seen_idx"
  ON "governance_notifications" ("team_id", "kind", "last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "governance_notifications_team_severity_last_seen_idx"
  ON "governance_notifications" ("team_id", "severity", "last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "governance_notifications_related_evidence_idx"
  ON "governance_notifications" ("related_evidence_id");

-- -----------------------------------------------------------------------------
-- Table: governance_export_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "governance_export_snapshots" (
  "id"                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                      UUID NOT NULL,
  "evidence_id"                  UUID,
  "snapshot_kind"                "GovernanceExportSnapshotKind" NOT NULL,
  "created_by_user_id"           UUID,
  "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lifecycle_state"              VARCHAR(24) NOT NULL,
  "retention_policy_version_id"  UUID,
  "active_hold_ids"              UUID[] NOT NULL DEFAULT '{}',
  "governance_incident_ids"      UUID[] NOT NULL DEFAULT '{}',
  "export_eligibility_outcome"   VARCHAR(40) NOT NULL,
  "export_eligibility_reason"    VARCHAR(120) NOT NULL,
  "snapshot_hash"                VARCHAR(128) NOT NULL,
  "snapshot_payload"             JSONB NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_export_snapshots_team_id_fkey') THEN
    ALTER TABLE "governance_export_snapshots"
      ADD CONSTRAINT "governance_export_snapshots_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_export_snapshots_evidence_id_fkey') THEN
    ALTER TABLE "governance_export_snapshots"
      ADD CONSTRAINT "governance_export_snapshots_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governance_export_snapshots_created_by_user_id_fkey') THEN
    ALTER TABLE "governance_export_snapshots"
      ADD CONSTRAINT "governance_export_snapshots_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "governance_export_snapshots_team_created_at_idx"
  ON "governance_export_snapshots" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "governance_export_snapshots_evidence_created_at_idx"
  ON "governance_export_snapshots" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "governance_export_snapshots_team_kind_created_at_idx"
  ON "governance_export_snapshots" ("team_id", "snapshot_kind", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "governance_export_snapshots_hash_idx"
  ON "governance_export_snapshots" ("snapshot_hash");

-- -----------------------------------------------------------------------------
-- Verification (read-only — safe to run anytime)
-- -----------------------------------------------------------------------------

-- SELECT COUNT(*) FROM "governance_reconciliation_runs";
-- SELECT COUNT(*) FROM "destruction_executions";
-- SELECT COUNT(*) FROM "immutable_storage_checks";
-- SELECT COUNT(*) FROM "governance_notifications";
-- SELECT COUNT(*) FROM "governance_export_snapshots";

-- =============================================================================
-- Rollback (manual, in reverse order) — DO NOT auto-run.
-- =============================================================================
-- DROP TABLE IF EXISTS "governance_export_snapshots";
-- DROP TABLE IF EXISTS "governance_notifications";
-- DROP TABLE IF EXISTS "immutable_storage_checks";
-- DROP TABLE IF EXISTS "destruction_executions";
-- DROP TABLE IF EXISTS "governance_reconciliation_runs";
-- DROP TYPE  IF EXISTS "GovernanceExportSnapshotKind";
-- DROP TYPE  IF EXISTS "GovernanceNotificationDeliveryStatus";
-- DROP TYPE  IF EXISTS "GovernanceNotificationSeverity";
-- DROP TYPE  IF EXISTS "GovernanceNotificationKind";
-- DROP TYPE  IF EXISTS "ImmutableStorageCheckOutcome";
-- DROP TYPE  IF EXISTS "DestructionExecutionStatus";
-- DROP TYPE  IF EXISTS "GovernanceReconciliationStatus";
-- DROP TYPE  IF EXISTS "GovernanceReconciliationKind";
