-- Phase 9 Governance: WorkspaceGovernancePolicy + EvidenceLegalHold
--
-- Forward-only, additive migration:
--   * Two new enums (EvidenceDeletionMode, LegalHoldStatus).
--   * Five new CustodyEventType values for governance audit entries.
--   * Two new tables (workspace_governance_policies, evidence_legal_holds).
--   * No existing rows modified.
--
-- Default behavior is preserved when no policy row exists for a team.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS evidence_legal_holds;
--   DROP TABLE IF EXISTS workspace_governance_policies;
--   DROP TYPE IF EXISTS "LegalHoldStatus";
--   DROP TYPE IF EXISTS "EvidenceDeletionMode";
--   (Custody event values cannot be cleanly removed; they're inert until
--   code references them.)

-- 1. Enums -----------------------------------------------------------------

CREATE TYPE "EvidenceDeletionMode" AS ENUM (
  'ALLOWED',
  'ADMIN_ONLY',
  'DISABLED'
);

CREATE TYPE "LegalHoldStatus" AS ENUM (
  'ACTIVE',
  'RELEASED'
);

-- 2. CustodyEventType extensions ------------------------------------------

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_PLACED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_RELEASED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_LEGAL_HOLD';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_RETENTION';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXPORT_BLOCKED_BY_POLICY';

-- 3. workspace_governance_policies ----------------------------------------

CREATE TABLE "workspace_governance_policies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "default_retention_days" INTEGER,
  "evidence_deletion_mode" "EvidenceDeletionMode" NOT NULL DEFAULT 'ALLOWED',
  "require_legal_hold_approval_for_deletion" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_report" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_package" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_public_verify" BOOLEAN NOT NULL DEFAULT FALSE,
  "allow_external_intake" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_anonymous_intake" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_public_verify" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_package_download" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_report_download" BOOLEAN NOT NULL DEFAULT TRUE,
  "metadata_redaction_default" JSONB,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "workspace_governance_policies_team_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_governance_policies_updated_by_user_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workspace_governance_policies_team_id_key"
  ON "workspace_governance_policies" ("team_id");

-- 4. evidence_legal_holds -------------------------------------------------

CREATE TABLE "evidence_legal_holds" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "case_id" UUID,
  "title" VARCHAR(180) NOT NULL,
  "reason" VARCHAR(4000),
  "status" "LegalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "placed_by_user_id" UUID NOT NULL,
  "placed_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "released_by_user_id" UUID,
  "released_at_utc" TIMESTAMPTZ(6),
  "release_note" VARCHAR(4000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_legal_holds_team_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_legal_holds_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_legal_holds_placed_by_user_fkey"
    FOREIGN KEY ("placed_by_user_id") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_legal_holds_released_by_user_fkey"
    FOREIGN KEY ("released_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "evidence_legal_holds_team_status_idx"
  ON "evidence_legal_holds" ("team_id", "status");
CREATE INDEX "evidence_legal_holds_evidence_status_idx"
  ON "evidence_legal_holds" ("evidence_id", "status");
CREATE INDEX "evidence_legal_holds_case_idx"
  ON "evidence_legal_holds" ("case_id");
CREATE INDEX "evidence_legal_holds_placed_by_idx"
  ON "evidence_legal_holds" ("placed_by_user_id");
