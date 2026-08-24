-- WORKSPACE-SCOPE CONVERGENCE — split the two meanings of a NULL `team_id`.
--
-- THE DEFECT
-- ----------
-- `operational_incidents.team_id` is nullable, and one absence carried two
-- incompatible meanings: an incident that belongs to no tenant, and an ORPHAN
-- produced by the `ON DELETE SET NULL` foreign key when a workspace is deleted.
-- Four tenant reads asked for `team_id = :workspace OR team_id IS NULL` in
-- order to pick up the first, and therefore also returned every OTHER tenant's
-- orphans to whoever asked.
--
-- WHAT THIS BACKFILL DELIBERATELY DOES NOT DO
-- -------------------------------------------
-- It claims NOTHING as PLATFORM. There is no writer in this codebase that
-- records a deliberate platform-wide incident: the ONLY producer of a NULL team
-- id is `security-event.service.ts`, whose `input.teamId ?? null` records an
-- account-tier security event, not a platform declaration. Deriving PLATFORM
-- from a NULL would be inventing the exact intent this column exists to record.
-- Every existing NULL row therefore becomes LEGACY_UNSCOPED: retained in full,
-- visible in neither the tenant surface nor the platform surface, and available
-- for a human to classify deliberately later.
--
-- SAFETY
-- ------
--   * EXPAND-ONLY. A column is added with a default; no column is dropped, no
--     type narrowed, no row deleted, and the `ON DELETE SET NULL` foreign key
--     is left exactly as it is — proving the retention and deletion
--     requirements that would justify changing it is a separate piece of work,
--     and a destructive FK change made on the way past is how incident history
--     disappears.
--   * IDEMPOTENT. Every statement is guarded, so a partial apply can be re-run.
--   * READER-COMPATIBLE. An API process that predates this column ignores it
--     and keeps its previous behaviour; the new predicate is additive.
--
-- ROLLBACK / RECOVERY
-- -------------------
-- Backward step (safe, loses only the discriminator):
--     ALTER TABLE "operational_incidents" DROP COLUMN IF EXISTS "scope";
--     DROP INDEX IF EXISTS "operational_incidents_scope_team_status_idx";
--     DROP TYPE IF EXISTS "IncidentScope";
-- No incident row is destroyed by that, and re-applying this migration
-- reproduces the identical classification from `team_id` alone — the backfill
-- is a pure function of data that is still present.
--
-- Re-classifying a LEGACY_UNSCOPED row later is a deliberate, audited UPDATE by
-- id; it is not something a migration should guess at in bulk.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentScope') THEN
    CREATE TYPE "IncidentScope" AS ENUM ('WORKSPACE', 'PLATFORM', 'LEGACY_UNSCOPED');
  END IF;
END
$$;

ALTER TABLE "operational_incidents"
  ADD COLUMN IF NOT EXISTS "scope" "IncidentScope" NOT NULL DEFAULT 'WORKSPACE';

-- The classification. `team_id IS NOT NULL` rows are already WORKSPACE by the
-- column default above; only the ambiguous ones move.
UPDATE "operational_incidents"
   SET "scope" = 'LEGACY_UNSCOPED'
 WHERE "team_id" IS NULL
   AND "scope" <> 'LEGACY_UNSCOPED';

-- The index is wrapped in a column-existence guard, and that is not
-- ceremony. It references `scope`, which this same migration creates, so on
-- any database where the ADD COLUMN above was skipped (a partial apply, a
-- re-run, a replica mid-rollout) an unguarded CREATE INDEX would fail on a
-- column that is not there yet and abort the migration. The safety gate
-- (`scripts/migration-risk-scan.mjs`, pinned by
-- `phase-o-migration-safety-gate.test.ts`) classifies the unguarded form as
-- CRITICAL for exactly that reason.
-- EVERY column the index touches is checked, not only the new one. The gate
-- treats a partial guard as no guard, and it is right to: an index over three
-- columns fails if ANY of them is absent, so verifying one of the three proves
-- nothing about whether the statement can run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'scope'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "operational_incidents_scope_team_status_idx" ON "operational_incidents" ("scope", "team_id", "status")';
  END IF;
END $$;
