-- Phase IA-reliability — InboxItemState
--
-- Adds the canonical per-user state table the inbox aggregator joins
-- against to implement real read / unread / dismiss / snooze behavior.
--
-- Hard rules (carry into reviews):
--   * Per-user state ONLY. We never store the source row's title /
--     body / context here. Inbox snapshots stay computed at request
--     time from the canonical sources (DiscussionMention,
--     OperationalIncident, ...). If the source resolves, the inbox
--     simply stops emitting the row and the dangling state row
--     becomes irrelevant (cleaned by future TTL job).
--   * itemKey is a DETERMINISTIC composite of `(sourceType, sourceId)`
--     — e.g. `discussion_mention:<mention_id>`. The aggregator
--     computes the same key on every read, so persisting + matching
--     state is trivial.
--   * Unique by `(user_id, item_key)` so writes are idempotent (a
--     repeat mark-read POST never inserts a duplicate).
--   * Tenant scope: the user_id column is the authority. teamId /
--     orgId are stored as audit context only — every read joins on
--     user_id = caller. Cross-user reads are physically impossible
--     even if the inbox endpoint were tricked.
--
-- Idempotent + defensive: the whole table create is wrapped in a
-- pg_tables guard so re-running the migration in any environment is
-- a no-op. Indexes use IF NOT EXISTS. Matches Phase O hardened style.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'inbox_item_state'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "inbox_item_state" (
  "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        UUID         NOT NULL,
  "item_key"       VARCHAR(200) NOT NULL,
  "source_type"    VARCHAR(64)  NOT NULL,
  "source_id"      VARCHAR(200),
  "team_id"        UUID,
  "org_id"         UUID,
  "read_at"        TIMESTAMPTZ(6),
  "dismissed_at"   TIMESTAMPTZ(6),
  "snoozed_until"  TIMESTAMPTZ(6),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
    $sql$;
  END IF;
END $$;

-- Unique (user_id, item_key) — every state row is unique per user +
-- per inbox item. We use this in an `upsert` so mark-read is
-- idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname  = 'inbox_item_state_user_id_item_key_key'
  ) THEN
    CREATE UNIQUE INDEX "inbox_item_state_user_id_item_key_key"
      ON "inbox_item_state" ("user_id", "item_key");
  END IF;
END $$;

-- Hot paths the aggregator queries:
--   * "all my state rows" (anchor for the join)            -> user_id
--   * "items I haven't dismissed"                          -> (user_id, dismissed_at)
--   * "items I haven't read"                               -> (user_id, read_at)
--   * "items snoozed past now"                             -> (user_id, snoozed_until)
--   * "everything I dismissed for source type X"           -> (user_id, source_type)
--   * "all my state in team X" (for future workspace view) -> (user_id, team_id)
CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_idx"
  ON "inbox_item_state" ("user_id");

CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_dismissed_at_idx"
  ON "inbox_item_state" ("user_id", "dismissed_at");

CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_read_at_idx"
  ON "inbox_item_state" ("user_id", "read_at");

CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_snoozed_until_idx"
  ON "inbox_item_state" ("user_id", "snoozed_until");

CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_source_type_idx"
  ON "inbox_item_state" ("user_id", "source_type");

CREATE INDEX IF NOT EXISTS "inbox_item_state_user_id_team_id_idx"
  ON "inbox_item_state" ("user_id", "team_id");

-- Foreign key on user_id. We deliberately omit FK on team_id / org_id
-- because both are nullable audit context — a state row may outlive
-- the team it referenced (e.g., the user left the workspace) and that
-- shouldn't cascade-delete the read receipt. ON DELETE CASCADE on
-- user_id is correct: deleting the user revokes all per-user state.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name   = 'inbox_item_state'
       AND constraint_name = 'inbox_item_state_user_id_fkey'
  ) THEN
    ALTER TABLE "inbox_item_state"
      ADD CONSTRAINT "inbox_item_state_user_id_fkey"
      FOREIGN KEY ("user_id")
      REFERENCES "users" ("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;
