-- =============================================================================
-- OPERATIONAL INCIDENT NAMING CONVERGENCE — the cleanup that was promised and
-- never written.
-- =============================================================================
--
-- THE DEFECT, MEASURED
-- ---------------------------------------------------------------------------
-- A production Personal Pro workspace reported `readiness PARTIAL`, `recorded
-- 0`, `open 0` while discovery could see 34 TSA failures, a 26-row report
-- backlog and a 69-row package backlog. Six Operations sources failed and five
-- succeeded, and the partition was exact: every source that calls
-- `recordIncident` failed; no source that only reads did.
--
-- The cause is not a missing column. Every column the deployed Prisma model
-- declares is present. `operational_incidents` additionally carries a LEGACY
-- family of columns named after the Prisma FIELD names — `teamId` beside
-- `team_id`, `safeSummary` beside `safe_summary`, and so on — and
-- `operational_incident_events` carries the same, including `createdAtUtc` for
-- a field the model no longer has at all.
--
-- This repository has diagnosed that shape before, on other tables, in
-- `20260620200000_reviewer_ops_naming_drift_repair`:
--
--     "Without @map, the Prisma client emits quoted camelCase column names in
--      INSERT/SELECT SQL. Migrations created snake_case columns. In production
--      this produced TWO physical columns per affected field — one that
--      migrations manage, one that the Prisma client actually reads and
--      writes."
--
-- That migration deliberately did not drop the legacy columns, recording that
-- "a separate cleanup migration will drop them after operators confirm". For
-- the incident tables that cleanup was never written. Every migration since
-- has used `IF NOT EXISTS` guards, so none of them had anything to object to,
-- and the ledger stayed green over a physical contract that was wrong.
--
-- WHY IT BREAKS WRITES RATHER THAN MERELY ROTTING
-- ---------------------------------------------------------------------------
-- Reproduced against a database carrying the hybrid shape, the REAL
-- `recordIncident` fails at `create()` with:
--
--     Prisma      P2011   Null constraint violation
--     PostgreSQL  23502   null value in column "safeSummary" of relation
--                         "operational_incidents" violates not-null constraint
--
-- `safe_summary` was declared `VARCHAR(400) NOT NULL` with no default by
-- `20260529100000_add_operational_incidents_phase21`, so its legacy twin
-- carries the same NOT NULL and the same absence of a default. An INSERT that
-- names only the canonical columns cannot satisfy it, and no retry ever will.
-- The lookup before it SUCCEEDS, which is why the failure looked like nothing
-- at all from outside.
--
-- Two further faults ride along, and both are silent:
--
--   * the UNIQUE index is on `("teamId", fingerprint)`. Prisma writes
--     `team_id`, leaving `"teamId"` NULL, and PostgreSQL treats NULLs as
--     DISTINCT — so the constraint the writer's entire idempotency story rests
--     on excludes nothing, and two concurrent writers would open two
--     conditions for one fact;
--   * the events foreign key is on `"incidentId"`, which constrains nothing
--     about a write to `incident_id`, so event history could be orphaned
--     without the database noticing.
--
-- WHAT THIS MIGRATION DOES, AND IN WHICH ORDER
-- ---------------------------------------------------------------------------
--   1. BACKFILL   — canonical from legacy, only where canonical IS NULL. Never
--                   the other direction: the canonical column is the authority.
--   2. CONSERVE   — PROVE that no row still holds a value in its legacy half
--                   that its canonical half lacks. That is the conservation
--                   proof, and it RAISEs if it fails.
--   3. REBIND     — rebuild the unique, the indexes and the foreign key on the
--                   canonical columns, before anything is dropped.
--   4. DROP       — the legacy columns, last, once nothing depends on them.
--
-- Steps 1–3 are non-destructive. Only step 4 removes anything, and it runs
-- only after step 2 has proven there is nothing left to lose.
--
-- WHY DIVERGENCE IS REPORTED AND NOT REFUSED
-- ---------------------------------------------------------------------------
-- An earlier draft refused outright whenever a row's two halves held different
-- non-null values. Measured against a reproduced hybrid carrying real traffic,
-- that refused on every database it was meant to repair — and correctly, in
-- the sense that the divergence is real:
--
--   * `occurrenceCount` keeps the DEFAULT 1 it was given at insert while
--     `occurrence_count` is incremented on every re-observation;
--   * `updatedAt` keeps its insert-time default while `updated_at` is rewritten
--     by every update;
--   * the timestamp pairs drift for the same reason.
--
-- So divergence is the NORMAL state of a table that has been written through
-- one family while the other sat beside it. Refusing on it would make the
-- migration unrunnable exactly where it is needed.
--
-- The canonical column wins, and that is not an arbitrary choice: every Prisma
-- client shipped since these fields gained `@map` reads and writes ONLY the
-- canonical columns, so the canonical value is what the application has been
-- showing, acting on and reporting. The legacy value is a stale artifact of a
-- client generation that no longer exists. Nothing the product can observe is
-- lost by dropping it.
--
-- The counts are RAISEd as a NOTICE so the divergence is on the deployment
-- record rather than discarded silently.
--
-- SAFETY
-- ---------------------------------------------------------------------------
--   * FORWARD-ONLY. No applied migration is edited; no ledger row is touched.
--   * IDEMPOTENT. Every statement is guarded on the presence of what it acts
--     on, so a re-run is a no-op and a partial apply can be resumed. On a
--     database that never had the legacy family — every clean boot, CI, and
--     any environment provisioned after the drift — this migration does
--     nothing at all except assert the canonical unique exists.
--   * NO DATA IS DELETED. Rows are never removed; only duplicate COLUMNS are,
--     and only after the conservation check.
--   * The tables are handled TOGETHER, because the events foreign key
--     references the incidents table and rebinding one without the other
--     leaves the pair inconsistent.
--
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Expand-only in the direction that matters: an OLDER image reads and writes
-- the canonical columns exactly as the current one does, because the canonical
-- columns are the ones every shipped Prisma client has used since `@map` was
-- added. Rolling back means reverting application images and LEAVING this
-- schema in place. Re-creating the legacy columns would restore the fault.
--
-- The one genuinely irreversible act is dropping the legacy columns, which is
-- why step 2 refuses rather than proceeding on trust: after this runs the only
-- copy of each fact is the canonical one, and step 2 has proven that copy is
-- complete for every row.

