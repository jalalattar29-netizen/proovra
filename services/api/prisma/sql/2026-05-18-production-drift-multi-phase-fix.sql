-- =============================================================================
-- Production drift fix — multi-phase Neon patch
--
-- Generated: 2026-05-18.
-- Target: production Neon DB whose prod drift query returned 9 missing
-- tables. After cross-referencing the names against the Prisma schema's
-- @@map values, the actual reality is:
--
--   User-reported missing name         Actual Prisma @@map target        Owning migration
--   ----------------------------------  -------------------------------- ------------------------------------------------
--   evidence_ai_categorizations         evidence_ai_categorizations      20260508133000_add_evidence_operations_workspace_features
--   evidence_annotations                evidence_annotations             same as above
--   evidence_legal_notes                evidence_legal_notes             same as above
--   evidence_reviewer_comments          evidence_reviewer_comments       same as above
--   integrations_api_keys      ❌→ ✅   api_credentials                  20260517140000_add_integrations_phase10
--   platform_governance_policies❌→ ✅   workspace_governance_policies    20260517100000_add_governance_phase9
--   reviewer_queue_snapshots   ❌→ ✅   reviewer_workload_snapshots      20260601100000_add_reviewer_operations_phase25
--   workflow_engine_definitions❌→ ✅   evidence_workflow_instances (+   20260530100000_add_workflow_engine_phase22
--                                       3 satellite tables)
--   workflow_templates         ❌→ ✅   evidence_workflow_templates      20260516120000_add_workflow_template_foundation
--
-- Five of the nine drift-query names DO NOT exist in the current
-- schema. The drift query was checking the wrong table names. This
-- patch creates the ACTUAL Prisma-mapped tables for the 5 phases the
-- operator likely intended. A corrected drift query is included at
-- the bottom of this file — re-run it to detect any remaining drift
-- using the real @@map values.
--
-- Hard rules:
--   * BEGIN / COMMIT.
--   * No DROP. No destructive ALTER. No data writes.
--   * CREATE TYPE guarded by DO $$ … IF NOT EXISTS via pg_type lookup.
--   * CREATE TABLE IF NOT EXISTS.
--   * CREATE INDEX IF NOT EXISTS.
--   * ALTER TABLE ADD COLUMN IF NOT EXISTS for additive columns.
--   * ALTER TABLE ADD CONSTRAINT inside DO $$ guarded by pg_constraint
--     lookup, so re-running is a no-op.
--   * Enum value additions use ALTER TYPE … ADD VALUE IF NOT EXISTS
--     (Postgres 12+).
--   * Safe to re-run on a DB that has SOME of these phases already.
-- =============================================================================

BEGIN;

-- =============================================================================
-- BLOCK A — Phase 9 Governance
--   Migration: 20260517100000_add_governance_phase9
--   Maps to user-reported "platform_governance_policies".
--   Creates: WorkspaceGovernancePolicy + EvidenceLegalHold + supporting
--   enums and custody event extensions.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'EvidenceDeletionMode'
  ) THEN
    CREATE TYPE "EvidenceDeletionMode" AS ENUM ('ALLOWED', 'ADMIN_ONLY', 'DISABLED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'LegalHoldStatus'
  ) THEN
    CREATE TYPE "LegalHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');
  END IF;
END$$;

-- CustodyEventType extensions (Phase 9). Inert until code references.
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_PLACED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_RELEASED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_LEGAL_HOLD';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_RETENTION';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXPORT_BLOCKED_BY_POLICY';

