-- Phase O-Final — Production column repair (ADDITIVE + DETERMINISTIC BACKFILL).
--
-- ============================================================================
-- ROOT-CAUSE HISTORY
-- ============================================================================
-- 1. Phase 16 migration (20260525100000_add_collaboration_phase16) used
--    `CREATE TABLE IF NOT EXISTS "discussion_mentions" (...)`. When a
--    production database had a pre-existing `discussion_mentions` table
--    (left from an earlier deploy or hand-rolled bootstrap), the
--    `IF NOT EXISTS` silently skipped the entire CREATE TABLE block —
--    so EVERY column that block declared was never added.
--
-- 2. The first revision of THIS repair migration assumed only `team_id`
--    was missing. Operator deploy revealed that production's actual
--    table shape diverged far more:
--
--      Production columns:
--        [id, message_id, user_id, created_at_utc]
--
--      Prisma's DiscussionMention model expects:
--        [id, message_id, thread_id, team_id, mentioned_user_id,
--         notified_at_utc, created_at]
--
--    The `CREATE INDEX ... (message_id, mentioned_user_id)` failed
--    with SQL 42703 because `mentioned_user_id` did not exist.
--
-- ============================================================================
-- THIS REVISION — design
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP, no RENAME, no DELETE, no TRUNCATE, no
--   SET NOT NULL. Backfill UPDATEs are deterministic and only touch
--   rows where the target column is still NULL (re-running is a
--   no-op).
-- * IDEMPOTENT. Every column ADD uses IF NOT EXISTS. Every backfill
--   UPDATE is wrapped in a PL/pgSQL DO block that first verifies the
--   SOURCE column exists, so the migration runs cleanly against ANY
--   production shape — the divergent one shown above, OR a fully
--   Prisma-correct one, OR partially-applied state from the prior
--   failure.
-- * INDEX-SAFE. Every CREATE INDEX is wrapped in a PL/pgSQL DO block
--   that verifies EVERY referenced column exists. This is the
--   specific defense against the SQL 42703 that broke the prior
--   revision — index creation cannot fail because of a missing
--   column even under unexpected production shapes.
-- * BACKFILL-DETERMINISTIC:
--     mentioned_user_id ← user_id (legacy pre-Phase-16 column;
--                                  `user_id` IS the mentioned user
--                                  on a mention row by construction)
--     thread_id         ← discussion_messages.thread_id via FK JOIN
--                          (message_id FK has ON DELETE CASCADE so
--                          every mention has a parent message)
--     created_at        ← created_at_utc (legacy timestamp column)
-- * NULLABILITY. Prisma marks mentioned_user_id, thread_id, and
--   created_at as required (no `?`). We add them NULLABLE in this
--   migration and rely on the backfill + DEFAULT NOW() to ensure
--   every row + future row gets a value. SET NOT NULL is deferred
--   to a follow-up migration after data-readiness is verified
--   (per the Phase A1 SET-NOT-NULL discipline).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. discussion_mentions — add every Prisma-required column.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_mentions"
  ADD COLUMN IF NOT EXISTS "team_id"           UUID,
  ADD COLUMN IF NOT EXISTS "thread_id"         UUID,
  ADD COLUMN IF NOT EXISTS "mentioned_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "notified_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at"        TIMESTAMPTZ(6);

-- Default on created_at so future Prisma INSERTs (which never include
-- the field when @default(now()) is declared in the model) write a
-- non-NULL value. The DEFAULT is purely additive — changes only
-- future-insert behaviour, never existing rows.
ALTER TABLE IF EXISTS "discussion_mentions"
  ALTER COLUMN "created_at" SET DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 2. Deterministic backfill: mentioned_user_id ← user_id.
--    In the pre-Phase-16 legacy schema, `user_id` IS the mentioned
--    user — it is the only user reference on a mention row. The DO
--    block verifies `user_id` exists before running so the migration
--    is safe on databases where the column has already been removed
--    or never existed.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'discussion_mentions'
       AND column_name  = 'user_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "discussion_mentions"
         SET "mentioned_user_id" = "user_id"
       WHERE "mentioned_user_id" IS NULL
         AND "user_id" IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Deterministic backfill: thread_id ← discussion_messages.thread_id.