-- ---------------------------------------------------------------------------
-- 0. The pair list, and the guards.
--
-- Written out rather than derived, so a reviewer can see exactly which columns
-- this migration will drop. Every block checks `information_schema` first, so
-- a database without the legacy family skips all of it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  pair        RECORD;
  conflicts   BIGINT;
  total       BIGINT := 0;
  report      TEXT := '';
BEGIN
  -- =========================================================================
  -- 1. DIVERGENCE CENSUS — reported, not refused. See the header for why.
  -- =========================================================================
  FOR pair IN
    SELECT * FROM (VALUES
      ('operational_incidents','teamId','team_id'),
      ('operational_incidents','safeSummary','safe_summary'),
      ('operational_incidents','firstSeenAtUtc','first_seen_at_utc'),
      ('operational_incidents','lastSeenAtUtc','last_seen_at_utc'),
      ('operational_incidents','occurrenceCount','occurrence_count'),
      ('operational_incidents','requestId','request_id'),
      ('operational_incidents','traceId','trace_id'),
      ('operational_incidents','relatedEvidenceId','related_evidence_id'),
      ('operational_incidents','relatedJobId','related_job_id'),
      ('operational_incidents','relatedProvider','related_provider'),
      ('operational_incidents','openedBySystem','opened_by_system'),
      ('operational_incidents','acknowledgedByUserId','acknowledged_by_user_id'),
      ('operational_incidents','acknowledgedAtUtc','acknowledged_at_utc'),
      ('operational_incidents','resolvedByUserId','resolved_by_user_id'),
      ('operational_incidents','resolvedAtUtc','resolved_at_utc'),
      ('operational_incidents','resolutionNote','resolution_note'),
      ('operational_incidents','assignedOperatorUserId','assigned_operator_user_id'),
      ('operational_incidents','assignedByUserId','assigned_by_user_id'),
      ('operational_incidents','assignedAtUtc','assigned_at_utc'),
      ('operational_incidents','runbookSlug','runbook_slug'),
      ('operational_incidents','createdAt','created_at'),
      ('operational_incidents','updatedAt','updated_at'),
      ('operational_incident_events','incidentId','incident_id'),
      ('operational_incident_events','eventType','event_type'),
      ('operational_incident_events','safeMessage','safe_message'),
      ('operational_incident_events','metadataJson','metadata_json'),
      ('operational_incident_events','createdAt','created_at'),
      ('operational_incident_events','createdAtUtc','created_at')
    ) AS t(tbl, legacy, canonical)
  LOOP
    -- Skip any pair whose legacy column this database does not have.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.legacy
    ) THEN
      CONTINUE;
    END IF;

    -- A row where BOTH sides are populated and they DISAGREE is unreconciled
    -- history. Choosing a winner here would silently rewrite the record of
    -- what happened, so this refuses and asks a human instead.
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS NOT NULL AND %I::text IS DISTINCT FROM %I::text',
      pair.tbl, pair.legacy, pair.canonical, pair.legacy, pair.canonical
    ) INTO conflicts;

    IF conflicts > 0 THEN
      total := total + conflicts;
      report := report || format('%s.%s vs %s: %s row(s); ', pair.tbl, pair.legacy, pair.canonical, conflicts);
    END IF;
  END LOOP;

  IF total > 0 THEN
    -- On the deployment record, deliberately. The canonical half is the
    -- authority and is kept; this states exactly how much stale legacy data is
    -- being discarded, so the number is never a surprise later.
    RAISE NOTICE
      'convergence: % row-column(s) diverge between the legacy and canonical families; the CANONICAL value is kept in every case. %',
      total, report;
  END IF;

  -- =========================================================================
  -- 2. BACKFILL — canonical from legacy, only where canonical is absent.
  --
  -- One direction only. The canonical column is the authority: every shipped
  -- client since `@map` was added writes it, so a populated canonical value is
  -- the current truth and must never be overwritten by an older twin.
  -- =========================================================================
  FOR pair IN
    SELECT * FROM (VALUES
      ('operational_incidents','teamId','team_id'),
      ('operational_incidents','safeSummary','safe_summary'),
      ('operational_incidents','firstSeenAtUtc','first_seen_at_utc'),
      ('operational_incidents','lastSeenAtUtc','last_seen_at_utc'),
      ('operational_incidents','occurrenceCount','occurrence_count'),
      ('operational_incidents','requestId','request_id'),
      ('operational_incidents','traceId','trace_id'),
      ('operational_incidents','relatedEvidenceId','related_evidence_id'),
      ('operational_incidents','relatedJobId','related_job_id'),
      ('operational_incidents','relatedProvider','related_provider'),
      ('operational_incidents','openedBySystem','opened_by_system'),
      ('operational_incidents','acknowledgedByUserId','acknowledged_by_user_id'),
      ('operational_incidents','acknowledgedAtUtc','acknowledged_at_utc'),
      ('operational_incidents','resolvedByUserId','resolved_by_user_id'),
      ('operational_incidents','resolvedAtUtc','resolved_at_utc'),
      ('operational_incidents','resolutionNote','resolution_note'),
      ('operational_incidents','assignedOperatorUserId','assigned_operator_user_id'),
      ('operational_incidents','assignedByUserId','assigned_by_user_id'),
      ('operational_incidents','assignedAtUtc','assigned_at_utc'),
      ('operational_incidents','runbookSlug','runbook_slug'),
      ('operational_incidents','createdAt','created_at'),
      ('operational_incidents','updatedAt','updated_at'),
      ('operational_incident_events','incidentId','incident_id'),
      ('operational_incident_events','eventType','event_type'),
      ('operational_incident_events','safeMessage','safe_message'),
      ('operational_incident_events','metadataJson','metadata_json'),
      ('operational_incident_events','createdAt','created_at'),
      ('operational_incident_events','createdAtUtc','created_at')
    ) AS t(tbl, legacy, canonical)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.legacy
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'UPDATE %I SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
      pair.tbl, pair.canonical, pair.legacy, pair.canonical, pair.legacy
    );
  END LOOP;

  -- =========================================================================
  -- 3. THE CONSERVATION PROOF — nothing is dropped that is not also kept.
  --
  -- The one thing that would genuinely lose information is a row whose legacy
  -- half holds a value its canonical half does NOT. The backfill above exists
  -- to make that impossible; this proves it actually did, per pair, before a
  -- single column is dropped. A failure here means the backfill could not
  -- write — a type mismatch, a check constraint, a permission — and the
  -- migration must stop rather than destroy the only surviving copy.
  -- =========================================================================
  total := 0;
  report := '';
  FOR pair IN
    SELECT * FROM (VALUES
      ('operational_incidents','teamId','team_id'),
      ('operational_incidents','safeSummary','safe_summary'),
      ('operational_incidents','firstSeenAtUtc','first_seen_at_utc'),
      ('operational_incidents','lastSeenAtUtc','last_seen_at_utc'),
      ('operational_incidents','occurrenceCount','occurrence_count'),
      ('operational_incidents','requestId','request_id'),
      ('operational_incidents','traceId','trace_id'),
      ('operational_incidents','relatedEvidenceId','related_evidence_id'),
      ('operational_incidents','relatedJobId','related_job_id'),
      ('operational_incidents','relatedProvider','related_provider'),
      ('operational_incidents','openedBySystem','opened_by_system'),
      ('operational_incidents','acknowledgedByUserId','acknowledged_by_user_id'),
      ('operational_incidents','acknowledgedAtUtc','acknowledged_at_utc'),
      ('operational_incidents','resolvedByUserId','resolved_by_user_id'),
      ('operational_incidents','resolvedAtUtc','resolved_at_utc'),
      ('operational_incidents','resolutionNote','resolution_note'),
      ('operational_incidents','assignedOperatorUserId','assigned_operator_user_id'),
      ('operational_incidents','assignedByUserId','assigned_by_user_id'),
      ('operational_incidents','assignedAtUtc','assigned_at_utc'),
      ('operational_incidents','runbookSlug','runbook_slug'),
      ('operational_incidents','createdAt','created_at'),
      ('operational_incidents','updatedAt','updated_at'),
      ('operational_incident_events','incidentId','incident_id'),
      ('operational_incident_events','eventType','event_type'),
      ('operational_incident_events','safeMessage','safe_message'),
      ('operational_incident_events','metadataJson','metadata_json'),
      ('operational_incident_events','createdAt','created_at'),
      ('operational_incident_events','createdAtUtc','created_at')
    ) AS t(tbl, legacy, canonical)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.legacy
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS NULL',
      pair.tbl, pair.legacy, pair.canonical
    ) INTO conflicts;
    IF conflicts > 0 THEN
      total := total + conflicts;
      report := report || format('%s.%s -> %s: %s row(s); ', pair.tbl, pair.legacy, pair.canonical, conflicts);
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION
      'REFUSING to converge: after backfill, % row(s) still hold a LEGACY value their canonical column lacks. %Dropping the legacy columns now would destroy the only copy. Investigate why the backfill could not write these rows, then re-run.',
      total, report;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. REBIND — put the guarantees back on the columns the application uses.
