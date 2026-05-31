-- PHASE 3B ENTERPRISE CLOSURE
--
-- Closes the critical + important audit findings:
--
--   1. Correction version chain on `reviewer_corrections`
--      (versionNumber + parentCorrectionId + supersedesCorrectionId
--      + supersededByCorrectionId + supersededAt).
--
--   2. Canonical lifecycle audit log `intelligence_activity_events`
--      consolidating record / correction / budget / provider
--      lifecycle codes from MEDIA_INTELLIGENCE_ACTIVITY_CODES.
--
-- Hard rules (Phase O-Final compliant):
--   * Brand-new table → plain CREATE TABLE.
--   * Every CREATE INDEX wrapped in a DO/information_schema guard.
--   * Additive column adds use IF NOT EXISTS for replay safety.

BEGIN;

-- =============================================================================
-- 1. Correction version chain — additive columns on reviewer_corrections.
-- =============================================================================

ALTER TABLE "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "version_number" INT NOT NULL DEFAULT 1;

ALTER TABLE "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "parent_correction_id" UUID;

ALTER TABLE "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "supersedes_correction_id" UUID;

ALTER TABLE "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "superseded_by_correction_id" UUID;

ALTER TABLE "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "superseded_at_utc" TIMESTAMPTZ(6);

-- Phase O-Final defense — guard every column the index references so
-- the safety auditor classifies this as CREATE_INDEX_GUARDED.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='reviewer_corrections'
                AND column_name='version_number')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='reviewer_corrections'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='reviewer_corrections'
                    AND column_name='record_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "reviewer_corrections_team_record_version_idx" ON "reviewer_corrections" ("team_id", "record_id", "version_number")';
  END IF;
END $$;

-- =============================================================================
-- 2. intelligence_activity_events — canonical lifecycle audit log.
-- =============================================================================
CREATE TABLE "intelligence_activity_events" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID         NOT NULL,
  "category"          VARCHAR(40)  NOT NULL,
  "code"              VARCHAR(60)  NOT NULL,
  "actor_user_id"     UUID,
  "target_type"       VARCHAR(40),
  "target_id"         UUID,
  "record_id"         UUID,
  "correction_id"     UUID,
  "budget_id"         UUID,
  "evidence_id"       UUID,
  "case_id"           UUID,
  "project_id"        UUID,
  "provider"          VARCHAR(60),
  "operation"         VARCHAR(40),
  "failure_reason"    VARCHAR(200),
  "reason"            VARCHAR(200),
  "payload"           JSONB,
  "occurred_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "intelligence_activity_events_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='intelligence_activity_events'
                AND column_name='code') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_category_occ_idx" ON "intelligence_activity_events" ("team_id", "category", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_code_occ_idx" ON "intelligence_activity_events" ("team_id", "code", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_record_idx" ON "intelligence_activity_events" ("team_id", "record_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_correction_idx" ON "intelligence_activity_events" ("team_id", "correction_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_budget_idx" ON "intelligence_activity_events" ("team_id", "budget_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_evidence_idx" ON "intelligence_activity_events" ("team_id", "evidence_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_case_idx" ON "intelligence_activity_events" ("team_id", "case_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "intelligence_activity_events_team_project_idx" ON "intelligence_activity_events" ("team_id", "project_id")';
  END IF;
END $$;

COMMIT;
