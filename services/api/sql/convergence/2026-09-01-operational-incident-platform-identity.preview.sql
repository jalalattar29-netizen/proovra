-- =============================================================================
-- ADM-013 PHASE 4 — CONVERGENCE PREVIEW. READ-ONLY.
--
-- Run this BEFORE the convergence script. It performs no write of any kind: no
-- INSERT, no UPDATE, no DELETE, no DDL, no temporary table. It answers the four
-- questions an operator needs answered before approving an irreversible merge:
--
--   1. How many platform-scope (team_id IS NULL) conditions have duplicates?
--   2. For each, which row survives, and what will the folded values become?
--   3. How much history is being re-parented?
--   4. Is there anything the convergence script cannot handle?
--
-- WHY A PREVIEW EXISTS AT ALL
-- -----------------------------------------------------------------------------
-- The convergence DELETEs rows. Every fact those rows carried is folded into
-- the survivor first — earliest first-seen, latest last-seen, summed
-- occurrences, worst severity, timeline, SLA cycles — but the per-row ids are
-- gone afterwards. That is not reversible by re-running anything, so the
-- population it will touch is shown before it touches it.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/convergence/2026-09-01-operational-incident-platform-identity.preview.sql
-- =============================================================================

\echo '=== 1. Duplicate platform-scope conditions ==================================='

SELECT
  fingerprint,
  COUNT(*)                      AS duplicate_rows,
  MIN(first_seen_at_utc)        AS earliest_first_seen,
  MAX(last_seen_at_utc)         AS latest_last_seen,
  SUM(occurrence_count)         AS folded_occurrence_total,
  -- Lower rank is worse. Folded by RANK and not by the word: SQL MAX over
  -- severity text is lexicographic, and 'WARNING' sorts above 'CRITICAL'.
  (ARRAY['CRITICAL','HIGH','WARNING','INFO'])[
    MIN(CASE severity::text
          WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
          WHEN 'WARNING'  THEN 3 ELSE 4 END)
  ]                             AS folded_severity,
  CASE
    WHEN bool_or(status::text = 'OPEN')         THEN 'OPEN'
    WHEN bool_or(status::text = 'ACKNOWLEDGED') THEN 'ACKNOWLEDGED'
    ELSE 'unchanged (survivor keeps its own)'
  END                           AS folded_status,
  string_agg(DISTINCT source_id, ', ')          AS source_ids,
  string_agg(DISTINCT scope::text, ', ')        AS scopes
FROM "operational_incidents"
WHERE team_id IS NULL
GROUP BY fingerprint
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, fingerprint;

\echo ''
\echo '=== 2. Totals ================================================================'

WITH ranked AS (
  SELECT id, fingerprint,
         ROW_NUMBER() OVER (PARTITION BY fingerprint
                            ORDER BY first_seen_at_utc ASC, id ASC) AS rn
  FROM "operational_incidents"
  WHERE team_id IS NULL
),
dupes AS (
  SELECT r.id, r.fingerprint
  FROM ranked r
  WHERE r.rn > 1
    AND EXISTS (SELECT 1 FROM ranked r2
                WHERE r2.fingerprint = r.fingerprint AND r2.rn > 1)
)
SELECT
  (SELECT COUNT(*) FROM "operational_incidents" WHERE team_id IS NULL)
    AS platform_scope_rows_total,
  (SELECT COUNT(DISTINCT fingerprint) FROM dupes)
    AS conditions_with_duplicates,
  (SELECT COUNT(*) FROM dupes)
    AS rows_that_will_be_merged_away,
  (SELECT COUNT(*) FROM "operational_incident_events" e
     JOIN dupes d ON d.id = e.incident_id)
    AS timeline_events_to_re_parent,
  (SELECT COUNT(*) FROM "operational_incident_sla_cycles" s
     JOIN dupes d ON d.id = s.incident_id)
    AS sla_cycles_to_re_parent,
  (SELECT COUNT(*) FROM "review_escalations" r
     JOIN dupes d ON d.id = r.incident_id)
    AS review_escalations_to_re_point;

\echo ''
\echo '=== 3. SLA cycle collisions (renumbered, never dropped) ======================'

WITH ranked AS (
  SELECT id, fingerprint,
         ROW_NUMBER() OVER (PARTITION BY fingerprint
                            ORDER BY first_seen_at_utc ASC, id ASC) AS rn
  FROM "operational_incidents"
  WHERE team_id IS NULL
),
mapping AS (
  SELECT r.id AS duplicate_id,
         (SELECT r2.id FROM ranked r2
           WHERE r2.fingerprint = r.fingerprint AND r2.rn = 1) AS canonical_id
  FROM ranked r
  WHERE r.rn > 1
)
SELECT
  m.canonical_id,
  COUNT(*) AS colliding_cycles
FROM "operational_incident_sla_cycles" s
JOIN mapping m ON m.duplicate_id = s.incident_id
WHERE EXISTS (
  SELECT 1 FROM "operational_incident_sla_cycles" existing
  WHERE existing.incident_id = m.canonical_id
    AND existing.cycle_number = s.cycle_number
)
GROUP BY m.canonical_id
ORDER BY 2 DESC;

\echo ''
\echo '=== 4. Blocking conditions ==================================================='
\echo 'Any row below must be resolved before the convergence will succeed.'

SELECT 'partial unique index already present — convergence has already run'
         AS blocking_condition
WHERE EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'operational_incidents_platform_fingerprint_uk'
)
UNION ALL
SELECT 'operational_incidents is missing fingerprint or team_id'
WHERE NOT (
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='operational_incidents'
            AND column_name='fingerprint')
  AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='operational_incidents'
                AND column_name='team_id')
);
