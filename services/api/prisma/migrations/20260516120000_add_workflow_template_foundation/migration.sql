-- Phase 2 Workflow Engine: foundation
--
-- Adds WorkspaceCategory enum, Team.workspace_category column, and the
-- evidence_workflow_templates table.
--
-- Forward-only, additive migration:
--   * One new enum (WorkspaceCategory).
--   * One new nullable column on the existing teams table.
--   * One new table (evidence_workflow_templates).
--   * No existing rows are modified, no destructive operations, no
--     required backfill.
--   * No existing route or service reads these new objects until Phase 3.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS evidence_workflow_templates;
--   ALTER TABLE teams DROP COLUMN IF EXISTS workspace_category;
--   DROP TYPE IF EXISTS "WorkspaceCategory";
--
-- Production deploy command:
--   pnpm --filter proovra-api prisma migrate deploy

-- 1. WorkspaceCategory enum -------------------------------------------------

CREATE TYPE "WorkspaceCategory" AS ENUM (
  'GENERAL',
  'INSURANCE',
  'LEGAL',
  'JOURNALISM',
  'INVESTIGATIONS',
  'COMPLIANCE',
  'FIELD_OPERATIONS',
  'RESEARCH',
  'OTHER'
);

-- 2. Team.workspace_category column ----------------------------------------
-- Nullable. NULL is interpreted by application code as "GENERAL" — see
-- services/api/src/services/workflow-template.service.ts.

ALTER TABLE "teams"
ADD COLUMN "workspace_category" "WorkspaceCategory";

CREATE INDEX "teams_workspace_category_idx"
  ON "teams" ("workspace_category");

-- 3. evidence_workflow_templates table -------------------------------------

CREATE TABLE "evidence_workflow_templates" (
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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_workflow_templates_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_workflow_templates_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "evidence_workflow_templates_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "evidence_workflow_templates_team_id_archived_idx"
  ON "evidence_workflow_templates" ("team_id", "archived");
CREATE INDEX "evidence_workflow_templates_team_id_workspace_category_idx"
  ON "evidence_workflow_templates" ("team_id", "workspace_category");
CREATE INDEX "evidence_workflow_templates_slug_idx"
  ON "evidence_workflow_templates" ("slug");
CREATE INDEX "evidence_workflow_templates_workspace_category_idx"
  ON "evidence_workflow_templates" ("workspace_category");

-- Partial unique indexes for slug scope:
--   - Within a workspace, slug is unique (so PATCH/upsert by slug is safe).
--   - Globally (team_id IS NULL), slug is unique (one platform override row
--     per seed slug).
-- These are partial because Postgres treats NULL as distinct in plain
-- unique constraints, which would otherwise allow duplicate global rows.

CREATE UNIQUE INDEX "evidence_workflow_templates_team_slug_unique"
  ON "evidence_workflow_templates" ("team_id", "slug")
  WHERE "team_id" IS NOT NULL;

CREATE UNIQUE INDEX "evidence_workflow_templates_global_slug_unique"
  ON "evidence_workflow_templates" ("slug")
  WHERE "team_id" IS NULL;
