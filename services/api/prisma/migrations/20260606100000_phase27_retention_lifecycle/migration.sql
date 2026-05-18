-- =============================================================================
-- Phase 27 — Enterprise Retention + Legal Hold + Compliance Lifecycle Platform
-- =============================================================================
-- Adds:
--   1. EvidenceLifecycleState enum + 3 additive columns on `evidence`.
--   2. evidence_retention_policies (versioned policy objects).
--   3. evidence_retention_policy_versions (append-only history).
--   4. destruction_reviews (operator-approval queue).
--   5. evidence_lifecycle_events (append-only lifecycle ledger).
--
-- Forward-only. All ALTER TABLE statements are NULLABLE / default-bearing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. EvidenceLifecycleState enum + evidence columns
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceLifecycleState') THEN
    CREATE TYPE "EvidenceLifecycleState" AS ENUM (
      'ACTIVE',
      'UNDER_REVIEW',
      'ON_HOLD',
      'RETENTION_LOCKED',
      'PENDING_DESTRUCTION',
      'DESTROYED',
      'ARCHIVED'
    );
  END IF;
END
$$;

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "lifecycle_state"               "EvidenceLifecycleState" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "retention_policy_version_id"   UUID,
  ADD COLUMN IF NOT EXISTS "active_destruction_review_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_lifecycle_state_idx"
  ON "evidence" ("lifecycle_state");
CREATE INDEX IF NOT EXISTS "evidence_retention_policy_version_idx"
  ON "evidence" ("retention_policy_version_id");

-- -----------------------------------------------------------------------------
-- 2. evidence_retention_policies
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_retention_policies" (
  "id"                           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                      UUID         NOT NULL,
  "display_name"                 VARCHAR(180) NOT NULL,
  "description"                  VARCHAR(2000),
  "status"                       VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "scope"                        VARCHAR(24)  NOT NULL,
  "scope_qualifier"              VARCHAR(40),
  "case_id"                      UUID,
  "retention_days"               INTEGER,
  "immutable"                    BOOLEAN      NOT NULL DEFAULT FALSE,
  "auto_extension_enabled"       BOOLEAN      NOT NULL DEFAULT FALSE,
  "auto_extension_days"          INTEGER,
  "superseded_by_policy_id"      UUID,
  "current_version"              INTEGER      NOT NULL DEFAULT 1,
  "created_by_user_id"           UUID         NOT NULL,
  "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "archived_at_utc"              TIMESTAMPTZ(6),
  CONSTRAINT "evidence_retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_retention_policies_team_name_status_uk"
  ON "evidence_retention_policies" ("team_id", "display_name", "status");

CREATE INDEX IF NOT EXISTS "evidence_retention_policies_team_status_idx"
  ON "evidence_retention_policies" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_retention_policies_team_scope_idx"
  ON "evidence_retention_policies" ("team_id", "scope");
CREATE INDEX IF NOT EXISTS "evidence_retention_policies_case_idx"
  ON "evidence_retention_policies" ("case_id");
