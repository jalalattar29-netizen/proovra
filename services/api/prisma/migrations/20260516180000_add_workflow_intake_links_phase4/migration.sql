-- Phase 4 Workflow Engine: external intake links + sessions
--
-- Forward-only, additive migration. Adds:
--   * Two new enums (WorkflowIntakeLinkStatus, WorkflowIntakeSessionStatus).
--   * Three new values on the existing CustodyEventType enum.
--   * One new value on the existing CaptureMethod enum.
--   * Two new tables (workflow_intake_links, workflow_intake_sessions).
--
-- No existing rows are modified. No FKs are added to existing tables that
-- would change their cascade behavior. The new tables reference existing
-- tables via SetNull / Cascade / Restrict — none of them allow deletion of
-- an existing record to silently change.
--
-- Rollback risk: low. To reverse (in order):
--   DROP TABLE IF EXISTS workflow_intake_sessions;
--   DROP TABLE IF EXISTS workflow_intake_links;
--   DROP TYPE IF EXISTS "WorkflowIntakeSessionStatus";
--   DROP TYPE IF EXISTS "WorkflowIntakeLinkStatus";
--   (Postgres enum value additions on CustodyEventType / CaptureMethod
--   cannot be removed cleanly; leave them in place — they are inert until
--   code references them.)
--
-- Production deploy command:
--   pnpm --filter proovra-api prisma migrate deploy

-- 1. New enums -------------------------------------------------------------

CREATE TYPE "WorkflowIntakeLinkStatus" AS ENUM (
  'ACTIVE',
  'REVOKED',
  'EXPIRED'
);

CREATE TYPE "WorkflowIntakeSessionStatus" AS ENUM (
  'CREATED',
  'OPENED',
  'UPLOAD_STARTED',
  'UPLOAD_COMPLETED',
  'SUBMITTED',
  'EXPIRED',
  'REVOKED',
  'ABANDONED'
);

-- 2. Enum extensions -------------------------------------------------------
-- Each ADD VALUE runs in its own statement; Postgres requires this outside
-- of a transaction in some older versions, but Prisma's migrate deploy
-- handles the necessary commit boundaries.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXTERNAL_INTAKE_LINK_USED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXTERNAL_INTAKE_CONSENT_ACCEPTED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXTERNAL_INTAKE_SUBMITTED';

ALTER TYPE "CaptureMethod" ADD VALUE IF NOT EXISTS 'EXTERNAL_INTAKE_UPLOAD';

-- 3. workflow_intake_links --------------------------------------------------

CREATE TABLE "workflow_intake_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  "team_id" UUID NOT NULL,

  "workflow_template_id" UUID,
  "workflow_template_slug" VARCHAR(120) NOT NULL,
  "workflow_template_version" INTEGER NOT NULL,
  "workflow_template_snapshot" JSONB NOT NULL,

  "intake_mode" VARCHAR(40) NOT NULL,
  "case_id" UUID,

  "token_hash" VARCHAR(128) NOT NULL,
  "token_version" INTEGER NOT NULL DEFAULT 1,

  "recipient_label" VARCHAR(180),
  "recipient_email" VARCHAR(320),
  "recipient_phone" VARCHAR(32),

  "max_uses" INTEGER NOT NULL DEFAULT 1,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "max_file_count_per_session" INTEGER,
  "max_bytes_per_session" BIGINT,
  "allowed_accepted_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "consent_policy_version" VARCHAR(40),
  "consent_disclosure_text" TEXT,

  "status" "WorkflowIntakeLinkStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),

  "ip_allowlist_cidrs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "workflow_intake_links_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_links_workflow_template_id_fkey"
    FOREIGN KEY ("workflow_template_id") REFERENCES "evidence_workflow_templates" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_links_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_links_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workflow_intake_links_token_hash_key"
  ON "workflow_intake_links" ("token_hash");
CREATE INDEX "workflow_intake_links_team_id_status_idx"
  ON "workflow_intake_links" ("team_id", "status");
CREATE INDEX "workflow_intake_links_team_id_created_at_idx"
  ON "workflow_intake_links" ("team_id", "created_at" DESC);
CREATE INDEX "workflow_intake_links_expires_at_utc_idx"
  ON "workflow_intake_links" ("expires_at_utc");
CREATE INDEX "workflow_intake_links_workflow_template_id_idx"
  ON "workflow_intake_links" ("workflow_template_id");
CREATE INDEX "workflow_intake_links_case_id_idx"
  ON "workflow_intake_links" ("case_id");

-- 4. workflow_intake_sessions ----------------------------------------------

CREATE TABLE "workflow_intake_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "intake_link_id" UUID NOT NULL,

  "status" "WorkflowIntakeSessionStatus" NOT NULL DEFAULT 'CREATED',
  "opened_at_utc" TIMESTAMPTZ(6),
  "upload_started_at_utc" TIMESTAMPTZ(6),
  "upload_completed_at_utc" TIMESTAMPTZ(6),
  "submitted_at_utc" TIMESTAMPTZ(6),
  "abandoned_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,

  "guest_identity_id" UUID,
  "pseudonym" VARCHAR(80),
  "submitter_display_name" VARCHAR(180),
  "submitter_email" VARCHAR(320),

  "capture_session_id" UUID,
  "evidence_id" UUID,

  "consent_accepted_at_utc" TIMESTAMPTZ(6),
  "consent_snapshot_json" JSONB,

  "submitter_ip_hash" VARCHAR(64),
  "submitter_user_agent" VARCHAR(512),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "workflow_intake_sessions_intake_link_id_fkey"
    FOREIGN KEY ("intake_link_id") REFERENCES "workflow_intake_links" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_sessions_guest_identity_id_fkey"
    FOREIGN KEY ("guest_identity_id") REFERENCES "guest_identities" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_sessions_capture_session_id_fkey"
    FOREIGN KEY ("capture_session_id") REFERENCES "capture_sessions" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "workflow_intake_sessions_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workflow_intake_sessions_capture_session_id_key"
  ON "workflow_intake_sessions" ("capture_session_id");
CREATE UNIQUE INDEX "workflow_intake_sessions_evidence_id_key"
  ON "workflow_intake_sessions" ("evidence_id");
CREATE INDEX "workflow_intake_sessions_intake_link_id_status_idx"
  ON "workflow_intake_sessions" ("intake_link_id", "status");
CREATE INDEX "workflow_intake_sessions_intake_link_id_created_at_idx"
  ON "workflow_intake_sessions" ("intake_link_id", "created_at" DESC);
CREATE INDEX "workflow_intake_sessions_expires_at_utc_idx"
  ON "workflow_intake_sessions" ("expires_at_utc");
CREATE INDEX "workflow_intake_sessions_status_idx"
  ON "workflow_intake_sessions" ("status");
