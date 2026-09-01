-- =============================================================================
-- ADM-013 PHASE 4 — PLATFORM INCIDENT UNIQUENESS.
--
-- WHAT THIS ENFORCES
-- -----------------------------------------------------------------------------
-- `operational_incidents` carries `@@unique([teamId, fingerprint])`, and every
-- reader assumes that means one row per condition per workspace AND one row per
-- platform condition. It means the first and not the second: a standard
-- Postgres unique index treats NULL as distinct from NULL, so `(NULL, 'x')` and
-- `(NULL, 'x')` are two different keys. Measured against a fully-migrated
-- PostgreSQL 16 before this was written — both rows insert, no error.
--
-- A partial unique index on `(fingerprint) WHERE team_id IS NULL` closes it.
--
-- WHY THIS MIGRATION CONTAINS NO DELETE
-- -----------------------------------------------------------------------------
-- A unique index cannot be created over existing duplicates, so a database that
-- has them must CONVERGE first — and convergence merges and then deletes rows.
-- That is irreversible, and this repository's own migration safety gate
-- classifies `DELETE FROM` in a post-baseline migration as CRITICAL with no
-- guarded form. It is right to: a release should not quietly merge production
-- records while nobody is watching.
--
-- So the two halves are split by AUDIENCE, not by convenience:
--
--   this migration          creates the index, and refuses to proceed if it
--                           cannot — safe to run unattended
--   scripts/incident-convergence.mjs
--                           merges duplicates, after a reviewed dry-run and an
--                           explicit operator decision
--
-- WHY IT FAILS LOUDLY RATHER THAN SKIPPING
-- -----------------------------------------------------------------------------
-- The tempting shape is `IF no duplicates THEN create END IF` — apply on a
-- clean database, no-op on a dirty one. That is the worst of the options: the
-- deploy goes green, the invariant is silently unenforced on exactly the
-- database that needed it, and nobody finds out until two rows appear again.
--
-- A `RAISE EXCEPTION` naming the remediation is the honest behaviour. On a
-- clean or already-converged database this migration applies without comment.
-- On one carrying duplicates it stops the deploy and says precisely what to run
-- — which is the correct outcome, because shipping code that assumes an
-- invariant onto a database that does not hold it is the defect, not the
-- stopped deploy.
--
-- IDEMPOTENT: `CREATE UNIQUE INDEX IF NOT EXISTS`. Re-running after the
-- operator script has already created the index is a no-op.
-- =============================================================================

DO $$
DECLARE
  duplicate_groups INTEGER;
  duplicate_rows   INTEGER;
BEGIN
  -- ---------------------------------------------------------------------------
  -- The columns the index names must exist. The migration safety gate requires
  -- an information_schema guard for every column an index references that the
  -- same migration did not add, and the guard is not ceremony: an index over a
  -- column that is not there fails mid-deploy with "column does not exist",
  -- which is a far worse message than the one below.
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'fingerprint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'team_id'
  ) THEN
    RAISE EXCEPTION
      'operational_incidents is missing fingerprint or team_id — refusing to '
      'create a uniqueness index against a schema this migration does not '
      'recognise.';
  END IF;

  -- Already enforced (the operator script may have created it). Nothing to do.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'operational_incidents_platform_fingerprint_uk'
  ) THEN
    RAISE NOTICE
      'operational_incidents_platform_fingerprint_uk already exists — no-op.';
    RETURN;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(n - 1), 0)
    INTO duplicate_groups, duplicate_rows
    FROM (
      SELECT fingerprint, COUNT(*)::int AS n
        FROM "operational_incidents"
       WHERE team_id IS NULL
       GROUP BY fingerprint
      HAVING COUNT(*) > 1
    ) g;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'Cannot create the platform incident uniqueness index: % duplicate fingerprint group(s) covering % excess row(s) exist with team_id IS NULL.',
      duplicate_groups, duplicate_rows
      USING
        DETAIL =
          'A unique index cannot be created over existing duplicates. The '
          'convergence merges each group onto its OLDEST row, preserving '
          'first-seen, last-seen, occurrence total, worst severity (by rank, '
          'never lexical MAX), every timeline event, every SLA cycle and every '
          'referencing relation, and records a merged event naming the ids it '
          'folded. It is deliberately NOT part of this migration: it deletes '
          'production rows, and that decision belongs to an operator who has '
          'read the dry-run — not to an unattended deploy.',
        HINT =
          'Run: node services/api/scripts/incident-convergence.mjs --dry-run  '
          '(read-only, reports every duplicate group, child relation count, SLA '
          'collision and the exact index it would create). Then, once reviewed: '
          'node services/api/scripts/incident-convergence.mjs --apply';
  END IF;

  -- ---------------------------------------------------------------------------
  -- The column guard, ADJACENT to the statement it protects.
  --
  -- The same check runs at the top of this block for the operator-facing
  -- refusal. It is repeated here because `full-migration-audit.mjs` reads the
  -- 800 characters preceding a CREATE INDEX looking for an
  -- `information_schema.columns … column_name = 'X'` guard for every column the
  -- index names, and the long RAISE above pushes the first check out of that
  -- window. The gate is right to want adjacency rather than a guard somewhere
  -- in the same file: a check fifty lines and three branches away is a check
  -- that a later edit can separate from what it guards without noticing.
  -- ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'fingerprint'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'team_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_platform_fingerprint_uk"
      ON "operational_incidents" ("fingerprint")
      WHERE "team_id" IS NULL;
  ELSE
    RAISE EXCEPTION
      'operational_incidents lost fingerprint or team_id between the check at '
      'the top of this block and the index creation — refusing.';
  END IF;

  RAISE NOTICE
    'operational_incidents_platform_fingerprint_uk created — one row per '
    'platform-scope condition is now enforced by the database.';
END$$;
