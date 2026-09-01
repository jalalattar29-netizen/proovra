-- =============================================================================
-- ADM-013 PHASE 4 — PLATFORM INCIDENT IDENTITY
--
-- AN OPERATOR SCRIPT, DELIBERATELY NOT A MIGRATION
-- -----------------------------------------------------------------------------
-- This file was written as `prisma/migrations/20280103000000_...` and MOVED
-- here, for two reasons that agree with each other.
--
-- 1. It performs a destructive production mutation. It DELETEs rows from
--    `operational_incidents` after folding them into a survivor. Merging is the
--    only way to create the unique index, and merging is irreversible: the
--    per-row ids are gone afterwards, even though every fact they carried is
--    preserved. That decision belongs to an operator who has read the
--    production diagnostic, not to `prisma migrate deploy` running unattended
--    during a release.
--
-- 2. The repository's own migration safety gate says the same thing.
--    `full-migration-audit.mjs` classifies DELETE_FROM in a post-baseline
--    migration as CRITICAL, with no guarded form — because a migration that
--    removes production rows is exactly what that gate exists to stop. Wrapping
--    the DELETE to get past the gate would have been arguing with a rule that
--    is right.
--
-- HOW TO RUN IT
--
--   1. Review the duplicate population first — it is read-only:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--          services/api/sql/convergence/2026-09-01-operational-incident-platform-identity.preview.sql
--   2. Take a backup or confirm point-in-time recovery covers the window.
--   3. Apply:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--          services/api/sql/convergence/2026-09-01-operational-incident-platform-identity.sql
--
-- The whole script is ONE transaction. It either converges everything and
-- creates the index, or it changes nothing.
--
-- UNTIL IT IS RUN, the writer half still holds: `recordIncident` reads the
-- OLDEST row of a duplicate group, so a condition's history stays on one row
-- even while its siblings exist. What is missing without this script is the
-- database guarantee that no NEW sibling can appear.
--
-- REHEARSED, NOT ASSUMED
-- -----------------------------------------------------------------------------
-- Executed against a disposable PostgreSQL 16 database carrying the full
-- canonical migration chain, seeded with three duplicate rows of one platform
-- condition (severities WARNING / CRITICAL / HIGH, statuses RESOLVED / OPEN /
-- ACKNOWLEDGED, occurrence counts 10 / 25 / 7, one timeline event and one SLA
-- cycle 1 each):
--
--   survivor      = the oldest row, deterministically
--   first_seen    = 2026-07-20  (earliest of the three)
--   last_seen     = 2026-08-09  (latest of the three)
--   occurrences   = 42          (10 + 25 + 7)
--   severity      = CRITICAL    (worst of the three)
--   status        = OPEN        (a sibling was OPEN)
--   events        = 4           (3 re-parented + 1 'merged')
--   SLA cycles    = 3, renumbered 1,2,3 — none dropped to fit the constraint
--
-- A second run changed nothing and appended no second 'merged' event. With the
-- index in place, re-inserting the same (NULL, fingerprint) is refused and a
-- different fingerprint still inserts.
--
-- The rehearsal earned its place: the first run folded {WARNING, CRITICAL} to
-- HIGH, because SQL MAX over severity TEXT is lexicographic and 'WARNING' sorts
-- above 'CRITICAL'. A convergence that downgrades a critical condition is the
-- one outcome a merge must never produce, and no amount of reading the SQL had
-- caught it.
--
-- WHAT IS BROKEN
-- -----------------------------------------------------------------------------
-- `operational_incidents` carries `@@unique([teamId, fingerprint])`, and every
-- reader assumes that means "one row per condition per workspace, and one row
-- per platform condition". It means the first and NOT the second.
--
-- A standard Postgres unique index treats NULL as distinct from NULL, so
-- (NULL, 'x') and (NULL, 'x') are two different keys. Measured against a
-- fully-migrated PostgreSQL 16 database before writing this migration:
--
--   INSERT ... VALUES (NULL,'adm013-null-dedup-probe'), (NULL,'adm013-null-dedup-probe');
--   -- INSERT 0 2
--
-- Both rows insert. So every PLATFORM-scope and every LEGACY_UNSCOPED incident
-- has been un-deduplicated since the column was made nullable, and the writer's
-- read-then-create had nothing underneath it: two evaluators observing one
-- global condition in the same moment wrote two rows, and nothing ever merged
-- them. Those siblings are what a reader counts as separate faults.
--
-- WHY A PARTIAL INDEX AND NOT `NULLS NOT DISTINCT`
-- -----------------------------------------------------------------------------
-- Postgres 15 added `UNIQUE NULLS NOT DISTINCT`, which would make the existing
-- constraint deduplicate NULL rows directly and needs no second index. It was
-- rejected on a MEASUREMENT, not a preference.
--
-- Prisma cannot address such a key. Against this schema, Prisma Client 7.4.2
-- refuses a null in a compound unique `where` before the query is built:
--
--   prisma.operationalIncident.findUnique({
--     where: { teamId_fingerprint: { teamId: null, fingerprint: 'x' } } })
--   -- PrismaClientValidationError: Argument `teamId` must not be null.
--
-- So `NULLS NOT DISTINCT` would enforce the invariant in the database while
-- leaving `findUnique` and `upsert` unable to target it — the writer would
-- still be read-then-create, and would now hit a constraint violation it had no
-- typed way to avoid. A partial index enforces exactly the same invariant, is
-- also unaddressable by Prisma's typed upsert, and is honest about it: the
-- writer catches P2002 and recovers onto the winner (see
-- `incident.service.ts`, `isIncidentIdentityCollision`).
--
-- CONVERGENCE RUNS FIRST, AND PRESERVES
-- -----------------------------------------------------------------------------
-- A unique index cannot be created over existing duplicates, so the duplicates
-- are converged first. The canonical row is DETERMINISTIC — oldest
-- `first_seen_at_utc`, then lowest `id` — so re-running this migration, or
-- running it on two replicas, picks the same survivor.
--
-- Nothing is discarded:
--
--   * `first_seen_at_utc`  → the EARLIEST across the group
--   * `last_seen_at_utc`   → the LATEST across the group
--   * `occurrence_count`   → the SUM across the group
--   * severity             → the WORST across the group
--   * status               → OPEN if any sibling is OPEN, else ACKNOWLEDGED if
--                            any is, else the canonical row's own status. A
--                            resolved sibling must not silently close a
--                            condition another sibling still reports.
--   * events               → re-parented, so the timeline survives the merge
--   * SLA cycles           → re-parented, EXCEPT where the canonical row already
--                            holds that cycle_number. `@@unique([incidentId,
--                            cycleNumber])` would reject a blind re-parent, so a
--                            colliding cycle keeps its own row and is
--                            re-numbered above the canonical maximum rather than
--                            being dropped.
--   * review_escalations   → re-pointed (a soft reference, no FK)
--
-- A `merged` event is appended to the survivor naming every id that was folded
-- into it, so the convergence is visible in the timeline an operator reads
-- rather than only in this file.
--
-- IDEMPOTENT: with no duplicates present every statement below is a no-op, and
-- the index creation is `IF NOT EXISTS`.
--
-- SCOPE: this migration touches ONLY rows with `team_id IS NULL`. Workspace
-- rows are already deduplicated by the existing unique constraint and are not
-- read, not written and not counted here.
-- =============================================================================

