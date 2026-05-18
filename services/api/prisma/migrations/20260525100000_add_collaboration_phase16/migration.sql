-- Phase 16 — Enterprise collaboration platform
--
-- Forward-only additive migration:
--   * 12 new EvidenceReviewerAuditEventType values (discussion +
--     contributor lifecycle events) via ADD VALUE IF NOT EXISTS.
--   * 5 new enums (DiscussionThreadKind, DiscussionThreadStatus,
--     DiscussionThreadVisibility, DiscussionMessageAuthorKind,
--     DiscussionParticipantRole).
--   * 4 new tables (threads, messages, mentions, participants).
--   * No existing column altered.
--
-- All collaboration rows are WORKSPACE-INTERNAL by design. Public
-- verify, OTS, anchor, report-v2, and verification package paths
-- never read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS discussion_participants;
--   DROP TABLE IF EXISTS discussion_mentions;
--   DROP TABLE IF EXISTS discussion_messages;
--   DROP TABLE IF EXISTS discussion_threads;
--   DROP TYPE  IF EXISTS "DiscussionParticipantRole";
--   DROP TYPE  IF EXISTS "DiscussionMessageAuthorKind";
--   DROP TYPE  IF EXISTS "DiscussionThreadVisibility";
--   DROP TYPE  IF EXISTS "DiscussionThreadStatus";
--   DROP TYPE  IF EXISTS "DiscussionThreadKind";
--   -- Enum values cannot be removed safely; new audit values stay.

-- 1. New audit event types ------------------------------------------------

ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_THREAD_CREATED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_MESSAGE_POSTED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_MESSAGE_EDITED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_MESSAGE_DELETED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_RESOLVED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_REOPENED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_ASSIGNED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'DISCUSSION_ESCALATED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'MENTION_CREATED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'CONTRIBUTOR_REPLY_RECEIVED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'CONTRIBUTOR_ACCESS_GRANTED';
ALTER TYPE "EvidenceReviewerAuditEventType" ADD VALUE IF NOT EXISTS 'CONTRIBUTOR_ACCESS_REVOKED';

-- 2. New enums ------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "DiscussionThreadKind" AS ENUM (
    'EVIDENCE_GENERAL',
    'REVIEW_REQUEST_CLARIFICATION',
    'INVESTIGATION_COORDINATION',
    'WORKFLOW_DISCUSSION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DiscussionThreadStatus" AS ENUM (
    'OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DiscussionThreadVisibility" AS ENUM (
    'INTERNAL', 'CONTRIBUTOR_SCOPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DiscussionMessageAuthorKind" AS ENUM (
    'USER', 'CONTRIBUTOR', 'SYSTEM'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DiscussionParticipantRole" AS ENUM (
    'PARTICIPANT', 'RESOLVER', 'WATCHER', 'CONTRIBUTOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Tables ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "discussion_threads" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "evidence_id" UUID NOT NULL,
  "evidence_request_id" UUID,
  "kind" "DiscussionThreadKind" NOT NULL DEFAULT 'EVIDENCE_GENERAL',
  "status" "DiscussionThreadStatus" NOT NULL DEFAULT 'OPEN',
  "visibility" "DiscussionThreadVisibility" NOT NULL DEFAULT 'INTERNAL',
  "title" VARCHAR(180) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "assigned_to_user_id" UUID,
  "assigned_at_utc" TIMESTAMPTZ(6),
  "resolved_by_user_id" UUID,
  "resolved_at_utc" TIMESTAMPTZ(6),
  "resolution_note" VARCHAR(1000),
  "reopened_at_utc" TIMESTAMPTZ(6),
  "reopened_by_user_id" UUID,
  "reopen_count" INTEGER NOT NULL DEFAULT 0,
  "escalated_at_utc" TIMESTAMPTZ(6),
  "escalated_by_user_id" UUID,
  "escalation_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "discussion_threads_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "discussion_threads_team_status_updated_idx"
  ON "discussion_threads" ("team_id", "status", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "discussion_threads_evidence_status_idx"
  ON "discussion_threads" ("evidence_id", "status");
CREATE INDEX IF NOT EXISTS "discussion_threads_assigned_status_idx"
  ON "discussion_threads" ("assigned_to_user_id", "status");
CREATE INDEX IF NOT EXISTS "discussion_threads_visibility_status_idx"
  ON "discussion_threads" ("visibility", "status");

CREATE TABLE IF NOT EXISTS "discussion_messages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id" UUID NOT NULL,
  "team_id" UUID,
  "author_kind" "DiscussionMessageAuthorKind" NOT NULL,
  "author_user_id" UUID,
  "contributor_intake_session_id" UUID,
  "contributor_label" VARCHAR(180),
  "body" VARCHAR(8192) NOT NULL,
  "edited_at_utc" TIMESTAMPTZ(6),
  "deleted_at_utc" TIMESTAMPTZ(6),
  "deleted_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "discussion_messages_thread_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "discussion_threads" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "discussion_messages_thread_created_idx"
  ON "discussion_messages" ("thread_id", "created_at" ASC);
CREATE INDEX IF NOT EXISTS "discussion_messages_team_created_idx"
  ON "discussion_messages" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "discussion_messages_author_idx"
  ON "discussion_messages" ("author_user_id");

CREATE TABLE IF NOT EXISTS "discussion_mentions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "team_id" UUID,
  "mentioned_user_id" UUID NOT NULL,
  "notified_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "discussion_mentions_message_fkey"
    FOREIGN KEY ("message_id") REFERENCES "discussion_messages" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "discussion_mentions_msg_user_unique"
  ON "discussion_mentions" ("message_id", "mentioned_user_id");
CREATE INDEX IF NOT EXISTS "discussion_mentions_thread_idx"
  ON "discussion_mentions" ("thread_id");
CREATE INDEX IF NOT EXISTS "discussion_mentions_user_notified_idx"
  ON "discussion_mentions" ("mentioned_user_id", "notified_at_utc");

CREATE TABLE IF NOT EXISTS "discussion_participants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id" UUID NOT NULL,
  "team_id" UUID,
  "user_id" UUID,
  "intake_session_id" UUID,
  "role" "DiscussionParticipantRole" NOT NULL DEFAULT 'PARTICIPANT',
  "added_by_user_id" UUID,
  "added_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  CONSTRAINT "discussion_participants_thread_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "discussion_threads" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "discussion_participants_thread_user_unique"
  ON "discussion_participants" ("thread_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "discussion_participants_thread_session_unique"
  ON "discussion_participants" ("thread_id", "intake_session_id");
CREATE INDEX IF NOT EXISTS "discussion_participants_user_idx"
  ON "discussion_participants" ("user_id");
CREATE INDEX IF NOT EXISTS "discussion_participants_session_idx"
  ON "discussion_participants" ("intake_session_id");
