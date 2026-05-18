-- Phase 8 Notification infrastructure: NotificationDelivery
--
-- Forward-only, additive migration:
--   * Three new enums (NotificationChannel, NotificationProvider,
--     NotificationDeliveryStatus).
--   * One new table (notification_deliveries).
--   * No existing rows modified.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS notification_deliveries;
--   DROP TYPE IF EXISTS "NotificationDeliveryStatus";
--   DROP TYPE IF EXISTS "NotificationProvider";
--   DROP TYPE IF EXISTS "NotificationChannel";
--
-- Production deploy command:
--   pnpm --filter proovra-api prisma migrate deploy

-- 1. Enums -----------------------------------------------------------------

CREATE TYPE "NotificationChannel" AS ENUM (
  'EMAIL',
  'SMS',
  'WEBHOOK',
  'PUSH',
  'IN_APP'
);

CREATE TYPE "NotificationProvider" AS ENUM (
  'RESEND',
  'TWILIO',
  'WEBHOOK_HTTP',
  'INTERNAL'
);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'PENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'RETRY_SCHEDULED',
  'CANCELLED',
  'SKIPPED'
);

-- 2. notification_deliveries ----------------------------------------------

CREATE TABLE "notification_deliveries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "event_type" VARCHAR(64) NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "provider" "NotificationProvider" NOT NULL,
  "recipient" VARCHAR(512) NOT NULL,
  "recipient_name" VARCHAR(180),
  "recipient_user_id" UUID,
  "evidence_request_id" UUID,
  "evidence_id" UUID,
  "intake_link_id" UUID,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "subject" VARCHAR(400),
  "template_key" VARCHAR(80) NOT NULL,
  "rendered_preview" VARCHAR(2000),
  "provider_message_id" VARCHAR(255),
  "error_code" VARCHAR(80),
  "error_message" VARCHAR(2000),
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at_utc" TIMESTAMPTZ(6),
  "sent_at_utc" TIMESTAMPTZ(6),
  "delivered_at_utc" TIMESTAMPTZ(6),
  "failed_at_utc" TIMESTAMPTZ(6),
  "metadata" JSONB,
  "initiated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "notification_deliveries_recipient_user_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_initiated_by_user_fkey"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_evidence_request_fkey"
    FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "notification_deliveries_team_created_idx"
  ON "notification_deliveries" ("team_id", "created_at" DESC);
CREATE INDEX "notification_deliveries_event_created_idx"
  ON "notification_deliveries" ("event_type", "created_at" DESC);
CREATE INDEX "notification_deliveries_status_idx"
  ON "notification_deliveries" ("status");
CREATE INDEX "notification_deliveries_evidence_request_idx"
  ON "notification_deliveries" ("evidence_request_id");
CREATE INDEX "notification_deliveries_evidence_idx"
  ON "notification_deliveries" ("evidence_id");
CREATE INDEX "notification_deliveries_intake_link_idx"
  ON "notification_deliveries" ("intake_link_id");
CREATE INDEX "notification_deliveries_next_attempt_idx"
  ON "notification_deliveries" ("next_attempt_at_utc");