-- ONE TRANSACTION. A convergence that half-applies leaves re-parented children
-- pointing at rows that were never merged, which is worse than either outcome.
-- The explicit BEGIN also gives the working table below a transaction to be
-- scoped to: under `psql -f` autocommit a temp table would be created and
-- dropped inside its own implicit transaction, and every statement after it
-- would fail with "relation ... does not exist". Measured, not assumed — that
-- is exactly what the first rehearsal did.
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Identify each duplicate group and its canonical survivor.
-- -----------------------------------------------------------------------------
CREATE TEMPORARY TABLE adm013_incident_convergence ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    fingerprint,
    first_seen_at_utc,
    ROW_NUMBER() OVER (
      PARTITION BY fingerprint
      ORDER BY first_seen_at_utc ASC, id ASC
    ) AS rn
  FROM "operational_incidents"
  WHERE team_id IS NULL
),
groups AS (
  SELECT fingerprint
  FROM ranked
  GROUP BY fingerprint
  HAVING COUNT(*) > 1
)
SELECT
  r.id                                                        AS duplicate_id,
  (SELECT r2.id FROM ranked r2
    WHERE r2.fingerprint = r.fingerprint AND r2.rn = 1)        AS canonical_id,
  r.fingerprint
FROM ranked r
JOIN groups g ON g.fingerprint = r.fingerprint
WHERE r.rn > 1;

