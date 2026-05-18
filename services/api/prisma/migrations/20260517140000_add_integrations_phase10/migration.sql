-- Phase 10 Integration platform foundation + governance hardening
--
-- Forward-only additive migration:
--   * One new column on workspace_governance_policies (allow_original_download).
--   * Three new enums (ApiCredentialStatus, WebhookEndpointStatus,
--     WebhookDeliveryStatus).
--   * Three new tables (api_credentials, integration_webhook_endpoints,
--     integration_webhook_deliveries).
--   * No existing rows modified.
--
-- Default behavior preserved: allow_original_download defaults to true so
-- existing workspaces continue to allow original-file downloads.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS integration_webhook_deliveries;
--   DROP TABLE IF EXISTS integration_webhook_endpoints;
--   DROP TABLE IF EXISTS api_credentials;
--   DROP TYPE IF EXISTS "WebhookDeliveryStatus";
--   DROP TYPE IF EXISTS "WebhookEndpointStatus";
--   DROP TYPE IF EXISTS "ApiCredentialStatus";
--   ALTER TABLE workspace_governance_policies DROP COLUMN IF EXISTS allow_original_download;

-- 1. Governance hardening: download-original gate -------------------------

ALTER TABLE "workspace_governance_policies"
ADD COLUMN "allow_original_download" BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Enums ----------------------------------------------------------------

CREATE TYPE "ApiCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM (
  'PENDING',
  'SENT',
  'FAILED',
  'RETRY_SCHEDULED',
  'CANCELLED'
);

-- 3. api_credentials ------------------------------------------------------

CREATE TABLE "api_credentials" (
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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "api_credentials_team_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "api_credentials_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "api_credentials_revoked_by_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "api_credentials_key_hash_key"
  ON "api_credentials" ("key_hash");
CREATE INDEX "api_credentials_team_status_idx"
  ON "api_credentials" ("team_id", "status");
CREATE INDEX "api_credentials_team_created_idx"
  ON "api_credentials" ("team_id", "created_at" DESC);

-- 4. integration_webhook_endpoints ----------------------------------------

CREATE TABLE "integration_webhook_endpoints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "description" VARCHAR(400),
  "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
  -- AES-256-GCM ciphertext of the raw signing secret, wrapped by
  -- API_KEY_SECRET. Format: base64(iv || ciphertext || authTag).
  -- The raw signing secret is shown to the operator exactly once on
  -- create / rotate; at signing time the dispatcher decrypts this
  -- column and signs with the raw value.
  "secret_ciphertext" VARCHAR(512) NOT NULL,
  "secret_prefix" VARCHAR(32) NOT NULL,
  "event_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_success_at_utc" TIMESTAMPTZ(6),
  "last_failure_at_utc" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "integration_webhook_endpoints_team_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "integration_webhook_endpoints_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "integration_webhook_endpoints_team_status_idx"
  ON "integration_webhook_endpoints" ("team_id", "status");

-- 5. integration_webhook_deliveries ---------------------------------------

CREATE TABLE "integration_webhook_deliveries" (
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
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "integration_webhook_deliveries_endpoint_fkey"
    FOREIGN KEY ("endpoint_id") REFERENCES "integration_webhook_endpoints" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "integration_webhook_deliveries_endpoint_created_idx"
  ON "integration_webhook_deliveries" ("endpoint_id", "created_at" DESC);
CREATE INDEX "integration_webhook_deliveries_team_created_idx"
  ON "integration_webhook_deliveries" ("team_id", "created_at" DESC);
CREATE INDEX "integration_webhook_deliveries_status_idx"
  ON "integration_webhook_deliveries" ("status");
CREATE INDEX "integration_webhook_deliveries_next_attempt_idx"
  ON "integration_webhook_deliveries" ("next_attempt_at_utc");
CREATE INDEX "integration_webhook_deliveries_event_id_idx"
  ON "integration_webhook_deliveries" ("event_id");
