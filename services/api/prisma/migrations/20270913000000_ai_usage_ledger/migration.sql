-- Phase A7 — Durable AI usage ledger (ADDITIVE, zero rows).
-- Rollback: DROP TABLE "ai_usage_events"; DROP TABLE "ai_usage_daily"; DROP TABLE "ai_usage_monthly".

CREATE TABLE "ai_usage_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "feature" VARCHAR(40) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(80) NOT NULL,
  "request_id" VARCHAR(120) NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "estimated_cost_usd_micros" BIGINT NOT NULL,
  "actual_cost_usd_micros" BIGINT,
  "status" VARCHAR(20) NOT NULL,
  "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6)
);
CREATE UNIQUE INDEX "ai_usage_events_request_id_key" ON "ai_usage_events"("request_id");
CREATE INDEX "ai_usage_events_workspace_id_reserved_at_idx" ON "ai_usage_events"("workspace_id", "reserved_at" DESC);
CREATE INDEX "ai_usage_events_workspace_id_feature_idx" ON "ai_usage_events"("workspace_id", "feature");

CREATE TABLE "ai_usage_daily" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "day_utc" VARCHAR(10) NOT NULL,
  "operations" INTEGER NOT NULL DEFAULT 0,
  "cost_usd_micros" BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "ai_usage_daily_workspace_id_day_utc_key" ON "ai_usage_daily"("workspace_id", "day_utc");

CREATE TABLE "ai_usage_monthly" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "month_utc" VARCHAR(7) NOT NULL,
  "operations" INTEGER NOT NULL DEFAULT 0,
  "cost_usd_micros" BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "ai_usage_monthly_workspace_id_month_utc_key" ON "ai_usage_monthly"("workspace_id", "month_utc");