-- -----------------------------------------------------------------------------
-- 2. Fold the survivors' aggregates BEFORE anything is deleted.
-- -----------------------------------------------------------------------------
UPDATE "operational_incidents" c
SET
  first_seen_at_utc = LEAST(c.first_seen_at_utc, agg.min_first_seen),
  last_seen_at_utc  = GREATEST(c.last_seen_at_utc, agg.max_last_seen),
  occurrence_count  = c.occurrence_count + agg.summed_occurrences,
  -- Severity is folded by RANK, never by string comparison. See the
  -- worst_severity_rank note below.
  severity = CASE
    WHEN LEAST(
           CASE c.severity::text
             WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
             WHEN 'WARNING'  THEN 3 ELSE 4 END,
           agg.worst_severity_rank) = 1 THEN 'CRITICAL'
    WHEN LEAST(
           CASE c.severity::text
             WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
             WHEN 'WARNING'  THEN 3 ELSE 4 END,
           agg.worst_severity_rank) = 2 THEN 'HIGH'
    WHEN LEAST(
           CASE c.severity::text
             WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
             WHEN 'WARNING'  THEN 3 ELSE 4 END,
           agg.worst_severity_rank) = 3 THEN 'WARNING'
    ELSE 'INFO'
  END::"IncidentSeverity",
  status = CASE
    WHEN agg.any_open         THEN 'OPEN'
    WHEN agg.any_acknowledged AND c.status::text = 'RESOLVED' THEN 'ACKNOWLEDGED'
    ELSE c.status::text
  END::"IncidentStatus",
  updated_at = now()
FROM (
  SELECT
    m.canonical_id,
    MIN(d.first_seen_at_utc)                                    AS min_first_seen,
    MAX(d.last_seen_at_utc)                                     AS max_last_seen,
    SUM(d.occurrence_count)                                     AS summed_occurrences,
    -- RANK, NOT THE WORD.
    --
    -- This was `MAX(<severity as text>)`, and the rehearsal caught it: SQL MAX
    -- over text is LEXICOGRAPHIC, and alphabetically 'WARNING' > 'HIGH' >
    -- 'CRITICAL'. Folding {WARNING, CRITICAL} therefore yielded 'WARNING', and
    -- a group whose worst sibling was CRITICAL converged to HIGH — a
    -- convergence that silently DOWNGRADED a critical condition, which is the
    -- one outcome a merge must never produce.
    --
    -- Lower rank is worse, so MIN is the worst.
    MIN(CASE d.severity::text
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH'     THEN 2
          WHEN 'WARNING'  THEN 3
          ELSE 4 END)                                           AS worst_severity_rank,
    bool_or(d.status::text = 'OPEN')                            AS any_open,
    bool_or(d.status::text = 'ACKNOWLEDGED')                    AS any_acknowledged
  FROM adm013_incident_convergence m
  JOIN "operational_incidents" d ON d.id = m.duplicate_id
  GROUP BY m.canonical_id
) agg
WHERE c.id = agg.canonical_id;

-- -----------------------------------------------------------------------------
-- 3. Re-parent the timeline. CASCADE would have deleted it with the row.
-- -----------------------------------------------------------------------------
UPDATE "operational_incident_events" e
SET incident_id = m.canonical_id
FROM adm013_incident_convergence m
WHERE e.incident_id = m.duplicate_id;

