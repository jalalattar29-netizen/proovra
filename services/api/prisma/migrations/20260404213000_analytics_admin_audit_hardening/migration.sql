-- Analytics hardening: enrich AnalyticsEvent / AnalyticsSession
ALTER TABLE "AnalyticsEvent"
  ADD COLUMN IF NOT EXISTS "country_code" VARCHAR(8),
  ADD COLUMN IF NOT EXISTS "city_normalized" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "route_type" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "event_class" VARCHAR(48),
  ADD COLUMN IF NOT EXISTS "display_label" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "entity_type" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "entity_id" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "severity" VARCHAR(16);

ALTER TABLE "AnalyticsSession"
  ADD COLUMN IF NOT EXISTS "country_code" VARCHAR(8),
  ADD COLUMN IF NOT EXISTS "city_normalized" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "route_type" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "landing_path" VARCHAR(512);

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_route_type_createdAt_idx"
  ON "AnalyticsEvent"("route_type", "createdAt");

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_country_code_createdAt_idx"
  ON "AnalyticsEvent"("country_code", "createdAt");

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_city_normalized_createdAt_idx"
  ON "AnalyticsEvent"("city_normalized", "createdAt");

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_path_createdAt_idx"
  ON "AnalyticsEvent"("path", "createdAt");

CREATE INDEX IF NOT EXISTS "AnalyticsSession_route_type_startedAt_idx"
  ON "AnalyticsSession"("route_type", "startedAt");

-- Admin audit hardening: enrich admin_audit_logs
ALTER TABLE "admin_audit_logs"
  ADD COLUMN IF NOT EXISTS "category" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "severity" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "source" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "outcome" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "resource_type" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "resource_id" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "request_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "chain_version" INTEGER NOT NULL DEFAULT 2;

-- Upgrade legacy rows that don't yet carry chain_version
UPDATE "admin_audit_logs"
SET "chain_version" = 1
WHERE "chain_version" IS NULL;

CREATE INDEX IF NOT EXISTS "admin_audit_logs_category_created_at_idx"
  ON "admin_audit_logs"("category", "created_at");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_severity_created_at_idx"
  ON "admin_audit_logs"("severity", "created_at");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_request_id_idx"
  ON "admin_audit_logs"("request_id");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_resource_type_resource_id_idx"
  ON "admin_audit_logs"("resource_type", "resource_id");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_hash_idx"
  ON "admin_audit_logs"("hash");

CREATE INDEX IF NOT EXISTS "admin_audit_logs_prev_hash_idx"
  ON "admin_audit_logs"("prev_hash");

-- Ensure future writes default to v2
ALTER TABLE "admin_audit_logs"
  ALTER COLUMN "chain_version" SET DEFAULT 2;