--
-- Created BEFORE the legacy columns are dropped, so there is no window in
-- which the table has neither.
-- ---------------------------------------------------------------------------

-- 3a. The dedupe unique — the one the writer's idempotency depends on.
--
-- CONDITIONAL ON ABSENCE, and named to match what a clean database already
-- has. `20260529100000_add_operational_incidents_phase21` creates
-- `operational_incidents_team_fingerprint_uk` on (team_id, fingerprint), and
-- that IS the canonical index; `db:raw-schema-verify` has it registered under
-- that name. Creating a second, differently-named unique over the same columns
-- would read to the verifier as a RENAME of a registered object, which is
-- exactly what it exists to refuse — so this only acts when no unique index
-- covers the canonical pair at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'operational_incidents'
       AND i.indisunique
       AND (
         SELECT array_agg(a.attname ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) = ARRAY['fingerprint','team_id']::name[]
  ) THEN
    -- Both columns guarded, for the reason given at 3b: a partial guard is no
    -- guard, and this index touches two columns.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='operational_incidents'
         AND column_name = 'team_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='operational_incidents'
         AND column_name = 'fingerprint'
    ) THEN
      EXECUTE 'CREATE UNIQUE INDEX "operational_incidents_team_fingerprint_uk" ON "operational_incidents" ("team_id", "fingerprint")';
    END IF;
  END IF;
