-- Phase EMERGENCY-RECOVERY — Personal workspace bootstrap.
--
-- Adds the `is_personal` flag to `teams` so the platform-context
-- builder can auto-create a real personal Team row for every
-- authenticated user. A partial unique index enforces "AT MOST ONE
-- personal team per owner" so the bootstrap is concurrency-safe.
--
-- This migration is:
--   * forward-only (no destructive operations);
--   * idempotent (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT
--     EXISTS guards);
--   * additive (no existing data semantics changed; all current
--     teams remain TEAM-scoped because `is_personal` defaults to
--     `false`);
--   * safe under concurrent execution (the unique partial index is
--     the source of truth — concurrent INSERTs racing on the same
--     owner_user_id resolve to a single winner; the loser sees a
--     unique-constraint violation that the bootstrap service catches
--     and converts into a re-fetch).
--
-- Rollback (manual, if ever needed):
--   DROP INDEX IF EXISTS teams_owner_personal_uniq;
--   ALTER TABLE teams DROP COLUMN IF EXISTS is_personal;

ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "is_personal" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "teams_owner_personal_uniq"
  ON "teams" ("owner_user_id")
  WHERE "is_personal" = TRUE;
