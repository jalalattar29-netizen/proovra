-- =============================================================================
-- Phase 32.8C — Enterprise Operations Control Plane Closure
-- =============================================================================
-- Adds:
--   1. assignment lifecycle columns on operational_incidents
--      (assigned_operator_user_id, assigned_by_user_id, assigned_at_utc)
--   2. operational_correlations table + OperationalCorrelationType enum
--      (cross-system root-cause grouping)
--
-- Forward-only. All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS.
-- CREATE TABLE / CREATE TYPE wrapped in IF NOT EXISTS guards.
--
-- Risks:
--   * operational_correlations is ADVISORY operational data — generator
--     failures must NEVER block evidence / report / package / verify
--     core flows. Empty rows on first deploy are expected.
--   * No data backfill required. Assignment columns are nullable on
--     existing rows; correlations populate lazily on dashboard read.
--   * Cascade: operational_correlations has no FK to incidents — the
--     linkedIncidentIds JSON is a soft pointer. This is intentional:
--     correlation rows survive incident deletion so root-cause history
--     remains observable.
--
-- Rollback (operator-side, in psql):
--   DROP INDEX IF EXISTS "operational_correlations_correlation_type_idx";
--   DROP INDEX IF EXISTS "operational_correlations_team_id_severity_idx";
--   DROP INDEX IF EXISTS "operational_correlations_team_id_last_detected_at_utc_idx";
--   DROP TABLE IF EXISTS "operational_correlations";
--   DROP TYPE  IF EXISTS "OperationalCorrelationType";
--   DROP INDEX IF EXISTS "operational_incidents_assigned_operator_user_id_idx";
--   ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "assigned_at_utc";
--   ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "assigned_by_user_id";
--   ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "assigned_operator_user_id";
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. operational_incidents — assignment lifecycle columns
-- -----------------------------------------------------------------------------

ALTER TABLE "operational_incidents"
  ADD COLUMN IF NOT EXISTS "assigned_operator_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "assigned_by_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "assigned_at_utc"           TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "operational_incidents_assigned_operator_user_id_idx"
  ON "operational_incidents" ("assigned_operator_user_id");

-- -----------------------------------------------------------------------------
-- 2. operational_correlations + OperationalCorrelationType enum
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalCorrelationType') THEN
    CREATE TYPE "OperationalCorrelationType" AS ENUM (
      'PIPELINE_DEGRADATION',
      'REVIEW_BOTTLENECK',
      'AUDIT_READINESS_GAP',
      'GOVERNANCE_ESCALATION',
      'INFRASTRUCTURE_PRESSURE',
      'QUEUE_SATURATION_CHAIN',
      'RETRY_STORM_CHAIN',
      'OTHER'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "operational_correlations" (
  "id"                       UUID                          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID,

  "correlation_key"          VARCHAR(200)                  NOT NULL,
  "correlation_type"         "OperationalCorrelationType"  NOT NULL,
  "severity"                 "IncidentSeverity"            NOT NULL DEFAULT 'WARNING',

  "linked_incident_ids"      JSONB,
  "linked_case_ids"          JSONB,
  "linked_evidence_ids"      JSONB,
  "linked_queues"            JSONB,

  "root_operational_cause"   VARCHAR(400)                  NOT NULL,
  "operational_summary"      VARCHAR(400)                  NOT NULL,
  "recommended_action"       VARCHAR(400)                  NOT NULL,

  "confidence"               VARCHAR(16)                   NOT NULL,

  "first_detected_at_utc"    TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),
  "last_detected_at_utc"     TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),
  "expires_at_utc"           TIMESTAMPTZ(6)                NOT NULL,

  "created_at"               TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),

  CONSTRAINT "operational_correlations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_correlations_team_id_correlation_key_key"
    UNIQUE ("team_id", "correlation_key")
);

CREATE INDEX IF NOT EXISTS "operational_correlations_team_id_last_detected_at_utc_idx"
  ON "operational_correlations" ("team_id", "last_detected_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_correlations_team_id_severity_idx"
  ON "operational_correlations" ("team_id", "severity");
CREATE INDEX IF NOT EXISTS "operational_correlations_correlation_type_idx"
  ON "operational_correlations" ("correlation_type");
