-- Phase G3.1 — operator notification preferences.
--
-- Adds a single bounded table for per-(user, workspace, preferenceType,
-- channel) notification toggles. The existing CommunicationPreference
-- table controls outbound SMS/WhatsApp opt-out for CONTACT notifications
-- and is left untouched; this new table controls operator-facing inbox /
-- topbar / email surfacing for the seven bounded preference types
-- (mentions, assigned threads, reviewer assignments, escalations,
-- SLA near-breach, evidence request updates, governance updates).
--
-- Defaults are operator-friendly: every preference is enabled in-app
-- by default. Email is opt-in — operators must explicitly create an
-- `enabled = true, channel = EMAIL` row to receive email notifications.

CREATE TYPE "NotificationPreferenceType" AS ENUM (
  'MENTION',
  'ASSIGNED_THREAD',
  'REVIEWER_ASSIGNMENT',
  'ESCALATION',
  'SLA_NEAR_BREACH',
  'EVIDENCE_REQUEST_UPDATE',
  'GOVERNANCE_UPDATE'
);

CREATE TYPE "NotificationPreferenceChannel" AS ENUM (
  'IN_APP',
  'EMAIL'
);

CREATE TABLE "workspace_notification_preferences" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "preference_type" "NotificationPreferenceType" NOT NULL,
  "channel" "NotificationPreferenceChannel" NOT NULL DEFAULT 'IN_APP',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "workspace_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- Operator preferences are unique per (user, workspace, type, channel).
-- A user can have one IN_APP and one EMAIL row per preference type per
-- workspace.
CREATE UNIQUE INDEX "workspace_notification_preferences_user_id_team_id_preferenc_key"
  ON "workspace_notification_preferences"
  ("user_id", "team_id", "preference_type", "channel");

-- Read patterns:
--   * "what are this user's preferences in this workspace?" — driven
--     by the (user_id, team_id) prefix on the unique index.
--   * "which users have opted IN to email for this type?" — needs the
--     non-unique (team_id) lookup index below.
CREATE INDEX "workspace_notification_preferences_user_id_idx"
  ON "workspace_notification_preferences" ("user_id");

CREATE INDEX "workspace_notification_preferences_team_id_idx"
  ON "workspace_notification_preferences" ("team_id");

ALTER TABLE "workspace_notification_preferences"
  ADD CONSTRAINT "workspace_notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "workspace_notification_preferences"
  ADD CONSTRAINT "workspace_notification_preferences_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
