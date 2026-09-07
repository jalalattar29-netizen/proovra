-- =============================================================================
-- WCR-14 — the activity feed's keyset page gets the index its ORDER BY needs.
--
-- `listTeamActivity` paged on `id` while ordering by `created_at` alone. Two
-- rows sharing a timestamp then had no defined order between requests, so a
-- page boundary could move and rows could repeat or disappear. That is the
-- normal case here rather than an edge case: `recordActivity` writes inside the
-- mutation's own transaction, and several events routinely commit together with
-- identical timestamps.
--
-- The service now orders by `(created_at DESC, id DESC)` — the same stable pair
-- `listAssignments` was given when it was paginated. This is the other half:
-- without an index matching that order exactly, including direction, every page
-- is a sequential scan plus a sort of the whole team partition, so the
-- pagination added to make a busy group readable would have made it slower.
--
-- The existing `(team_id, created_at DESC)` index cannot serve it — a keyset
-- walk needs the tiebreaker in the index too, or PostgreSQL must sort to
-- resolve the ties the cursor depends on.
--
-- PURELY ADDITIVE. An index changes how a query is answered, not what it
-- answers; deployable on either image, and re-running is a no-op.
--
-- Phase O-final pattern: every column the index names is checked first, so this
-- cannot silently create a partial index against a renamed column.
-- =============================================================================

DO $$
BEGIN
  IF TRUE
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_activity' AND column_name = 'team_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_activity' AND column_name = 'created_at')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_activity' AND column_name = 'id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_activity_team_id_created_at_id_idx" ON "collaboration_team_activity" ("team_id", "created_at" DESC, "id" DESC)';
  ELSE
    RAISE EXCEPTION 'collaboration_team_activity is missing a column the keyset page orders on; the index cannot be created';
  END IF;
END $$;
