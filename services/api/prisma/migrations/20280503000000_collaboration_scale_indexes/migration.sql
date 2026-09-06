-- =============================================================================
-- Keyset-pagination indexes for the two collaboration reads that grew a cursor.
--
-- WHY THESE TWO, AND WHY NOW.
--
-- Both reads changed shape in the same pass:
--
--   * `GET /v1/teams/:id/members` is new. The workspace detail used to load
--     EVERY membership row on every page load; it now carries a bounded first
--     page and this endpoint pages the rest, ordered by (`created_at`, `id`)
--     because that pair is stable — which is what a cursor requires and what
--     the previous ordering (status, then priority) was not.
--
--   * `listAssignments` used to answer `take: 200` with no cursor, which is a
--     truncation rather than a page: the two hundred and first assignment was
--     invisible with nothing in the response to say so.
--
-- A keyset page without a matching index is a sequential scan plus a sort of
-- the whole partition on every page — so the pagination that was added to make
-- a large workspace readable would have made it slower instead. Each index
-- matches its query's ORDER BY exactly, including direction, so PostgreSQL can
-- walk it rather than sort.
--
-- PURELY ADDITIVE. No column is altered, no row is read or written, and an
-- index changes how a query is answered rather than what it answers — so a
-- deployment on either image is unaffected and re-running is a no-op.
--
-- WRITTEN IN THE PHASE O-FINAL PATTERN. Every column an index names is checked
-- for existence first, and the statement runs only if all of them are there.
-- That is not ceremony: the failure this pattern exists to prevent is an index
-- created against a column a later migration renamed or a guard silently
-- skipped, which is how `discussion_mentions.team_id` was lost.
-- =============================================================================

-- Workspace People, ordered oldest-first with `id` breaking ties.
DO $$
BEGIN
  IF TRUE
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'team_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'created_at')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "team_members_team_id_created_at_id_idx" ON "team_members" ("team_id", "created_at", "id")';
  ELSE
    RAISE EXCEPTION 'team_members is missing a column the keyset page orders on; the index cannot be created';
  END IF;
END $$;

-- A group's assignments, newest-first with `id` breaking ties.
DO $$
BEGIN
  IF TRUE
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_assignments' AND column_name = 'team_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_assignments' AND column_name = 'created_at')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collaboration_team_assignments' AND column_name = 'id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "collaboration_team_assignments_team_id_created_at_id_idx" ON "collaboration_team_assignments" ("team_id", "created_at" DESC, "id" DESC)';
  ELSE
    RAISE EXCEPTION 'collaboration_team_assignments is missing a column the keyset page orders on; the index cannot be created';
  END IF;
END $$;