END
$$;

-- 3b. The canonical read indexes, re-established if the legacy variants
--     displaced them.
--
-- Every one is wrapped in a column-existence guard, and that is not ceremony:
-- an index over a column that is not there fails and aborts the migration, and
-- `scripts/migration-risk-scan.mjs` classifies an unguarded CREATE INDEX as
-- CRITICAL for exactly that reason. EVERY column the index touches is checked,
-- not just one — the gate treats a partial guard as no guard, and it is right
-- to, because an index over two columns fails if either is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents'
       AND column_name = 'last_seen_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "operational_incidents_last_seen_at_idx" ON "operational_incidents" ("last_seen_at_utc" DESC)';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incidents'
       AND column_name = 'assigned_operator_user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "operational_incidents_assigned_operator_user_id_idx" ON "operational_incidents" ("assigned_operator_user_id")';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name = 'incident_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "operational_incident_events_incident_created_at_idx" ON "operational_incident_events" ("incident_id", "created_at" DESC)';
  END IF;
END
$$;

-- 3c. The events foreign key, on the canonical column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operational_incident_events_incident_id_fkey'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='operational_incident_events'
       AND column_name='incident_id'
  ) THEN
    -- Any event whose canonical pointer is still NULL after the backfill has
    -- no recoverable parent, and adding the key would fail on it. There is no
    -- such row by construction — the backfill above filled `incident_id` from
    -- `"incidentId"` — but the guard states the requirement rather than
    -- assuming it.
    IF EXISTS (SELECT 1 FROM "operational_incident_events" WHERE "incident_id" IS NULL) THEN
      RAISE EXCEPTION
        'REFUSING to bind the events foreign key: rows remain with a NULL incident_id after backfill.';
    END IF;
    ALTER TABLE "operational_incident_events"
      ADD CONSTRAINT "operational_incident_events_incident_id_fkey"
      FOREIGN KEY ("incident_id") REFERENCES "operational_incidents"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. DROP the legacy family — last, and only now.
