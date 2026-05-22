-- =============================================================================
-- Phase 32.8D — Cases / Matter Workspace
-- =============================================================================
-- Adds:
--   1. cases columns: status, priority, description, reference_number,
--      closed_at_utc, closure_reason
--   2. cases unique index on (team_id, reference_number) when reference_number
--      is provided (partial unique via UNIQUE INDEX)
--   3. case_assignments table + CaseAssignmentRole / CaseAssignmentStatus enums
--   4. case_status_history table + CaseStatus / CasePriority enums
--   5. case_risk_snapshots table + CaseRiskLevel / CaseRiskSnapshotSource enums
--
-- Forward-only. All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS.
-- CREATE TYPE wrapped in DO $$ IF NOT EXISTS guards. CREATE TABLE statements
-- use IF NOT EXISTS.
--
-- Risks:
--   * case_risk_snapshots is ADVISORY operational data. Generator
--     failures MUST NEVER block evidence / report / package / verify
--     core flows.
--   * case_assignments + case_status_history are CANONICAL — every
--     change is audited via appendPlatformAuditLog at the service layer.
--   * No data backfill required. Existing cases default to status=OPEN,
--     priority=P2.
--   * Cascade: case_assignments / case_status_history / case_risk_snapshots
--     all CASCADE on Case delete.
--
-- Rollback (operator-side, in psql):
--   DROP TABLE IF EXISTS "case_risk_snapshots";
--   DROP TYPE  IF EXISTS "CaseRiskSnapshotSource";
--   DROP TYPE  IF EXISTS "CaseRiskLevel";
--   DROP TABLE IF EXISTS "case_status_history";
--   DROP TABLE IF EXISTS "case_assignments";
--   DROP TYPE  IF EXISTS "CaseAssignmentStatus";
--   DROP TYPE  IF EXISTS "CaseAssignmentRole";
--   DROP INDEX IF EXISTS "case_team_reference_number_uniq";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "closure_reason";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "closed_at_utc";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "reference_number";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "description";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "priority";
--   ALTER TABLE "cases" DROP COLUMN IF EXISTS "status";
--   DROP TYPE  IF EXISTS "CasePriority";
--   DROP TYPE  IF EXISTS "CaseStatus";
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. enums
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseStatus') THEN
    CREATE TYPE "CaseStatus" AS ENUM (
      'OPEN','INVESTIGATING','ON_HOLD','RESOLVED','CLOSED','ARCHIVED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CasePriority') THEN
    CREATE TYPE "CasePriority" AS ENUM ('P0','P1','P2','P3');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseAssignmentRole') THEN
    CREATE TYPE "CaseAssignmentRole" AS ENUM (
      'OWNER','INVESTIGATOR','REVIEWER','GOVERNANCE','OBSERVER'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseAssignmentStatus') THEN
    CREATE TYPE "CaseAssignmentStatus" AS ENUM ('ACTIVE','REMOVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseRiskLevel') THEN
    CREATE TYPE "CaseRiskLevel" AS ENUM (
      'NONE','LOW','MEDIUM','HIGH','CRITICAL'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseRiskSnapshotSource') THEN
    CREATE TYPE "CaseRiskSnapshotSource" AS ENUM (
      'DB_DERIVED','WORKER_INTERNAL','OTHER'
    );
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. cases — add matter-workspace columns
-- -----------------------------------------------------------------------------

ALTER TABLE "cases"
  ADD COLUMN IF NOT EXISTS "status"            "CaseStatus"   NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS "priority"          "CasePriority" NOT NULL DEFAULT 'P2',
  ADD COLUMN IF NOT EXISTS "description"       VARCHAR(4000),
  ADD COLUMN IF NOT EXISTS "reference_number"  VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "closed_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "closure_reason"    VARCHAR(400);

-- Phase 32.8D — partial UNIQUE INDEX on (team_id, reference_number) when
-- both are present. The Prisma compound unique is created without a
-- partial filter; this index enforces uniqueness only on rows where
-- reference_number is supplied.
CREATE UNIQUE INDEX IF NOT EXISTS "case_team_reference_number_uniq"
  ON "cases" ("team_id", "reference_number")
  WHERE "reference_number" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "cases_team_id_status_idx"
  ON "cases" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "cases_team_id_priority_idx"
  ON "cases" ("team_id", "priority");

-- -----------------------------------------------------------------------------
-- 3. case_assignments
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "case_assignments" (
  "id"                    UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID,
  "case_id"               UUID                       NOT NULL,
  "assigned_to_user_id"   UUID                       NOT NULL,
  "assigned_by_user_id"   UUID                       NOT NULL,
  "role"                  "CaseAssignmentRole"       NOT NULL,
  "status"                "CaseAssignmentStatus"     NOT NULL DEFAULT 'ACTIVE',
  "assigned_at_utc"       TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "removed_at_utc"        TIMESTAMPTZ(6),
  "removed_by_user_id"    UUID,
  "note"                  VARCHAR(400),

  "created_at"            TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),

  CONSTRAINT "case_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_assignments_case_id_assigned_to_user_id_role_key"
    UNIQUE ("case_id", "assigned_to_user_id", "role"),
  CONSTRAINT "case_assignments_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "case_assignments_team_id_status_idx"
  ON "case_assignments" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "case_assignments_case_id_status_idx"
  ON "case_assignments" ("case_id", "status");
CREATE INDEX IF NOT EXISTS "case_assignments_assigned_to_user_id_status_idx"
  ON "case_assignments" ("assigned_to_user_id", "status");
CREATE INDEX IF NOT EXISTS "case_assignments_role_idx"
  ON "case_assignments" ("role");

-- -----------------------------------------------------------------------------
-- 4. case_status_history
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "case_status_history" (
  "id"                  UUID            NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID,
  "case_id"             UUID            NOT NULL,
  "from_status"         "CaseStatus",
  "to_status"           "CaseStatus"    NOT NULL,
  "changed_by_user_id"  UUID            NOT NULL,
  "reason"              VARCHAR(400),
  "changed_at_utc"      TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),

  CONSTRAINT "case_status_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_status_history_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "case_status_history_case_id_changed_at_utc_idx"
  ON "case_status_history" ("case_id", "changed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "case_status_history_team_id_changed_at_utc_idx"
  ON "case_status_history" ("team_id", "changed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "case_status_history_to_status_idx"
  ON "case_status_history" ("to_status");

-- -----------------------------------------------------------------------------
-- 5. case_risk_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "case_risk_snapshots" (
  "id"                          UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID,
  "case_id"                     UUID                       NOT NULL,

  "risk_score"                  INTEGER                    NOT NULL,
  "risk_level"                  "CaseRiskLevel"            NOT NULL,

  "evidence_gap_count"          INTEGER                    NOT NULL DEFAULT 0,
  "open_incident_count"         INTEGER                    NOT NULL DEFAULT 0,
  "active_workflow_count"       INTEGER                    NOT NULL DEFAULT 0,
  "overdue_workflow_count"      INTEGER                    NOT NULL DEFAULT 0,
  "governance_blocker_count"    INTEGER                    NOT NULL DEFAULT 0,
  "reviewer_pressure_score"     INTEGER                    NOT NULL DEFAULT 0,
  "audit_readiness_score"       INTEGER                    NOT NULL DEFAULT 0,
  "custody_concern_count"       INTEGER                    NOT NULL DEFAULT 0,
  "integrity_concern_count"     INTEGER                    NOT NULL DEFAULT 0,
  "package_report_gap_count"    INTEGER                    NOT NULL DEFAULT 0,

  "reason_codes"                JSONB                      NOT NULL,
  "recommended_action"          VARCHAR(400)               NOT NULL,

  "sampled_at_utc"              TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "source"                      "CaseRiskSnapshotSource"   NOT NULL DEFAULT 'DB_DERIVED',
  "metadata_json"               JSONB,

  "created_at"                  TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),

  CONSTRAINT "case_risk_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_risk_snapshots_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "case_risk_snapshots_team_id_sampled_at_utc_idx"
  ON "case_risk_snapshots" ("team_id", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "case_risk_snapshots_case_id_sampled_at_utc_idx"
  ON "case_risk_snapshots" ("case_id", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "case_risk_snapshots_team_id_risk_level_idx"
  ON "case_risk_snapshots" ("team_id", "risk_level");
