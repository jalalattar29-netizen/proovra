-- PHASE 4A ENTERPRISE CLOSURE
--
-- Closes the audit gaps with three additive changes:
--
--   1. `evidence.department_id` — optional FK enabling department
--      isolation enforcement at the query layer.
--   2. `trust_center_articles` gains drift columns (drift_state,
--      last_reference_check_at, missing_references) so articles can
--      flip to STALE when implementation references move.
--   3. Two new tables — `department_memberships` (the user ↔ dept
--      relation that the scope resolver consults) and
--      `security_claim_checks` (per-control implementation snapshot).
--
-- Hard rules:
--   * Brand-new tables → plain CREATE TABLE.
--   * Every CREATE INDEX wrapped in DO/information_schema guard with
--     column-existence checks for every referenced column.
--   * Additive ALTER columns use ADD COLUMN IF NOT EXISTS.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. evidence.department_id  (additive)
-- ---------------------------------------------------------------------------

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "department_id" UUID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='evidence'
                AND column_name='department_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='evidence'
                    AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_team_department_idx" ON "evidence" ("team_id", "department_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. trust_center_articles drift columns (additive)
-- ---------------------------------------------------------------------------

ALTER TABLE "trust_center_articles"
  ADD COLUMN IF NOT EXISTS "drift_state" VARCHAR(20) NOT NULL DEFAULT 'CURRENT';

ALTER TABLE "trust_center_articles"
  ADD COLUMN IF NOT EXISTS "last_reference_check_at" TIMESTAMPTZ(6);

ALTER TABLE "trust_center_articles"
  ADD COLUMN IF NOT EXISTS "missing_references" JSONB;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='trust_center_articles'
                AND column_name='drift_state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_articles'
                    AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_articles_team_drift_idx" ON "trust_center_articles" ("team_id", "drift_state")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. department_memberships  (NEW)
-- ---------------------------------------------------------------------------

CREATE TABLE "department_memberships" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"            UUID         NOT NULL,
  "department_id"      UUID         NOT NULL,
  "user_id"            UUID         NOT NULL,
  "role"               VARCHAR(20)  NOT NULL DEFAULT 'MEMBER',
  "state"              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "granted_by_user_id" UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at_utc"     TIMESTAMPTZ(6),
  CONSTRAINT "department_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "department_memberships_dept_user_uniq"
  ON "department_memberships" ("department_id", "user_id");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='department_memberships'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='department_memberships'
                    AND column_name='user_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='department_memberships'
                    AND column_name='department_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='department_memberships'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "department_memberships_team_user_state_idx" ON "department_memberships" ("team_id", "user_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "department_memberships_team_dept_state_idx" ON "department_memberships" ("team_id", "department_id", "state")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. security_claim_checks  (NEW)
-- ---------------------------------------------------------------------------

CREATE TABLE "security_claim_checks" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID         NOT NULL,
  "control_key"                 VARCHAR(60)  NOT NULL,
  "documented"                  BOOLEAN      NOT NULL DEFAULT TRUE,
  "implemented"                 BOOLEAN      NOT NULL,
  "implementation_references_ok" BOOLEAN     NOT NULL DEFAULT FALSE,
  "evidence_paths"              JSONB        NOT NULL,
  "limitation"                  VARCHAR(600),
  "owner_user_id"               UUID,
  "last_verified_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "security_claim_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "security_claim_checks_team_control_uniq"
  ON "security_claim_checks" ("team_id", "control_key");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='security_claim_checks'
                AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='security_claim_checks'
                    AND column_name='implemented') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "security_claim_checks_team_implemented_idx" ON "security_claim_checks" ("team_id", "implemented")';
  END IF;
END $$;

COMMIT;
