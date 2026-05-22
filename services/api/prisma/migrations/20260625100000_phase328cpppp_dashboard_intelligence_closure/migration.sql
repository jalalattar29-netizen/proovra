-- =============================================================================
-- Phase 32.8C++++ — Dashboard Intelligence Closure
-- =============================================================================
-- Adds:
--   1. evidence_integrity_snapshots (1:1 with evidence; advisory mirror of
--      worker integrity classifier output)
--   2. access_anomalies + AccessAnomalyCategory / AccessAnomalySeverity /
--      AccessAnomalyStatus enums (persisted classifier output for the
--      access/security anomaly engine)
--   3. evidence_reviewer_comments.resolved_at_utc / resolved_by_user_id
--      (coordination resolution tracking)
--   4. evidence_annotations.resolved_at_utc / resolved_by_user_id (same)
--
-- Forward-only. All ALTER TABLE statements use IF NOT EXISTS or are
-- nullable + default-bearing. CREATE TYPE wrapped in DO $$ IF NOT
-- EXISTS guards for idempotency.
--
-- Risks:
--   * `evidence_integrity_snapshots` and `access_anomalies` are
--     ADVISORY operational data — empty tables on first deploy are
--     expected. Dashboard readers fall back to live computation when
--     rows are missing.
--   * No data backfill is performed by this migration. Backfill is
--     handled by the `integrity-snapshot.service.ts` writer when the
--     dashboard requests it (lazy population).
--   * Cascade rules: integrity-snapshot row is cascaded on Evidence
--     delete; access_anomaly row is cascaded on Team delete and SET
--     NULL'd on Evidence delete (the anomaly history survives
--     evidence deletion).
--
-- Rollback (operator-side, in psql):
--   DROP INDEX IF EXISTS "evidence_integrity_snapshots_overall_status_idx";
--   DROP INDEX IF EXISTS "evidence_integrity_snapshots_computed_at_utc_idx";
--   DROP INDEX IF EXISTS "evidence_integrity_snapshots_team_id_overall_status_idx";
--   DROP TABLE IF EXISTS "evidence_integrity_snapshots";
--   DROP INDEX IF EXISTS "access_anomalies_severity_idx";
--   DROP INDEX IF EXISTS "access_anomalies_evidence_id_idx";
--   DROP INDEX IF EXISTS "access_anomalies_actor_user_id_idx";
--   DROP INDEX IF EXISTS "access_anomalies_team_id_created_at_idx";
--   DROP INDEX IF EXISTS "access_anomalies_team_id_category_idx";
--   DROP INDEX IF EXISTS "access_anomalies_team_id_status_idx";
--   DROP TABLE IF EXISTS "access_anomalies";
--   DROP TYPE IF EXISTS "AccessAnomalyStatus";
--   DROP TYPE IF EXISTS "AccessAnomalySeverity";
--   DROP TYPE IF EXISTS "AccessAnomalyCategory";
--   ALTER TABLE "evidence_reviewer_comments" DROP COLUMN IF EXISTS "resolved_at_utc";
--   ALTER TABLE "evidence_reviewer_comments" DROP COLUMN IF EXISTS "resolved_by_user_id";
--   ALTER TABLE "evidence_annotations" DROP COLUMN IF EXISTS "resolved_at_utc";
--   ALTER TABLE "evidence_annotations" DROP COLUMN IF EXISTS "resolved_by_user_id";
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. evidence_integrity_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_integrity_snapshots" (
  "id"                          UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"                 UUID NOT NULL,
  "team_id"                     UUID,

  "canonical_hash_matches"      BOOLEAN,
  "signature_valid"             BOOLEAN,
  "custody_chain_valid"         BOOLEAN,
  "timestamp_digest_matches"    BOOLEAN,
  "ots_hash_matches"            BOOLEAN,

  "tsa_status"                  VARCHAR(24),
  "ots_status"                  VARCHAR(24),
  "overall_status"              VARCHAR(24),

  "reason_codes"                JSONB,

  "computed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "source_version"              VARCHAR(32),

  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "evidence_integrity_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_integrity_snapshots_evidence_id_key"
    UNIQUE ("evidence_id"),
  CONSTRAINT "evidence_integrity_snapshots_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "evidence_integrity_snapshots_team_id_overall_status_idx"
  ON "evidence_integrity_snapshots" ("team_id", "overall_status");
