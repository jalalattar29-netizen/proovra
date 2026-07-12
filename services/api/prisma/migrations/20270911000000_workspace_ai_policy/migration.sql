-- Phase A2 — Workspace-level AI governance policy (ADDITIVE, no backfill).
--
-- Adds `workspace_ai_policies` with ZERO rows. The canonical evaluator
-- (evaluateWorkspaceAiPolicy) falls back to a safe code-level default when
-- a team has no row, so existing runtime behaviour is UNCHANGED by this
-- migration. No destructive change, no column drop, no data migration.
-- Rollback: DROP TABLE "workspace_ai_policies" (safe — no readers depend on
-- rows existing; the evaluator's code default covers the empty-table case).

CREATE TABLE "workspace_ai_policies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
  "support_chat_enabled" BOOLEAN NOT NULL DEFAULT true,
  "capture_assistance_enabled" BOOLEAN NOT NULL DEFAULT true,
  "evidence_categorization_enabled" BOOLEAN NOT NULL DEFAULT true,
  "semantic_search_enabled" BOOLEAN NOT NULL DEFAULT false,
  "content_intelligence_enabled" BOOLEAN NOT NULL DEFAULT false,
  "reviewer_copilot_enabled" BOOLEAN NOT NULL DEFAULT false,
  "case_copilot_enabled" BOOLEAN NOT NULL DEFAULT false,
  "raw_content_processing_allowed" BOOLEAN NOT NULL DEFAULT false,
  "ocr_allowed" BOOLEAN NOT NULL DEFAULT false,
  "transcription_allowed" BOOLEAN NOT NULL DEFAULT false,
  "embeddings_allowed" BOOLEAN NOT NULL DEFAULT false,
  "allowed_roles_json" JSONB,
  "daily_operation_limit" INTEGER,
  "monthly_operation_limit" INTEGER,
  "daily_cost_limit_usd_micros" BIGINT,
  "monthly_cost_limit_usd_micros" BIGINT,
  "retention_days" INTEGER,
  "policy_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "workspace_ai_policies_team_id_key" ON "workspace_ai_policies"("team_id");
CREATE INDEX "workspace_ai_policies_team_id_idx" ON "workspace_ai_policies"("team_id");

ALTER TABLE "workspace_ai_policies"
  ADD CONSTRAINT "workspace_ai_policies_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
