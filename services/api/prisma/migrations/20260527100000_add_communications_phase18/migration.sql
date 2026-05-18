-- Phase 18 — Enterprise Communications & External Outreach Platform
--
-- Forward-only additive migration:
--   * 6 new enums (CommunicationChannel, CommunicationDirection,
--     CommunicationPurpose, CommunicationStatus, CommunicationProvider,
--     VerificationAttemptStatus).
--   * 3 new tables (communication_messages, communication_preferences,
--     verification_attempts).
--   * 1 additive column on workflow_intake_sessions
--     (submitter_phone — VARCHAR(32), nullable).
--   * No existing column altered; no row mutated.
--
-- All communications rows are WORKSPACE-INTERNAL by design. Public
-- verify, OTS, anchor, report-v2, and verification package paths
-- NEVER read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS verification_attempts;
--   DROP TABLE IF EXISTS communication_preferences;
--   DROP TABLE IF EXISTS communication_messages;
--   ALTER TABLE workflow_intake_sessions DROP COLUMN IF EXISTS submitter_phone;
--   DROP TYPE IF EXISTS "VerificationAttemptStatus";
--   DROP TYPE IF EXISTS "CommunicationProvider";
--   DROP TYPE IF EXISTS "CommunicationStatus";
--   DROP TYPE IF EXISTS "CommunicationPurpose";
--   DROP TYPE IF EXISTS "CommunicationDirection";
--   DROP TYPE IF EXISTS "CommunicationChannel";

