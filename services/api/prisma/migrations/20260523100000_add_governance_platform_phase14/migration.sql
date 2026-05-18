-- Phase 14 — Enterprise governance platform
--
-- Forward-only additive migration:
--   * Three new enums (PublicVerifyState, RetentionPolicySource,
--     CaseLegalHoldStatus).
--   * Eight new CustodyEventType values.
--   * One new table (case_legal_holds).
--   * Eight new columns on evidence (publication state + retention
--     metadata).
--   * Two new columns on workspace_governance_policies (approval flags).
--
-- Default values preserve pre-Phase-14 behavior exactly: evidence rows
-- get publicVerifyState=PUBLISHED, retention columns null, approval
-- flags false.
--
-- Rollback:
--   DROP TABLE IF EXISTS case_legal_holds;
--   ALTER TABLE evidence DROP COLUMN IF EXISTS public_verify_state, ...;
--   ALTER TABLE workspace_governance_policies DROP COLUMN ...;
--   Enum values cannot be removed safely; new rows simply won't use them.

-- 1. New enums ------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "PublicVerifyState" AS ENUM (
    'NOT_PUBLISHED',
    'PUBLISHED',
    'SUSPENDED',
    'UNPUBLISHED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RetentionPolicySource" AS ENUM (
    'WORKSPACE_DEFAULT',
    'WORKFLOW_TEMPLATE',
    'EVIDENCE_OVERRIDE',
    'CASE_OVERRIDE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CaseLegalHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Extend CustodyEventType -----------------------------------------------

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'CASE_LEGAL_HOLD_APPLIED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'CASE_LEGAL_HOLD_RELEASED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'PUBLIC_VERIFY_PUBLISHED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'PUBLIC_VERIFY_UNPUBLISHED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'PUBLIC_VERIFY_SUSPENDED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'PUBLIC_VERIFY_RESTORED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'RETENTION_CANDIDATE_IDENTIFIED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'RETENTION_ARCHIVED';

-- 3. Evidence column additions --------------------------------------------

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "public_verify_state" "PublicVerifyState"
    NOT NULL DEFAULT 'PUBLISHED',
  ADD COLUMN IF NOT EXISTS "public_verify_published_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "public_verify_published_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "public_verify_suspended_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "public_verify_suspended_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "public_verify_suspension_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "retention_policy_source" "RetentionPolicySource",
  ADD COLUMN IF NOT EXISTS "retention_applied_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "retention_reconciliation_flagged_at_utc" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "evidence_public_verify_state_idx"
  ON "evidence" ("public_verify_state");
CREATE INDEX IF NOT EXISTS "evidence_retention_until_utc_idx"
  ON "evidence" ("retention_until_utc")
  WHERE "retention_until_utc" IS NOT NULL;

-- 4. WorkspaceGovernancePolicy column additions ---------------------------

ALTER TABLE "workspace_governance_policies"
  ADD COLUMN IF NOT EXISTS "require_publication_approval" BOOLEAN
    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "require_legal_hold_release_approval" BOOLEAN
    NOT NULL DEFAULT FALSE;

-- 5. CaseLegalHold table --------------------------------------------------

CREATE TABLE IF NOT EXISTS "case_legal_holds" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "case_id" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "reason" VARCHAR(4000),
  "status" "CaseLegalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "placed_by_user_id" UUID NOT NULL,
  "placed_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "released_by_user_id" UUID,
  "released_at_utc" TIMESTAMPTZ(6),
  "release_note" VARCHAR(4000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "case_legal_holds_case_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "case_legal_holds_team_status_idx"
  ON "case_legal_holds" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "case_legal_holds_case_status_idx"
  ON "case_legal_holds" ("case_id", "status");
CREATE INDEX IF NOT EXISTS "case_legal_holds_placed_by_idx"
  ON "case_legal_holds" ("placed_by_user_id");
