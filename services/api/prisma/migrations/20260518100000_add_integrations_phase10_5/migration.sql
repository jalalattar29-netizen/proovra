-- Phase 10.5 — Integration production hardening
--
-- Forward-only additive migration:
--   * One new table (api_credential_usage_logs) for per-call audit trail
--     of service-account API key usage. NEVER contains raw key bytes,
--     the Authorization header, request body, or evidence-internal data.
--   * No existing rows modified, no existing columns altered.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS api_credential_usage_logs;

CREATE TABLE "api_credential_usage_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_credential_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "route_path" VARCHAR(256) NOT NULL,
  "method" VARCHAR(16) NOT NULL,
  "action" VARCHAR(96) NOT NULL,
  "status_code" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "failure_reason" VARCHAR(96),
  "request_id" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "api_credential_usage_logs_credential_fkey"
    FOREIGN KEY ("api_credential_id") REFERENCES "api_credentials" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "api_credential_usage_logs_credential_created_idx"
  ON "api_credential_usage_logs" ("api_credential_id", "created_at" DESC);
CREATE INDEX "api_credential_usage_logs_team_created_idx"
  ON "api_credential_usage_logs" ("team_id", "created_at" DESC);
CREATE INDEX "api_credential_usage_logs_created_idx"
  ON "api_credential_usage_logs" ("created_at" DESC);