CREATE TABLE IF NOT EXISTS "workspace_governance_policies" (
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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_governance_policies_team_id_key"
  ON "workspace_governance_policies" ("team_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_governance_policies_team_fkey') THEN
    ALTER TABLE "workspace_governance_policies"
      ADD CONSTRAINT "workspace_governance_policies_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_governance_policies_updated_by_user_fkey') THEN
    ALTER TABLE "workspace_governance_policies"
      ADD CONSTRAINT "workspace_governance_policies_updated_by_user_fkey"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "evidence_legal_holds" (
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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "evidence_legal_holds_team_status_idx" ON "evidence_legal_holds" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_legal_holds_evidence_status_idx" ON "evidence_legal_holds" ("evidence_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_legal_holds_case_idx" ON "evidence_legal_holds" ("case_id");
CREATE INDEX IF NOT EXISTS "evidence_legal_holds_placed_by_idx" ON "evidence_legal_holds" ("placed_by_user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_team_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_evidence_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_evidence_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_placed_by_user_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_placed_by_user_fkey"
      FOREIGN KEY ("placed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_released_by_user_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_released_by_user_fkey"
      FOREIGN KEY ("released_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- =============================================================================
-- BLOCK B — Phase 10 Integrations
--   Migration: 20260517140000_add_integrations_phase10
--   Maps to user-reported "integrations_api_keys".
--   Creates: api_credentials + integration_webhook_endpoints +
--   integration_webhook_deliveries + supporting enums.
--   Also adds workspace_governance_policies.allow_original_download.
-- =============================================================================

ALTER TABLE "workspace_governance_policies"
  ADD COLUMN IF NOT EXISTS "allow_original_download" BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApiCredentialStatus') THEN
    CREATE TYPE "ApiCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookEndpointStatus') THEN
    CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookDeliveryStatus') THEN
    CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'CANCELLED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "api_credentials" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "name" VARCHAR(180) NOT NULL,
  "description" VARCHAR(2000),
  "key_prefix" VARCHAR(32) NOT NULL,
  "key_hash" VARCHAR(128) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "ApiCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" UUID NOT NULL,
  "last_used_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_credentials_key_hash_key" ON "api_credentials" ("key_hash");
CREATE INDEX IF NOT EXISTS "api_credentials_team_status_idx" ON "api_credentials" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "api_credentials_team_created_idx" ON "api_credentials" ("team_id", "created_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_team_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_created_by_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_created_by_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_revoked_by_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_revoked_by_fkey"
      FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "integration_webhook_endpoints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "description" VARCHAR(400),
  "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
  "secret_ciphertext" VARCHAR(512) NOT NULL,
  "secret_prefix" VARCHAR(32) NOT NULL,
  "event_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_success_at_utc" TIMESTAMPTZ(6),
  "last_failure_at_utc" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "integration_webhook_endpoints_team_status_idx"
  ON "integration_webhook_endpoints" ("team_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_endpoints_team_fkey') THEN
    ALTER TABLE "integration_webhook_endpoints"
      ADD CONSTRAINT "integration_webhook_endpoints_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_endpoints_created_by_fkey') THEN
    ALTER TABLE "integration_webhook_endpoints"
      ADD CONSTRAINT "integration_webhook_endpoints_created_by_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "integration_webhook_deliveries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "endpoint_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "event_id" VARCHAR(64) NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload_json" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at_utc" TIMESTAMPTZ(6),
  "response_status" INTEGER,
  "response_body_preview" VARCHAR(2000),
  "error_message" VARCHAR(2000),
  "sent_at_utc" TIMESTAMPTZ(6),
  "failed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_endpoint_created_idx"
  ON "integration_webhook_deliveries" ("endpoint_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_team_created_idx"
  ON "integration_webhook_deliveries" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_status_idx"
  ON "integration_webhook_deliveries" ("status");
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_next_attempt_idx"
  ON "integration_webhook_deliveries" ("next_attempt_at_utc");
CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_event_id_idx"
  ON "integration_webhook_deliveries" ("event_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_deliveries_endpoint_fkey') THEN
    ALTER TABLE "integration_webhook_deliveries"
      ADD CONSTRAINT "integration_webhook_deliveries_endpoint_fkey"
      FOREIGN KEY ("endpoint_id") REFERENCES "integration_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- =============================================================================
-- BLOCK C — Phase 2 Workflow Template Foundation
--   Migration: 20260516120000_add_workflow_template_foundation
--   Maps to user-reported "workflow_templates".
--   Creates: WorkspaceCategory enum + teams.workspace_category column +
--   evidence_workflow_templates table.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceCategory') THEN
    CREATE TYPE "WorkspaceCategory" AS ENUM (
      'GENERAL', 'INSURANCE', 'LEGAL', 'JOURNALISM',
      'INVESTIGATIONS', 'COMPLIANCE', 'FIELD_OPERATIONS',
      'RESEARCH', 'OTHER'
    );
  END IF;
END$$;

ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "workspace_category" "WorkspaceCategory";

CREATE INDEX IF NOT EXISTS "teams_workspace_category_idx"
  ON "teams" ("workspace_category");

CREATE TABLE IF NOT EXISTS "evidence_workflow_templates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" VARCHAR(120) NOT NULL,
  "team_id" UUID,
  "workspace_category" "WorkspaceCategory",
  "version" INTEGER NOT NULL DEFAULT 1,
  "name" VARCHAR(180) NOT NULL,
  "description" VARCHAR(2000),
  "archived" BOOLEAN NOT NULL DEFAULT FALSE,
  "plan_mode" VARCHAR(40) NOT NULL,
  "location_requirement" VARCHAR(20) NOT NULL,
  "intake_modes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowed_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "steps_json" JSONB NOT NULL,
  "rules_json" JSONB,
  "visibility_policy_json" JSONB,
  "review_policy_json" JSONB,
  "export_policy_json" JSONB,
  "created_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_team_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_created_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_updated_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_updated_by_user_id_fkey"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_id_archived_idx"
  ON "evidence_workflow_templates" ("team_id", "archived");
CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_id_workspace_category_idx"
  ON "evidence_workflow_templates" ("team_id", "workspace_category");
CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_slug_idx"
  ON "evidence_workflow_templates" ("slug");
CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_workspace_category_idx"
  ON "evidence_workflow_templates" ("workspace_category");
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_templates_team_slug_unique"
  ON "evidence_workflow_templates" ("team_id", "slug")
  WHERE "team_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_templates_global_slug_unique"
  ON "evidence_workflow_templates" ("slug")
  WHERE "team_id" IS NULL;

-- =============================================================================
-- BLOCK D — Phase 22 Workflow Engine (runtime instance + step + visibility)
--   Migration: 20260530100000_add_workflow_engine_phase22
--   Maps to user-reported "workflow_engine_definitions".
--   Creates: evidence_workflow_instances + evidence_workflow_instance_evidence
--   + evidence_workflow_step_instances + evidence_workflow_visibility_decisions
--   AND adds evidence_workflow_templates.status.
-- =============================================================================

ALTER TABLE "evidence_workflow_templates"
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_status_idx"
  ON "evidence_workflow_templates" ("team_id", "status");

CREATE TABLE IF NOT EXISTS "evidence_workflow_instances" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "template_id" UUID,
  "template_slug" VARCHAR(120),
  "template_version" INTEGER,
  "status" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  "pre_hold_status" VARCHAR(32),
  "intake_mode" VARCHAR(40) NOT NULL,
  "actor_role" VARCHAR(40) NOT NULL,
  "case_id" UUID,
  "claim_ref" VARCHAR(128),
  "matter_ref" VARCHAR(128),
  "evidence_request_id" UUID,
  "intake_session_id" UUID,
  "external_contact_hash" VARCHAR(64),
  "created_by_user_id" UUID,
  "assigned_reviewer_user_id" UUID,
  "title" VARCHAR(180),
  "submitted_at_utc" TIMESTAMPTZ(6),
  "approved_at_utc" TIMESTAMPTZ(6),
  "closed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_status_idx"
  ON "evidence_workflow_instances" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_created_at_idx"
  ON "evidence_workflow_instances" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_intake_mode_idx"
  ON "evidence_workflow_instances" ("team_id", "intake_mode");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_template_id_idx"
  ON "evidence_workflow_instances" ("template_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_evidence_request_id_idx"
  ON "evidence_workflow_instances" ("evidence_request_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_intake_session_id_idx"
  ON "evidence_workflow_instances" ("intake_session_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_external_contact_hash_idx"
  ON "evidence_workflow_instances" ("external_contact_hash");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_team_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_template_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "evidence_workflow_templates"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_created_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_assigned_reviewer_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_assigned_reviewer_user_id_fkey"
      FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  -- evidence_requests + workflow_intake_sessions are owned by phases
  -- that come AFTER this one. We add the FKs conditionally so a partial
  -- rollout still gets the table even if the parent tables aren't there
  -- yet. The application code never depends on the FK existing, only on
  -- the column shape.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evidence_requests')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_evidence_request_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_evidence_request_id_fkey"
      FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_intake_sessions')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_intake_session_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_intake_session_id_fkey"
      FOREIGN KEY ("intake_session_id") REFERENCES "workflow_intake_sessions"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "evidence_workflow_instance_evidence" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "step_instance_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_uk"
  ON "evidence_workflow_instance_evidence" ("workflow_instance_id", "evidence_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_evidence_id_idx"
  ON "evidence_workflow_instance_evidence" ("evidence_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_step_instance_id_idx"
  ON "evidence_workflow_instance_evidence" ("step_instance_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instance_evidence_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instance_evidence"
      ADD CONSTRAINT "evidence_workflow_instance_evidence_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instance_evidence_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instance_evidence"
      ADD CONSTRAINT "evidence_workflow_instance_evidence_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "evidence_workflow_step_instances" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "step_key" VARCHAR(80) NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT FALSE,
  "order_index" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
  "accepted_kinds_json" JSONB,
  "identity_requirement" VARCHAR(40),
  "location_requirement" VARCHAR(20),
  "mapped_evidence_id" UUID,
  "completed_by_user_id" UUID,
  "completed_at_utc" TIMESTAMPTZ(6),
  "waiver_reason" VARCHAR(400),
  "private_reviewer_note" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_step_uk"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "step_key");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_status_idx"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_order_idx"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "order_index");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_mapped_evidence_id_idx"
  ON "evidence_workflow_step_instances" ("mapped_evidence_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_completed_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_completed_by_user_id_fkey"
      FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_mapped_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_mapped_evidence_id_fkey"
      FOREIGN KEY ("mapped_evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "evidence_workflow_visibility_decisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "evidence_id" UUID,
  "field_key" VARCHAR(80) NOT NULL,
  "visible_in_app" BOOLEAN NOT NULL DEFAULT TRUE,
  "visible_to_contributor" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_public_verify" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_report" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_verification_package" BOOLEAN NOT NULL DEFAULT FALSE,
  "requires_redaction" BOOLEAN NOT NULL DEFAULT FALSE,
  "reason" VARCHAR(400) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_uk"
  ON "evidence_workflow_visibility_decisions" ("workflow_instance_id", "evidence_id", "field_key");
CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_workflow_idx"
  ON "evidence_workflow_visibility_decisions" ("workflow_instance_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_evidence_idx"
  ON "evidence_workflow_visibility_decisions" ("evidence_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_visibility_decisions_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_visibility_decisions"
      ADD CONSTRAINT "evidence_workflow_visibility_decisions_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_visibility_decisions_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_visibility_decisions"
      ADD CONSTRAINT "evidence_workflow_visibility_decisions_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- =============================================================================
-- BLOCK E — Phase 25 Reviewer Operations Intelligence + SLA Engine
--   Migration: 20260601100000_add_reviewer_operations_phase25
--   Maps to user-reported "reviewer_queue_snapshots".
--   Creates: review_escalations + reviewer_workload_snapshots,
--   plus additive columns on evidence_review_workflows.
-- =============================================================================

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "assignment_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completion_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "paused_reason"         VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "active_escalation_id"  UUID;

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_assignment_due_at_utc_idx"
  ON "evidence_review_workflows" ("assignment_due_at_utc");
CREATE INDEX IF NOT EXISTS "evidence_review_workflows_completion_due_at_utc_idx"
  ON "evidence_review_workflows" ("completion_due_at_utc");

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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_team_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_workflow_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_workflow_id_fkey"
      FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_created_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_assigned_to_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_assigned_to_user_id_fkey"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_acknowledged_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_acknowledged_by_user_id_fkey"
      FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_resolved_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_resolved_by_user_id_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

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
  ON "reviewer_workload_snapshots" ("team_id", "reviewer_user_id", "computed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_computed_idx"
  ON "reviewer_workload_snapshots" ("team_id", "computed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_capacity_idx"
  ON "reviewer_workload_snapshots" ("team_id", "capacity_score");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_team_id_fkey') THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_reviewer_user_id_fkey') THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_reviewer_user_id_fkey"
      FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END$$;

-- =============================================================================
-- BLOCK F — Phase 2026-05-08 Evidence Operations Workspace Features
--   Migration: 20260508133000_add_evidence_operations_workspace_features
--   Maps to user-reported "evidence_ai_categorizations" + 3 siblings.
--   Same content as the prior 2026-05-08 patch — included here so this
--   single file fixes the entire reported drift in one transaction.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceCommentVisibility') THEN
    CREATE TYPE "EvidenceCommentVisibility" AS ENUM ('INTERNAL', 'TEAM');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceLegalNoteType') THEN
    CREATE TYPE "EvidenceLegalNoteType" AS ENUM ('GENERAL', 'PRIVILEGED', 'DISCLOSURE', 'REVIEW_BOUNDARY', 'HANDOFF');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationType') THEN
    CREATE TYPE "EvidenceAnnotationType" AS ENUM ('POINT', 'BOX', 'REGION', 'TIMESTAMP', 'TEXT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationCoordinateSpace') THEN
    CREATE TYPE "EvidenceAnnotationCoordinateSpace" AS ENUM ('NORMALIZED', 'PIXEL', 'TIME_ONLY', 'DOCUMENT_PAGE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAiCategorizationStatus') THEN
    CREATE TYPE "EvidenceAiCategorizationStatus" AS ENUM ('DISABLED', 'PENDING', 'COMPLETED', 'FAILED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "evidence_saved_views" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "team_id"       UUID,
  "name"          VARCHAR(120) NOT NULL,
  "description"   VARCHAR(400),
  "filters_json"  JSONB NOT NULL,
  "sort_key"      VARCHAR(64),
  "scope"         VARCHAR(32)  NOT NULL,
  "is_default"    BOOLEAN NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_saved_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_reviewer_comments" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "visibility"     "EvidenceCommentVisibility" NOT NULL DEFAULT 'INTERNAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_reviewer_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_legal_notes" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "note_type"      "EvidenceLegalNoteType" NOT NULL DEFAULT 'GENERAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_legal_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_annotations" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"        UUID NOT NULL,
  "evidence_part_id"   UUID,
  "author_user_id"     UUID NOT NULL,
  "annotation_type"    "EvidenceAnnotationType" NOT NULL,
  "body"               TEXT,
  "page_number"        INTEGER,
  "media_timestamp_ms" INTEGER,
  "x"                  DOUBLE PRECISION,
  "y"                  DOUBLE PRECISION,
  "width"              DOUBLE PRECISION,
  "height"             DOUBLE PRECISION,
  "coordinate_space"   "EvidenceAnnotationCoordinateSpace" NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"         TIMESTAMPTZ(6),
  CONSTRAINT "evidence_annotations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_ai_categorizations" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"           UUID NOT NULL,
  "requested_by_user_id"  UUID NOT NULL,
  "status"                "EvidenceAiCategorizationStatus" NOT NULL DEFAULT 'PENDING',
  "categories_json"       JSONB,
  "suggested_tags_json"   JSONB,
  "risk_flags_json"       JSONB,
  "summary"               TEXT,
  "legal_disclaimer"      TEXT NOT NULL,
  "model"                 VARCHAR(120),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_ai_categorizations_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_saved_views_owner_user_id_fkey') THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_saved_views_team_id_fkey') THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_reviewer_comments_evidence_id_fkey') THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_reviewer_comments_author_user_id_fkey') THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_notes_evidence_id_fkey') THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_notes_author_user_id_fkey') THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_evidence_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evidence_parts')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_evidence_part_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_part_id_fkey"
      FOREIGN KEY ("evidence_part_id") REFERENCES "evidence_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_author_user_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_ai_categorizations_evidence_id_fkey') THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_ai_categorizations_requested_by_user_id_fkey') THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_requested_by_user_id_fkey"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_created_at_idx"
  ON "evidence_saved_views" ("owner_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_saved_views_team_id_created_at_idx"
  ON "evidence_saved_views" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_is_default_idx"
  ON "evidence_saved_views" ("owner_user_id", "is_default");

CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_evidence_id_created_at_idx"
  ON "evidence_reviewer_comments" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_author_user_id_idx"
  ON "evidence_reviewer_comments" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_deleted_at_idx"
  ON "evidence_reviewer_comments" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_legal_notes_evidence_id_created_at_idx"
  ON "evidence_legal_notes" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_legal_notes_author_user_id_idx"
  ON "evidence_legal_notes" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_legal_notes_deleted_at_idx"
  ON "evidence_legal_notes" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_id_created_at_idx"
  ON "evidence_annotations" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_part_id_idx"
  ON "evidence_annotations" ("evidence_part_id");
CREATE INDEX IF NOT EXISTS "evidence_annotations_author_user_id_idx"
  ON "evidence_annotations" ("author_user_id");
CREATE INDEX IF NOT EXISTS "evidence_annotations_deleted_at_idx"
  ON "evidence_annotations" ("deleted_at");

CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_evidence_id_created_at_idx"
  ON "evidence_ai_categorizations" ("evidence_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_requested_by_user_id_created_at_idx"
  ON "evidence_ai_categorizations" ("requested_by_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_status_idx"
  ON "evidence_ai_categorizations" ("status");

COMMIT;

-- =============================================================================
-- POST-APPLY VERIFICATION
-- =============================================================================
--
-- 1. Confirm every target table exists.
--
--    SELECT
--      to_regclass('public.workspace_governance_policies') AS workspace_governance_policies,
--      to_regclass('public.evidence_legal_holds')          AS evidence_legal_holds,
--      to_regclass('public.api_credentials')               AS api_credentials,
--      to_regclass('public.integration_webhook_endpoints') AS integration_webhook_endpoints,
--      to_regclass('public.integration_webhook_deliveries')AS integration_webhook_deliveries,
--      to_regclass('public.evidence_workflow_templates')   AS evidence_workflow_templates,
--      to_regclass('public.evidence_workflow_instances')   AS evidence_workflow_instances,
--      to_regclass('public.evidence_workflow_instance_evidence') AS evidence_workflow_instance_evidence,
--      to_regclass('public.evidence_workflow_step_instances')    AS evidence_workflow_step_instances,
--      to_regclass('public.evidence_workflow_visibility_decisions') AS evidence_workflow_visibility_decisions,
--      to_regclass('public.review_escalations')            AS review_escalations,
--      to_regclass('public.reviewer_workload_snapshots')   AS reviewer_workload_snapshots,
--      to_regclass('public.evidence_saved_views')          AS evidence_saved_views,
--      to_regclass('public.evidence_reviewer_comments')    AS evidence_reviewer_comments,
--      to_regclass('public.evidence_legal_notes')          AS evidence_legal_notes,
--      to_regclass('public.evidence_annotations')          AS evidence_annotations,
--      to_regclass('public.evidence_ai_categorizations')   AS evidence_ai_categorizations;
--    Every column must be non-NULL.
--
-- 2. Confirm every target enum type exists.
--
--    SELECT typname
--    FROM pg_type
--    WHERE typname IN (
--      'EvidenceDeletionMode', 'LegalHoldStatus',
--      'ApiCredentialStatus', 'WebhookEndpointStatus', 'WebhookDeliveryStatus',
--      'WorkspaceCategory',
--      'EvidenceCommentVisibility', 'EvidenceLegalNoteType',
--      'EvidenceAnnotationType', 'EvidenceAnnotationCoordinateSpace',
--      'EvidenceAiCategorizationStatus'
--    )
--    ORDER BY typname;
--    Expected: 11 rows.
--
-- 3. Confirm the additive columns landed on existing tables.
--
--    SELECT column_name
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name = 'workspace_governance_policies'
--      AND column_name = 'allow_original_download';
--
--    SELECT column_name
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name = 'evidence_workflow_templates'
--      AND column_name = 'status';
--
--    SELECT column_name
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name = 'evidence_review_workflows'
--      AND column_name IN (
--        'assignment_due_at_utc', 'completion_due_at_utc',
--        'paused_reason', 'active_escalation_id'
--      );
--    Expected: 4 rows.
--
-- 4. Confirm every target foreign-key constraint exists.
--
--    SELECT conname
--    FROM pg_constraint
--    WHERE conname IN (
--      'workspace_governance_policies_team_fkey',
--      'workspace_governance_policies_updated_by_user_fkey',
--      'evidence_legal_holds_team_fkey',
--      'evidence_legal_holds_evidence_fkey',
--      'evidence_legal_holds_placed_by_user_fkey',
--      'evidence_legal_holds_released_by_user_fkey',
--      'api_credentials_team_fkey',
--      'api_credentials_created_by_fkey',
--      'api_credentials_revoked_by_fkey',
--      'integration_webhook_endpoints_team_fkey',
--      'integration_webhook_endpoints_created_by_fkey',
--      'integration_webhook_deliveries_endpoint_fkey',
--      'evidence_workflow_templates_team_id_fkey',
--      'evidence_workflow_templates_created_by_user_id_fkey',
--      'evidence_workflow_templates_updated_by_user_id_fkey',
--      'evidence_workflow_instances_team_id_fkey',
--      'evidence_workflow_instances_template_id_fkey',
--      'evidence_workflow_instances_created_by_user_id_fkey',
--      'evidence_workflow_instances_assigned_reviewer_user_id_fkey',
--      'evidence_workflow_instance_evidence_workflow_id_fkey',
--      'evidence_workflow_instance_evidence_evidence_id_fkey',
--      'evidence_workflow_step_instances_workflow_id_fkey',
--      'evidence_workflow_step_instances_completed_by_user_id_fkey',
--      'evidence_workflow_step_instances_mapped_evidence_id_fkey',
--      'evidence_workflow_visibility_decisions_workflow_id_fkey',
--      'evidence_workflow_visibility_decisions_evidence_id_fkey',
--      'review_escalations_team_id_fkey',
--      'review_escalations_workflow_id_fkey',
--      'review_escalations_created_by_user_id_fkey',
--      'review_escalations_assigned_to_user_id_fkey',
--      'review_escalations_acknowledged_by_user_id_fkey',
--      'review_escalations_resolved_by_user_id_fkey',
--      'reviewer_workload_snapshots_team_id_fkey',
--      'reviewer_workload_snapshots_reviewer_user_id_fkey',
--      'evidence_saved_views_owner_user_id_fkey',
--      'evidence_saved_views_team_id_fkey',
--      'evidence_reviewer_comments_evidence_id_fkey',
--      'evidence_reviewer_comments_author_user_id_fkey',
--      'evidence_legal_notes_evidence_id_fkey',
--      'evidence_legal_notes_author_user_id_fkey',
--      'evidence_annotations_evidence_id_fkey',
--      'evidence_annotations_author_user_id_fkey',
--      'evidence_ai_categorizations_evidence_id_fkey',
--      'evidence_ai_categorizations_requested_by_user_id_fkey'
--    )
--    ORDER BY conname;
--    Expected: 43 rows (44 if evidence_parts exists for the optional annotations FK).
--
-- 5. Confirm critical indexes landed.
--
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname IN (
--        'workspace_governance_policies_team_id_key',
--        'api_credentials_key_hash_key',
--        'evidence_workflow_templates_team_slug_unique',
--        'evidence_workflow_templates_global_slug_unique',
--        'evidence_workflow_instance_evidence_uk',
--        'evidence_workflow_step_instances_workflow_step_uk',
--        'evidence_workflow_visibility_decisions_uk',
--        'review_escalations_team_fingerprint_uk'
--      )
--    ORDER BY indexname;
--    Expected: 8 rows.
--
-- =============================================================================
-- BROADER DRIFT QUERY — uses ACTUAL Prisma @@map values
-- Re-run this after applying the patch to catch any remaining drift.
-- The previous user-supplied drift query used 5 names that don't match
-- Prisma; this corrected version pulls expected names from the schema.
-- =============================================================================
--
-- WITH expected(name) AS (VALUES
--   ('evidence'), ('evidence_anchors'), ('evidence_parts'),
--   ('cases'), ('custody_events'), ('reports'),
--   ('evidence_certifications'), ('verification_packages'),
--   ('verification_views'), ('signing_keys'),
--   ('users'), ('teams'),
--   ('evidence_saved_views'), ('evidence_reviewer_comments'),
--   ('evidence_legal_notes'), ('evidence_annotations'),
--   ('evidence_ai_categorizations'), ('evidence_review_workflows'),
--   ('evidence_review_workflow_events'), ('evidence_relationships'),
--   ('evidence_reviewer_audit_events'),
--   ('capture_sessions'), ('capture_session_events'),
--   ('workspace_storage_addons'),
--   ('team_members'), ('case_access'),
--   ('team_invites'), ('team_activities'),
--   ('guest_identities'), ('entitlements'),
--   ('subscriptions'), ('payments'),
--   ('audit_logs'), ('webhooks'), ('webhook_events'),
--   ('password_reset_tokens'),
--   ('admin_audit_logs'), ('user_legal_acceptances'),
--   ('cookie_consent_records'), ('demo_requests'),
--   ('evidence_workflow_templates'),
--   ('workflow_intake_links'), ('workflow_intake_sessions'),
--   ('evidence_requests'), ('evidence_request_deliverables'),
--   ('evidence_request_responses'), ('evidence_request_events'),
--   ('notification_deliveries'),
--   ('workspace_governance_policies'), ('evidence_legal_holds'),
--   ('api_credentials'), ('api_credential_usage_logs'),
--   ('integration_webhook_endpoints'), ('integration_webhook_deliveries'),
--   ('file_security_scans'), ('security_events'),
--   ('upload_sessions'), ('case_legal_holds'),
--   ('evidence_intelligence_jobs'), ('evidence_extracted_texts'),
--   ('evidence_entities'), ('evidence_semantic_chunks'),
--   ('evidence_similarities'),
--   ('discussion_threads'), ('discussion_messages'),
--   ('discussion_mentions'), ('discussion_participants'),
--   ('member_capability_grants'),
--   ('member_delegated_admin_scopes'),
--   ('organization_security_policies'),
--   ('access_reviews'), ('external_identity_mappings'),
--   ('communication_messages'), ('communication_preferences'),
--   ('verification_attempts'), ('step_up_challenges'),
--   ('trusted_devices'), ('revoked_sessions'),
--   ('risk_signals'),
--   ('operational_incidents'), ('operational_incident_events'),
--   ('evidence_workflow_instances'), ('evidence_workflow_instance_evidence'),
--   ('evidence_workflow_step_instances'),
--   ('evidence_workflow_visibility_decisions'),
--   ('evidence_search_documents'), ('saved_search_views'),
--   ('review_escalations'), ('reviewer_workload_snapshots'),
--   ('reviewer_ops_reminders'),
--   ('sso_connections'), ('scim_provisioning_tokens'),
--   ('authenticated_sessions'), ('sso_callback_attempts'),
--   ('scim_groups'), ('geo_intelligence_lookups'),
--   ('evidence_retention_policies'),
--   ('evidence_retention_policy_versions'),
--   ('destruction_reviews'), ('evidence_lifecycle_events'),
--   ('governance_reconciliation_runs'),
--   ('destruction_executions'), ('immutable_storage_checks'),
--   ('governance_notifications'), ('governance_export_snapshots')
-- )
-- SELECT e.name AS missing_table
-- FROM expected e
-- WHERE to_regclass('public.' || e.name) IS NULL
-- ORDER BY 1;
--
-- =============================================================================
-- POST-APPLY: tell Prisma which migrations are now resolved
-- =============================================================================
--
-- Run from the api workspace AFTER the SQL above runs cleanly. Each
-- "migrate resolve --applied" tells Prisma the migration has been
-- manually applied so future `prisma migrate deploy` will not retry.
-- Use the EXACT directory names from prisma/migrations/.
--
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260516120000_add_workflow_template_foundation
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260517100000_add_governance_phase9
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260517140000_add_integrations_phase10
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260508133000_add_evidence_operations_workspace_features
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260530100000_add_workflow_engine_phase22
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260601100000_add_reviewer_operations_phase25
--
-- After all six are resolved:
--
--   pnpm --dir services/api exec prisma migrate status
--
-- — should print "Database schema is up to date!" OR list further
-- migrations that still need to be reconciled. Run the broader drift
-- query above to see if any other Prisma @@map tables are missing.
-- =============================================================================
