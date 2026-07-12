-- Phase D4 — Copilot run defensibility records (ADDITIVE, zero rows).
-- Advisory work-product only; no behaviour change until the routes write rows.
-- Rollback: DROP TABLE "ai_copilot_observation_reviews"; DROP TABLE "ai_copilot_runs".

CREATE TABLE "ai_copilot_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "feature" VARCHAR(40) NOT NULL,
  "case_id" UUID,
  "review_id" UUID,
  "request_id" VARCHAR(120) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  "prompt_version" VARCHAR(40) NOT NULL,
  "system_policy_version" VARCHAR(40) NOT NULL,
  "product_knowledge_version" VARCHAR(40) NOT NULL,
  "context_schema_version" VARCHAR(40) NOT NULL,
  "output_schema_version" VARCHAR(40) NOT NULL,
  "workspace_policy_version" INTEGER NOT NULL,
  "criteria_version" VARCHAR(40),
  "processing_mode" VARCHAR(40) NOT NULL,
  "selected_object_versions_json" JSONB NOT NULL,
  "bounded_result_json" JSONB,
  "validated_citations_json" JSONB,
  "status" VARCHAR(40) NOT NULL,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "ai_copilot_runs_request_id_key" ON "ai_copilot_runs"("request_id");
CREATE INDEX "ai_copilot_runs_workspace_id_generated_at_idx" ON "ai_copilot_runs"("workspace_id", "generated_at" DESC);
CREATE INDEX "ai_copilot_runs_review_id_idx" ON "ai_copilot_runs"("review_id");
CREATE INDEX "ai_copilot_runs_case_id_idx" ON "ai_copilot_runs"("case_id");
CREATE INDEX "ai_copilot_runs_workspace_id_status_idx" ON "ai_copilot_runs"("workspace_id", "status");

CREATE TABLE "ai_copilot_observation_reviews" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "copilot_run_id" UUID NOT NULL,
  "observation_id" VARCHAR(80) NOT NULL,
  "state" VARCHAR(20) NOT NULL,
  "original_text_hash" VARCHAR(64) NOT NULL,
  "edited_text" VARCHAR(600),
  "actor_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "ai_copilot_observation_reviews_run_obs_actor_key"
  ON "ai_copilot_observation_reviews"("copilot_run_id", "observation_id", "actor_id");
CREATE INDEX "ai_copilot_observation_reviews_copilot_run_id_idx"
  ON "ai_copilot_observation_reviews"("copilot_run_id");

ALTER TABLE "ai_copilot_observation_reviews"
  ADD CONSTRAINT "ai_copilot_observation_reviews_copilot_run_id_fkey"
  FOREIGN KEY ("copilot_run_id") REFERENCES "ai_copilot_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
