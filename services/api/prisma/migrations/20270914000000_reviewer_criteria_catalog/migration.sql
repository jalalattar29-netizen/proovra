-- Phase P6 — Reviewer Criteria Catalog (ADDITIVE, zero rows).
-- Rollback: DROP TABLE "reviewer_criteria"; DROP TABLE "reviewer_criteria_versions"; DROP TABLE "reviewer_criteria_sets".

CREATE TABLE "reviewer_criteria_sets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "case_id" UUID,
  "name" VARCHAR(160) NOT NULL,
  "description" VARCHAR(600),
  "status" VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  "current_version_id" UUID,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "reviewer_criteria_sets_workspace_id_status_idx" ON "reviewer_criteria_sets"("workspace_id", "status");

CREATE TABLE "reviewer_criteria_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "criteria_set_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "instructions" VARCHAR(2000),
  "created_by_user_id" UUID NOT NULL,
  "published_by_user_id" UUID,
  "published_at" TIMESTAMPTZ(6),
  "retired_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "reviewer_criteria_versions_set_version_key" ON "reviewer_criteria_versions"("criteria_set_id", "version");
ALTER TABLE "reviewer_criteria_versions"
  ADD CONSTRAINT "reviewer_criteria_versions_criteria_set_id_fkey"
  FOREIGN KEY ("criteria_set_id") REFERENCES "reviewer_criteria_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reviewer_criteria" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "criteria_version_id" UUID NOT NULL,
  "key" VARCHAR(60) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(600),
  "required" BOOLEAN NOT NULL DEFAULT false,
  "order" INTEGER NOT NULL DEFAULT 0,
  "review_guidance" VARCHAR(600),
  "escalation_guidance" VARCHAR(600)
);
CREATE UNIQUE INDEX "reviewer_criteria_version_key_key" ON "reviewer_criteria"("criteria_version_id", "key");
ALTER TABLE "reviewer_criteria"
  ADD CONSTRAINT "reviewer_criteria_criteria_version_id_fkey"
  FOREIGN KEY ("criteria_version_id") REFERENCES "reviewer_criteria_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
