-- Phase O-Final — Production column repair (ADDITIVE ONLY).
--
-- Root cause: the original Phase 16 migration (20260525100000_add_collaboration_phase16)
-- used `CREATE TABLE IF NOT EXISTS "discussion_mentions" (...)`. When a
-- pre-existing `discussion_mentions` table was already present in a
-- production database (left over from an earlier deploy or hand-rolled
-- bootstrap), the IF NOT EXISTS clause caused the ENTIRE block to be
-- skipped — so the `team_id` column declared in the Prisma schema
-- was never added. Runtime fails with `column discussion_mentions.team_id
-- does not exist` even though `prisma migrate status` shows OK.
--
-- This repair migration is ADDITIVE ONLY. It does NOT drop columns,
-- it does NOT rename, it does NOT change NOT NULL constraints, it
-- does NOT recreate tables. Every statement is guarded with
-- IF NOT EXISTS so re-running is a no-op.
--
-- Tables repaired (5):
--   * discussion_mentions
--   * discussion_participants
--   * evidence_workflow_instances
--   * upload_sessions
--   * evidence_saved_views
--
-- Run via the project's safe-migrate wrapper:
--   MIGRATE_ALLOW_REMOTE=1 MIGRATE_BACKUP_ID=<neon-snapshot-id> \
--     node services/api/scripts/safe-migrate.mjs deploy --allow-remote
--
-- Operators MUST take a Neon snapshot BEFORE running. If none exists,
-- stop and create one.

-- ---------------------------------------------------------------------------
-- 1. discussion_mentions — root-cause table for the runtime P2022.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_mentions"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

-- Index on team_id is not declared in the Prisma schema, but the
-- thread_idx + user_notified_idx + msg_user_unique are. Re-assert
-- them defensively so a partially-applied original migration is
-- fully reconciled.
CREATE UNIQUE INDEX IF NOT EXISTS "discussion_mentions_msg_user_unique"
  ON "discussion_mentions" ("message_id", "mentioned_user_id");
CREATE INDEX IF NOT EXISTS "discussion_mentions_thread_idx"
  ON "discussion_mentions" ("thread_id");
CREATE INDEX IF NOT EXISTS "discussion_mentions_user_notified_idx"
  ON "discussion_mentions" ("mentioned_user_id", "notified_at_utc");

-- ---------------------------------------------------------------------------
-- 2. discussion_participants — sister table, same migration block,
--    same CREATE TABLE IF NOT EXISTS trap risk.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_participants"
  ADD COLUMN IF NOT EXISTS "team_id"           UUID,
  ADD COLUMN IF NOT EXISTS "user_id"           UUID,
  ADD COLUMN IF NOT EXISTS "intake_session_id" UUID,
  ADD COLUMN IF NOT EXISTS "added_by_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "revoked_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- 3. evidence_workflow_instances — declared in Phase 13 / refined in
--    Phase B2. Columns below are nullable in the Prisma schema OR
--    have safe defaults, so ADD COLUMN IF NOT EXISTS is safe.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_instances"
  ADD COLUMN IF NOT EXISTS "external_contact_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "created_by_user_id"    UUID,
  ADD COLUMN IF NOT EXISTS "assigned_reviewer_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "intake_session_id"     UUID,
  ADD COLUMN IF NOT EXISTS "evidence_request_id"   UUID;

-- ---------------------------------------------------------------------------
-- 4. upload_sessions — Phase 30 multipart-bookkeeping columns. Every
--    column is nullable / has-default in the Prisma schema.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "upload_sessions"
  ADD COLUMN IF NOT EXISTS "team_id"             UUID,
  ADD COLUMN IF NOT EXISTS "is_multipart"        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "expected_part_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "completed_part_count" INTEGER    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "multipart_upload_id" VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "retry_count"         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_reason"      VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "stalled_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "abandoned_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc"    TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 5. evidence_saved_views — Phase G2 saved-view CRUD. team_id is
--    nullable in the Prisma schema (personal-mode views have no team).
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_saved_views"
  ADD COLUMN IF NOT EXISTS "team_id"     UUID,
  ADD COLUMN IF NOT EXISTS "description" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "sort_key"    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "is_default"  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS "evidence_saved_views_team_created_idx"
  ON "evidence_saved_views" ("team_id", "created_at" DESC);