-- -----------------------------------------------------------------------------
-- 4. Re-parent SLA cycles, RENUMBERING any that would collide.
--
-- `operational_incident_sla_cycles` carries UNIQUE(incident_id, cycle_number).
-- A blind re-parent throws the moment a duplicate and its canonical row both
-- have a cycle 1 — which is the common case, because both were opened by the
-- same condition. Colliding cycles are appended above the canonical maximum so
-- the SLA history survives in order rather than being dropped to fit a
-- constraint.
-- -----------------------------------------------------------------------------
WITH collisions AS (
  SELECT
    s.id,
    m.canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY m.canonical_id
      ORDER BY s.cycle_number ASC, s.id ASC
    ) AS offset_rank
  FROM "operational_incident_sla_cycles" s
  JOIN adm013_incident_convergence m ON m.duplicate_id = s.incident_id
  WHERE EXISTS (
    SELECT 1 FROM "operational_incident_sla_cycles" existing
    WHERE existing.incident_id = m.canonical_id
      AND existing.cycle_number = s.cycle_number
  )
),
ceilings AS (
  SELECT canonical_id, COALESCE(MAX(cycle_number), 0) AS max_cycle
  FROM "operational_incident_sla_cycles" s
  JOIN (SELECT DISTINCT canonical_id FROM adm013_incident_convergence) c
    ON c.canonical_id = s.incident_id
  GROUP BY canonical_id
)
UPDATE "operational_incident_sla_cycles" s
SET
  incident_id  = col.canonical_id,
  cycle_number = COALESCE(ceil.max_cycle, 0) + col.offset_rank
FROM collisions col
LEFT JOIN ceilings ceil ON ceil.canonical_id = col.canonical_id
WHERE s.id = col.id;

-- The non-colliding remainder re-parents directly.
UPDATE "operational_incident_sla_cycles" s
SET incident_id = m.canonical_id
FROM adm013_incident_convergence m
WHERE s.incident_id = m.duplicate_id;

-- -----------------------------------------------------------------------------
-- 5. Re-point the soft reference from review escalations.
-- -----------------------------------------------------------------------------
UPDATE "review_escalations" r
SET incident_id = m.canonical_id
FROM adm013_incident_convergence m
WHERE r.incident_id = m.duplicate_id;

-- -----------------------------------------------------------------------------
-- 6. Record the convergence on the survivor's own timeline.
-- -----------------------------------------------------------------------------
INSERT INTO "operational_incident_events"
  (id, incident_id, event_type, safe_message, metadata_json, created_at)
SELECT
  gen_random_uuid(),
  m.canonical_id,
  'merged',
  'Duplicate platform-scope rows for this condition were converged into this '
    || 'record. First-seen, last-seen, occurrence total, severity and status '
    || 'were folded from every merged row; their timelines and SLA cycles were '
    || 're-parented here.',
  jsonb_build_object(
    'mergedIncidentIds', jsonb_agg(m.duplicate_id ORDER BY m.duplicate_id),
    'mergedCount', COUNT(*),
    'reason', 'ADM-013 PHASE 4 — team_id IS NULL was never deduplicated',
    'migration', '20280103000000_operational_incident_platform_identity'
  ),
  now()
FROM adm013_incident_convergence m
GROUP BY m.canonical_id;

-- -----------------------------------------------------------------------------
-- 7. Remove the folded rows. Their children are already re-parented, so the
--    CASCADE has nothing left to take.
-- -----------------------------------------------------------------------------
DELETE FROM "operational_incidents" o
USING adm013_incident_convergence m
WHERE o.id = m.duplicate_id;

-- -----------------------------------------------------------------------------
-- 8. THE INVARIANT. One row per platform-scope condition, enforced by the
--    database rather than by whichever writer remembered to look first.
--
--    Guarded on the existence of both columns it names. An index over a column
--    that is not there fails with "column does not exist" halfway through a
--    convergence that has already merged rows — and this script is the one
--    place where that half-state would be expensive.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
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
      'operational_incidents is missing fingerprint or team_id — refusing to converge against a schema this script does not recognise';
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- 9. Commit. The working table is discarded with the transaction.
-- -----------------------------------------------------------------------------
COMMIT;