--    The FK message_id → discussion_messages.id (declared in the
--    original Phase 16 migration with ON DELETE CASCADE) ensures every
--    mention has a parent message, so the join is total.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'discussion_messages'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'discussion_messages'
       AND column_name  = 'thread_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "discussion_mentions" dm
         SET "thread_id" = m."thread_id"
        FROM "discussion_messages" m
       WHERE m."id" = dm."message_id"
         AND dm."thread_id" IS NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Deterministic backfill: created_at ← created_at_utc.
--    The legacy schema used `created_at_utc`; Prisma now expects
--    `created_at`. Both refer to the same wall-clock value.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'discussion_mentions'
       AND column_name  = 'created_at_utc'
  ) THEN
    EXECUTE $upd$
      UPDATE "discussion_mentions"
         SET "created_at" = "created_at_utc"
       WHERE "created_at" IS NULL
         AND "created_at_utc" IS NOT NULL
    $upd$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Indexes — DEFENSIVE: each CREATE INDEX is wrapped in a DO block
--    that verifies EVERY referenced column exists. This is the
--    specific fix for the SQL 42703 that broke the prior revision.
--    The indexes mirror the @@unique / @@index declarations on the
--    Prisma DiscussionMention model.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions'
       AND column_name='mentioned_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions'
       AND column_name='message_id'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "discussion_mentions_msg_user_unique"
               ON "discussion_mentions" ("message_id", "mentioned_user_id")';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions'
       AND column_name='thread_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "discussion_mentions_thread_idx"
               ON "discussion_mentions" ("thread_id")';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions'
       AND column_name='mentioned_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='discussion_mentions'
       AND column_name='notified_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "discussion_mentions_user_notified_idx"
               ON "discussion_mentions" ("mentioned_user_id", "notified_at_utc")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. discussion_participants — same Phase-16 silent-skip risk family.
--    Add the columns Prisma's DiscussionParticipant model expects.
--    No legacy column source for these; the columns are nullable in
--    Prisma so empty values are tolerated by the runtime.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "discussion_participants"
  ADD COLUMN IF NOT EXISTS "team_id"            UUID,
  ADD COLUMN IF NOT EXISTS "user_id"            UUID,
  ADD COLUMN IF NOT EXISTS "intake_session_id"  UUID,
  ADD COLUMN IF NOT EXISTS "added_by_user_id"   UUID,
  ADD COLUMN IF NOT EXISTS "revoked_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- 7. evidence_workflow_instances — Phase 13 / B2 nullable columns.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_workflow_instances"
  ADD COLUMN IF NOT EXISTS "external_contact_hash"      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "created_by_user_id"         UUID,
  ADD COLUMN IF NOT EXISTS "assigned_reviewer_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "intake_session_id"          UUID,
  ADD COLUMN IF NOT EXISTS "evidence_request_id"        UUID;

-- ---------------------------------------------------------------------------
-- 8. upload_sessions — Phase 30 multipart bookkeeping. Every column is
--    either nullable or has-default in the Prisma schema.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "upload_sessions"
  ADD COLUMN IF NOT EXISTS "team_id"              UUID,
  ADD COLUMN IF NOT EXISTS "is_multipart"         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "expected_part_count"  INTEGER,
  ADD COLUMN IF NOT EXISTS "completed_part_count" INTEGER    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "multipart_upload_id"  VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "retry_count"          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_reason"       VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "stalled_at_utc"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "abandoned_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc"     TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 9. evidence_saved_views — Phase G2 saved-view CRUD.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "evidence_saved_views"
  ADD COLUMN IF NOT EXISTS "team_id"     UUID,
  ADD COLUMN IF NOT EXISTS "description" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "sort_key"    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "is_default"  BOOLEAN NOT NULL DEFAULT FALSE;

-- Index on (team_id, created_at) — same defensive DO-block pattern as
-- the discussion_mentions indexes above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_saved_views'
       AND column_name='created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_saved_views_team_created_idx"
               ON "evidence_saved_views" ("team_id", "created_at" DESC)';
  END IF;
END $$;
