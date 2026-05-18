-- Phase 22 — Evidence Workflow Engine (runtime instance + step + visibility)
--
-- Forward-only additive migration:
--   * 1 additive column on evidence_workflow_templates
--     (`status` VARCHAR(16), default 'ACTIVE').
--   * 4 new tables (evidence_workflow_instances,
--     evidence_workflow_instance_evidence,
--     evidence_workflow_step_instances,
--     evidence_workflow_visibility_decisions).
--   * No existing column altered; no row mutated; no enum changed.
--
-- All Phase 22 rows are WORKSPACE-INTERNAL by design. Public verify,
-- OTS/TSA/anchor, report-v2, and verification package paths NEVER
-- read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS evidence_workflow_visibility_decisions;
--   DROP TABLE IF EXISTS evidence_workflow_step_instances;
--   DROP TABLE IF EXISTS evidence_workflow_instance_evidence;
--   DROP TABLE IF EXISTS evidence_workflow_instances;
--   ALTER TABLE evidence_workflow_templates DROP COLUMN IF EXISTS status;

-- 1. Template status column ----------------------------------------------

ALTER TABLE "evidence_workflow_templates"
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_status_idx"
  ON "evidence_workflow_templates" ("team_id", "status");

-- 2. evidence_workflow_instances ----------------------------------------

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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_workflow_instances_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "evidence_workflow_instances_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "evidence_workflow_templates"("id") ON DELETE SET NULL,
  CONSTRAINT "evidence_workflow_instances_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "evidence_workflow_instances_assigned_reviewer_user_id_fkey"
    FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "evidence_workflow_instances_evidence_request_id_fkey"
    FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests"("id") ON DELETE SET NULL,
  CONSTRAINT "evidence_workflow_instances_intake_session_id_fkey"
    FOREIGN KEY ("intake_session_id") REFERENCES "workflow_intake_sessions"("id") ON DELETE SET NULL
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

-- 3. evidence_workflow_instance_evidence (M2M join) ---------------------

CREATE TABLE IF NOT EXISTS "evidence_workflow_instance_evidence" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "step_instance_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_workflow_instance_evidence_workflow_id_fkey"
    FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE,
  CONSTRAINT "evidence_workflow_instance_evidence_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_uk"
  ON "evidence_workflow_instance_evidence" ("workflow_instance_id", "evidence_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_evidence_id_idx"
  ON "evidence_workflow_instance_evidence" ("evidence_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_step_instance_id_idx"
  ON "evidence_workflow_instance_evidence" ("step_instance_id");

-- 4. evidence_workflow_step_instances -----------------------------------

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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_workflow_step_instances_workflow_id_fkey"
    FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE,
  CONSTRAINT "evidence_workflow_step_instances_completed_by_user_id_fkey"
    FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "evidence_workflow_step_instances_mapped_evidence_id_fkey"
    FOREIGN KEY ("mapped_evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_step_uk"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "step_key");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_status_idx"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "status");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_order_idx"
  ON "evidence_workflow_step_instances" ("workflow_instance_id", "order_index");
CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_mapped_evidence_id_idx"
  ON "evidence_workflow_step_instances" ("mapped_evidence_id");

-- 5. evidence_workflow_visibility_decisions -----------------------------

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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "evidence_workflow_visibility_decisions_workflow_id_fkey"
    FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE,
  CONSTRAINT "evidence_workflow_visibility_decisions_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_uk"
  ON "evidence_workflow_visibility_decisions" ("workflow_instance_id", "evidence_id", "field_key");
CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_workflow_idx"
  ON "evidence_workflow_visibility_decisions" ("workflow_instance_id");
CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_evidence_idx"
  ON "evidence_workflow_visibility_decisions" ("evidence_id");