CREATE INDEX IF NOT EXISTS "evidence_integrity_snapshots_computed_at_utc_idx"
  ON "evidence_integrity_snapshots" ("computed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "evidence_integrity_snapshots_overall_status_idx"
  ON "evidence_integrity_snapshots" ("overall_status");

-- -----------------------------------------------------------------------------
-- 2. access_anomalies + enums
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalyCategory') THEN
    CREATE TYPE "AccessAnomalyCategory" AS ENUM (
      'REPEATED_FAILED_ACCESS',
      'BLOCKED_EXPORT_ATTEMPT',
      'API_CREDENTIAL_CHANGE',
      'WEBHOOK_FAILURE_SPIKE',
      'ADMIN_ROLE_CHANGE',
      'STEP_UP_FAILED',
      'PERMISSION_DENIED_BURST',
      'UNCATEGORIZED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalySeverity') THEN
    CREATE TYPE "AccessAnomalySeverity" AS ENUM (
      'INFO',
      'WARNING',
      'HIGH',
      'CRITICAL'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalyStatus') THEN
    CREATE TYPE "AccessAnomalyStatus" AS ENUM (
      'OPEN',
      'ACKNOWLEDGED',
      'RESOLVED',
      'SUPPRESSED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "access_anomalies" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "actor_user_id"            UUID,
  "evidence_id"              UUID,
  "case_id"                  UUID,

  "category"                 "AccessAnomalyCategory" NOT NULL,
  "severity"                 "AccessAnomalySeverity" NOT NULL DEFAULT 'WARNING',
  "status"                   "AccessAnomalyStatus"   NOT NULL DEFAULT 'OPEN',

  "sample_event_type"        VARCHAR(80) NOT NULL,
  "count"                    INTEGER     NOT NULL DEFAULT 1,

  "window_start_utc"         TIMESTAMPTZ(6) NOT NULL,
  "window_end_utc"           TIMESTAMPTZ(6) NOT NULL,

  "source_event_ids"         JSONB,
  "summary"                  VARCHAR(400),

  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "acknowledged_by_user_id"  UUID,
  "resolved_at_utc"          TIMESTAMPTZ(6),
  "resolved_by_user_id"      UUID,
  "resolution_note"          VARCHAR(400),

  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "access_anomalies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_anomalies_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_anomalies_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "access_anomalies_team_id_status_idx"
  ON "access_anomalies" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "access_anomalies_team_id_category_idx"
  ON "access_anomalies" ("team_id", "category");
CREATE INDEX IF NOT EXISTS "access_anomalies_team_id_created_at_idx"
  ON "access_anomalies" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "access_anomalies_actor_user_id_idx"
  ON "access_anomalies" ("actor_user_id");
CREATE INDEX IF NOT EXISTS "access_anomalies_evidence_id_idx"
  ON "access_anomalies" ("evidence_id");
CREATE INDEX IF NOT EXISTS "access_anomalies_severity_idx"
  ON "access_anomalies" ("severity");

-- -----------------------------------------------------------------------------
-- 3. coordination resolution columns
-- -----------------------------------------------------------------------------

ALTER TABLE "evidence_reviewer_comments"
  ADD COLUMN IF NOT EXISTS "resolved_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolved_by_user_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_resolved_at_utc_idx"
  ON "evidence_reviewer_comments" ("resolved_at_utc");

ALTER TABLE "evidence_annotations"
  ADD COLUMN IF NOT EXISTS "resolved_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolved_by_user_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_annotations_resolved_at_utc_idx"
  ON "evidence_annotations" ("resolved_at_utc");