-- 1. New enums ------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "CommunicationChannel" AS ENUM (
    'SMS', 'WHATSAPP', 'EMAIL', 'SYSTEM'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationDirection" AS ENUM (
    'OUTBOUND', 'INBOUND'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationPurpose" AS ENUM (
    'OTP',
    'EVIDENCE_REQUEST',
    'INTAKE_LINK',
    'REVIEW_ESCALATION',
    'REVIEW_REMINDER',
    'CONTRIBUTOR_CLARIFICATION',
    'COLLABORATION_MENTION',
    'GOVERNANCE_ALERT',
    'SECURITY_ALERT',
    'PREFERENCE_UPDATE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationStatus" AS ENUM (
    'QUEUED',
    'SENT',
    'DELIVERED',
    'FAILED',
    'UNDELIVERED',
    'RETRY_SCHEDULED',
    'CANCELLED',
    'RECEIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CommunicationProvider" AS ENUM (
    'TWILIO', 'RESEND', 'INTERNAL', 'NOOP'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VerificationAttemptStatus" AS ENUM (
    'STARTED', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. workflow_intake_sessions.submitter_phone ----------------------------

ALTER TABLE "workflow_intake_sessions"
  ADD COLUMN IF NOT EXISTS "submitter_phone" VARCHAR(32);

-- 3. communication_messages ----------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_messages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "channel" "CommunicationChannel" NOT NULL,
  "direction" "CommunicationDirection" NOT NULL DEFAULT 'OUTBOUND',
  "purpose" "CommunicationPurpose" NOT NULL,
  "provider" "CommunicationProvider" NOT NULL DEFAULT 'NOOP',
  "recipient_hash" VARCHAR(64) NOT NULL,
  "recipient_preview" VARCHAR(64) NOT NULL,
  "sender" VARCHAR(64),
  "provider_message_id" VARCHAR(96),
  "status" "CommunicationStatus" NOT NULL DEFAULT 'QUEUED',
  "body_preview" VARCHAR(400),
  "related_evidence_id" UUID,
  "related_evidence_request_id" UUID,
  "related_discussion_thread_id" UUID,
  "related_intake_session_id" UUID,
  "related_intake_link_id" UUID,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at_utc" TIMESTAMPTZ(6),
  "error_code" VARCHAR(64),
  "error_message" VARCHAR(400),
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "sent_at_utc" TIMESTAMPTZ(6),
  "delivered_at_utc" TIMESTAMPTZ(6),
  "failed_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "communication_messages_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "communication_messages_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "communication_messages_related_evidence_id_fkey"
    FOREIGN KEY ("related_evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL,
  CONSTRAINT "communication_messages_related_evidence_request_id_fkey"
    FOREIGN KEY ("related_evidence_request_id") REFERENCES "evidence_requests"("id") ON DELETE SET NULL,
  CONSTRAINT "communication_messages_related_discussion_thread_id_fkey"
    FOREIGN KEY ("related_discussion_thread_id") REFERENCES "discussion_threads"("id") ON DELETE SET NULL,
  CONSTRAINT "communication_messages_related_intake_session_id_fkey"
    FOREIGN KEY ("related_intake_session_id") REFERENCES "workflow_intake_sessions"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "communication_messages_provider_callback_uk"
  ON "communication_messages" ("provider", "provider_message_id", "status");
CREATE INDEX IF NOT EXISTS "communication_messages_team_created_at_idx"
  ON "communication_messages" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "communication_messages_team_status_idx"
  ON "communication_messages" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "communication_messages_team_purpose_idx"
  ON "communication_messages" ("team_id", "purpose");
CREATE INDEX IF NOT EXISTS "communication_messages_team_channel_idx"
  ON "communication_messages" ("team_id", "channel");
CREATE INDEX IF NOT EXISTS "communication_messages_recipient_hash_idx"
  ON "communication_messages" ("recipient_hash");
CREATE INDEX IF NOT EXISTS "communication_messages_next_attempt_at_utc_idx"
  ON "communication_messages" ("next_attempt_at_utc");
CREATE INDEX IF NOT EXISTS "communication_messages_related_evidence_request_id_idx"
  ON "communication_messages" ("related_evidence_request_id");
CREATE INDEX IF NOT EXISTS "communication_messages_related_intake_session_id_idx"
  ON "communication_messages" ("related_intake_session_id");
CREATE INDEX IF NOT EXISTS "communication_messages_related_intake_link_id_idx"
  ON "communication_messages" ("related_intake_link_id");
CREATE INDEX IF NOT EXISTS "communication_messages_provider_message_id_idx"
  ON "communication_messages" ("provider_message_id");

-- 4. communication_preferences -------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_preferences" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "user_id" UUID,
  "external_contact_hash" VARCHAR(64),
  "sms_opt_out" BOOLEAN NOT NULL DEFAULT FALSE,
  "whatsapp_opt_out" BOOLEAN NOT NULL DEFAULT FALSE,
  "preferred_channel" "CommunicationChannel",
  "opt_out_reason" VARCHAR(400),
  "opt_out_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "communication_preferences_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "communication_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "communication_preferences_team_user_uk"
  ON "communication_preferences" ("team_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "communication_preferences_team_contact_hash_uk"
  ON "communication_preferences" ("team_id", "external_contact_hash");
CREATE INDEX IF NOT EXISTS "communication_preferences_team_idx"
  ON "communication_preferences" ("team_id");
CREATE INDEX IF NOT EXISTS "communication_preferences_external_contact_hash_idx"
  ON "communication_preferences" ("external_contact_hash");

-- 5. verification_attempts -----------------------------------------------

CREATE TABLE IF NOT EXISTS "verification_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "channel" "CommunicationChannel" NOT NULL,
  "purpose" "CommunicationPurpose" NOT NULL DEFAULT 'OTP',
  "recipient_hash" VARCHAR(64) NOT NULL,
  "recipient_preview" VARCHAR(64) NOT NULL,
  "provider_verification_sid" VARCHAR(96),
  "status" "VerificationAttemptStatus" NOT NULL DEFAULT 'STARTED',
  "check_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(64),
  "error_message" VARCHAR(400),
  "initiated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "approved_at_utc" TIMESTAMPTZ(6),
  "expires_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "verification_attempts_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "verification_attempts_initiated_by_user_id_fkey"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "verification_attempts_team_created_at_idx"
  ON "verification_attempts" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "verification_attempts_team_status_idx"
  ON "verification_attempts" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "verification_attempts_recipient_hash_idx"
  ON "verification_attempts" ("recipient_hash");
CREATE INDEX IF NOT EXISTS "verification_attempts_provider_verification_sid_idx"
  ON "verification_attempts" ("provider_verification_sid");