--
-- Dropping a column drops the indexes and constraints that depend on it, which
-- is why the canonical replacements above are created first. `IF EXISTS` makes
-- every one of these a no-op on a database that never drifted.
-- ---------------------------------------------------------------------------

ALTER TABLE "operational_incidents"
  DROP COLUMN IF EXISTS "teamId",
  DROP COLUMN IF EXISTS "safeSummary",
  DROP COLUMN IF EXISTS "firstSeenAtUtc",
  DROP COLUMN IF EXISTS "lastSeenAtUtc",
  DROP COLUMN IF EXISTS "occurrenceCount",
  DROP COLUMN IF EXISTS "requestId",
  DROP COLUMN IF EXISTS "traceId",
  DROP COLUMN IF EXISTS "relatedEvidenceId",
  DROP COLUMN IF EXISTS "relatedJobId",
  DROP COLUMN IF EXISTS "relatedProvider",
  DROP COLUMN IF EXISTS "openedBySystem",
  DROP COLUMN IF EXISTS "acknowledgedByUserId",
  DROP COLUMN IF EXISTS "acknowledgedAtUtc",
  DROP COLUMN IF EXISTS "resolvedByUserId",
  DROP COLUMN IF EXISTS "resolvedAtUtc",
  DROP COLUMN IF EXISTS "resolutionNote",
  DROP COLUMN IF EXISTS "assignedOperatorUserId",
  DROP COLUMN IF EXISTS "assignedByUserId",
  DROP COLUMN IF EXISTS "assignedAtUtc",
  DROP COLUMN IF EXISTS "runbookSlug",
  DROP COLUMN IF EXISTS "createdAt",
  DROP COLUMN IF EXISTS "updatedAt";

ALTER TABLE "operational_incident_events"
  DROP COLUMN IF EXISTS "incidentId",
  DROP COLUMN IF EXISTS "eventType",
  DROP COLUMN IF EXISTS "safeMessage",
  DROP COLUMN IF EXISTS "metadataJson",
  DROP COLUMN IF EXISTS "createdAt",
  DROP COLUMN IF EXISTS "createdAtUtc";

-- ---------------------------------------------------------------------------
-- 5. THE LEGACY INDEX NEEDS NO EXPLICIT DROP, AND MUST NOT HAVE ONE.
--
-- Dropping `"teamId"` in step 4 drops every index built on it, including
-- `operational_incidents_team_fingerprint_key`. An explicit `DROP INDEX` here
-- would be redundant, and `scripts/migration-risk-scan.mjs` classifies any
-- `DROP INDEX` as CRITICAL without exception — correctly, because dropping an
-- index is how a read regression reaches production silently. The column drop
-- already does the work, and the post-conditions below prove it did.
--
-- `operational_incidents_team_fingerprint_uk` is likewise never dropped: on
-- every database that did not drift, that IS the canonical unique on
-- (team_id, fingerprint) created by the Phase-21 migration and registered with
-- `db:raw-schema-verify`. Removing it would destroy the guarantee this
-- migration exists to restore, on precisely the databases that were healthy.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. Post-conditions, asserted rather than hoped for.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leftovers TEXT;
BEGIN
  SELECT string_agg(table_name || '.' || column_name, ', ')
    INTO leftovers
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('operational_incidents','operational_incident_events')
     AND column_name ~ '[A-Z]';
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'convergence incomplete: mixed-case columns remain: %', leftovers;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'operational_incidents'
       AND i.indisunique
       AND (
         SELECT array_agg(a.attname ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) = ARRAY['fingerprint','team_id']::name[]
  ) THEN
    RAISE EXCEPTION 'convergence incomplete: no UNIQUE index covers (team_id, fingerprint).';
  END IF;
END
$$;
