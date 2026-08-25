-- =============================================================================
-- OPERATIONAL INCIDENT LEGACY COLUMN DROP — the contract half of the
-- convergence.
-- =============================================================================
--
-- The expand half is `20271224000000_operational_incident_naming_convergence`.
-- It backfilled every canonical column from its legacy twin, PROVED that no row
-- holds a legacy value its canonical column lacks, relaxed the NOT NULLs that
-- were failing every INSERT with 23502, and rebuilt the unique, the indexes and
-- the foreign key on the canonical columns. It removed nothing.
--
-- This migration removes the columns.
--
-- WHY IT IS SEPARATE, AND WHY IT COMES AFTER THE CODE
-- ---------------------------------------------------------------------------
-- `scripts/verify-migration-artifact.mjs` refuses a CONTRACT_DROP that actually
-- removes something unless it declares `safeBeforeCodeDeployment: false`, and
-- that rule is the reason this file exists. Folding the drop into the expand
-- migration would have forced one of two false statements: either the combined
-- migration is safe before the code — it removes things, so the gate says no —
-- or it must wait for the code, but the writer is broken until it runs, so
-- waiting is exactly backwards.
--
-- Splitting them makes both statements true. The expand migration is safe
-- before the code and fixes production immediately; this one waits, because a
-- removal should always wait.
--
-- WHAT IS ACTUALLY BEING REMOVED
-- ---------------------------------------------------------------------------
-- Duplicate columns that NO shipped Prisma client reads or writes. Every client
-- since these fields gained `@map` addresses the canonical snake_case columns
-- exclusively; the legacy family is an artifact of the generation before that,
-- documented on other tables by
-- `20260620200000_reviewer_ops_naming_drift_repair` and left in place there as
-- a rollback path, with the cleanup deferred to "a separate cleanup migration".
-- This is that migration, for the incident tables.
--
-- PRECONDITIONS, RE-CHECKED HERE RATHER THAN ASSUMED
-- ---------------------------------------------------------------------------
-- The expand migration proved conservation at the moment it ran. Time passes
-- between the two waves — that is the entire point of a two-wave contract — so
-- the same proof runs again immediately before the drop. A row written in
-- between by something nobody expected is exactly what this re-check is for.
--
-- IDEMPOTENT and FORWARD-ONLY. Every drop is `IF EXISTS`, so on any database
-- that never carried the legacy family — every clean boot, CI, and every
-- environment created after the drift — this migration does nothing at all.
--
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- There is none, and there should not be: re-creating the legacy columns would
-- re-create the fault. Rolling application images back is unaffected, because
-- no image reads these columns. The rollback path this migration closes is the
-- one `20260620200000` opened and nobody ever used.

-- ---------------------------------------------------------------------------
-- 1. RE-PROVE conservation, on the data as it stands NOW.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pair      RECORD;
  orphaned  BIGINT;
  total     BIGINT := 0;
  report    TEXT := '';
BEGIN
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
    ) INTO orphaned;
    IF orphaned > 0 THEN
      total := total + orphaned;
      report := report || format('%s.%s -> %s: %s row(s); ', pair.tbl, pair.legacy, pair.canonical, orphaned);
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop: % row(s) hold a LEGACY value their canonical column lacks. %Dropping now would destroy the only copy. Re-run 20271224000000, which backfills, confirm, then re-run this.',
      total, report;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. DROP the legacy family.
--
-- Dropping a column drops the indexes and constraints that depend on it, which
-- is why 20271224000000 created the canonical replacements FIRST. `IF EXISTS`
-- makes every one of these a no-op on a database that never drifted.
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
-- 3. Post-condition: the legacy family is gone, and the canonical guarantees
--    that replaced it are still standing.
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
    RAISE EXCEPTION 'drop incomplete: mixed-case columns remain: %', leftovers;
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
    RAISE EXCEPTION 'drop incomplete: no UNIQUE index covers (team_id, fingerprint).';
  END IF;
END
$$;