CREATE INDEX IF NOT EXISTS "evidence_retention_policies_superseded_idx"
  ON "evidence_retention_policies" ("superseded_by_policy_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_retention_policies_team_id_fkey') THEN
    ALTER TABLE "evidence_retention_policies"
      ADD CONSTRAINT "evidence_retention_policies_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_retention_policies_created_by_user_id_fkey') THEN
    ALTER TABLE "evidence_retention_policies"
      ADD CONSTRAINT "evidence_retention_policies_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. evidence_retention_policy_versions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_retention_policy_versions" (
  "id"                           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "retention_policy_id"          UUID         NOT NULL,
  "version"                      INTEGER      NOT NULL,
  "retention_days"               INTEGER,
  "immutable"                    BOOLEAN      NOT NULL DEFAULT FALSE,
  "auto_extension_enabled"       BOOLEAN      NOT NULL DEFAULT FALSE,
  "auto_extension_days"          INTEGER,
  "diff_json"                    JSONB,
  "authored_by_user_id"          UUID         NOT NULL,
  "change_note"                  VARCHAR(2000),
  "authored_at_utc"              TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_retention_policy_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_retention_policy_versions_policy_version_uk"
  ON "evidence_retention_policy_versions" ("retention_policy_id", "version");

CREATE INDEX IF NOT EXISTS "evidence_retention_policy_versions_policy_authored_idx"
  ON "evidence_retention_policy_versions" ("retention_policy_id", "authored_at_utc" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_retention_policy_versions_policy_id_fkey') THEN
    ALTER TABLE "evidence_retention_policy_versions"
      ADD CONSTRAINT "evidence_retention_policy_versions_policy_id_fkey"
      FOREIGN KEY ("retention_policy_id") REFERENCES "evidence_retention_policies"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_retention_policy_versions_authored_by_user_id_fkey') THEN
    ALTER TABLE "evidence_retention_policy_versions"
      ADD CONSTRAINT "evidence_retention_policy_versions_authored_by_user_id_fkey"
      FOREIGN KEY ("authored_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. destruction_reviews
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "destruction_reviews" (
  "id"                           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                      UUID         NOT NULL,
  "evidence_id"                  UUID         NOT NULL,
  "retention_policy_id"          UUID,
  "retention_policy_version"     INTEGER,
  "status"                       VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  "reason"                       VARCHAR(64)  NOT NULL,
  "decision_note"                VARCHAR(2000),
  "deferred_until_utc"           TIMESTAMPTZ(6),
  "initiated_by_user_id"         UUID,
  "decided_by_user_id"           UUID,
  "decided_at_utc"               TIMESTAMPTZ(6),
  "executed_at_utc"              TIMESTAMPTZ(6),
  "certificate_hash"             VARCHAR(128),
  "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "destruction_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "destruction_reviews_team_status_idx"
  ON "destruction_reviews" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "destruction_reviews_evidence_created_idx"
  ON "destruction_reviews" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "destruction_reviews_retention_policy_idx"
  ON "destruction_reviews" ("retention_policy_id");
CREATE INDEX IF NOT EXISTS "destruction_reviews_deferred_idx"
  ON "destruction_reviews" ("deferred_until_utc");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_reviews_team_id_fkey') THEN
    ALTER TABLE "destruction_reviews"
      ADD CONSTRAINT "destruction_reviews_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_reviews_evidence_id_fkey') THEN
    ALTER TABLE "destruction_reviews"
      ADD CONSTRAINT "destruction_reviews_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_reviews_initiated_by_user_id_fkey') THEN
    ALTER TABLE "destruction_reviews"
      ADD CONSTRAINT "destruction_reviews_initiated_by_user_id_fkey"
      FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'destruction_reviews_decided_by_user_id_fkey') THEN
    ALTER TABLE "destruction_reviews"
      ADD CONSTRAINT "destruction_reviews_decided_by_user_id_fkey"
      FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. evidence_lifecycle_events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "evidence_lifecycle_events" (
  "id"                           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                      UUID         NOT NULL,
  "evidence_id"                  UUID         NOT NULL,
  "from_state"                   VARCHAR(24),
  "to_state"                     VARCHAR(24)  NOT NULL,
  "event_type"                   VARCHAR(48)  NOT NULL,
  "summary"                      VARCHAR(400) NOT NULL,
  "metadata"                     JSONB,
  "actor_user_id"                UUID,
  "request_id"                   VARCHAR(64),
  "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "evidence_lifecycle_events_team_created_idx"
  ON "evidence_lifecycle_events" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_lifecycle_events_evidence_created_idx"
  ON "evidence_lifecycle_events" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_lifecycle_events_team_event_type_idx"
  ON "evidence_lifecycle_events" ("team_id", "event_type");
CREATE INDEX IF NOT EXISTS "evidence_lifecycle_events_team_to_state_idx"
  ON "evidence_lifecycle_events" ("team_id", "to_state");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_lifecycle_events_team_id_fkey') THEN
    ALTER TABLE "evidence_lifecycle_events"
      ADD CONSTRAINT "evidence_lifecycle_events_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_lifecycle_events_evidence_id_fkey') THEN
    ALTER TABLE "evidence_lifecycle_events"
      ADD CONSTRAINT "evidence_lifecycle_events_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- -----------------------------------------------------------------------------
--
-- SELECT typname FROM pg_type WHERE typname = 'EvidenceLifecycleState';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'evidence'
--     AND column_name IN ('lifecycle_state','retention_policy_version_id','active_destruction_review_id');
-- SELECT t FROM information_schema.tables WHERE table_name IN (
--   'evidence_retention_policies',
--   'evidence_retention_policy_versions',
--   'destruction_reviews',
--   'evidence_lifecycle_events'
-- ) AS x(t);
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "evidence_lifecycle_events";
-- DROP TABLE IF EXISTS "destruction_reviews";
-- DROP TABLE IF EXISTS "evidence_retention_policy_versions";
-- DROP TABLE IF EXISTS "evidence_retention_policies";
-- DROP INDEX IF EXISTS "evidence_lifecycle_state_idx";
-- DROP INDEX IF EXISTS "evidence_retention_policy_version_idx";
-- ALTER TABLE "evidence"
--   DROP COLUMN IF EXISTS "active_destruction_review_id",
--   DROP COLUMN IF EXISTS "retention_policy_version_id",
--   DROP COLUMN IF EXISTS "lifecycle_state";
-- DROP TYPE IF EXISTS "EvidenceLifecycleState";
-- COMMIT;
