-- =============================================================================
-- PHASE 12B CLUSTER 9 — `workspace_governance_policies.version`
--
-- WHY
-- `PUT /v1/governance/policy` was a blind upsert: it read nothing, compared
-- nothing, and last-write-wins silently discarded a concurrent operator's
-- decision. The policy row carries the deletion mode, the legal-hold approval
-- gate and every download/publication switch, so a silently overwritten edit
-- is a governance control that quietly reverted. This column turns the write
-- into a conditional UPDATE (`WHERE team_id = $1 AND version = $expected`,
-- `SET ... , version = version + 1`), so a stale caller gets
-- 409 POLICY_VERSION_CONFLICT and mutates nothing.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds `version INTEGER NOT NULL DEFAULT 1` (idempotent).
--   2. Deterministically sets every pre-existing row to 1. This is not a
--      guess: before this column existed no policy write was versioned, so
--      "1" is the only truthful statement that can be made about a historical
--      row — it is the first version this system can account for. No
--      fabricated edit history, no per-row heuristic.
--   3. Enforces NOT NULL once the backfill has run.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It DROPS nothing and RENAMES nothing.
--   * It changes no policy VALUE. Every retention day count, deletion mode,
--     approval flag and download switch survives byte-for-byte: the only
--     writes issued are to the new `version` column.
--   * It INSERTs and DELETEs nothing —
--     count(workspace_governance_policies) is unchanged.
--
-- FORWARD-ONLY. IDEMPOTENT (safe to re-run). NOT APPLIED by this change.
-- =============================================================================

-- 1. Add the column. Guarded on pg_attribute so a re-run is a no-op, matching
--    the sibling migrations in this directory.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.workspace_governance_policies'::regclass
      AND attname = 'version'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE "workspace_governance_policies"
      ADD COLUMN "version" INTEGER DEFAULT 1;
  END IF;
END
$$;

-- 2. Deterministic backfill. `ADD COLUMN ... DEFAULT 1` already materialises 1
--    for existing rows on every supported Postgres, but a re-run against a
--    partially-migrated database (column added, default later dropped) could
--    leave NULLs. This statement is the explicit guarantee, and it can never
--    overwrite a value that is already set.
UPDATE "workspace_governance_policies"
SET "version" = 1
WHERE "version" IS NULL;

-- 3. Enforce NOT NULL. Runs only once the backfill above has removed every
--    NULL, so it cannot fail on a populated table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.workspace_governance_policies'::regclass
      AND attname = 'version'
      AND NOT attisdropped
      AND attnotnull = false
  ) THEN
    ALTER TABLE "workspace_governance_policies"
      ALTER COLUMN "version" SET NOT NULL;
  END IF;
END
$$;

-- 4. Keep the column default aligned with the Prisma model (@default(1)) so a
--    future INSERT that omits `version` lands on 1 rather than failing.
ALTER TABLE "workspace_governance_policies"
  ALTER COLUMN "version" SET DEFAULT 1;

-- 5. Post-condition: every policy row must carry an accountable version.
--    A surviving NULL would mean the conditional-UPDATE guard could never
--    match that row, silently locking its policy out of every future edit.
DO $$
DECLARE
  unversioned BIGINT;
BEGIN
  SELECT COUNT(*) INTO unversioned
  FROM "workspace_governance_policies"
  WHERE "version" IS NULL;
  IF unversioned > 0 THEN
    RAISE EXCEPTION
      'Refusing to complete: % workspace governance policy row(s) still carry a NULL version.',
      unversioned;
  END IF;
END
$$;
