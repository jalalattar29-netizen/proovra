-- THE MULTI-TENANT SHAPE.
--
-- The first run had one workspace, so `eventType` was the selective predicate
-- and the planner used it. In production every tenant signs custody
-- attestations, so eventType selects the whole platform and only `teamId`
-- narrows anything. That is the plan that actually runs, so it is the one that
-- has to be measured.
BEGIN;

-- 40 workspaces x 25,000 attestations = 1,000,000 rows of this event type,
-- of which one workspace's 25,000 are the target.
INSERT INTO security_events (id, severity, "createdAtUtc", "eventType", "metadataJson", "teamId")
SELECT
  gen_random_uuid(), 'INFO', now() - (g || ' seconds')::interval,
  'custody_attestation_signed',
  jsonb_build_object('attestation', jsonb_build_object(
    'evidenceId', gen_random_uuid()::text)),
  ('00000000-0000-0000-0000-' || lpad((g % 40)::text, 12, '0'))::uuid
FROM generate_series(1, 1000000) g;

-- The needle: oldest row in the target workspace.
INSERT INTO security_events (id, severity, "createdAtUtc", "eventType", "metadataJson", "teamId")
VALUES (
  gen_random_uuid(), 'INFO', now() - interval '400 days',
  'custody_attestation_signed',
  jsonb_build_object('attestation', jsonb_build_object(
    'evidenceId', '99999999-9999-9999-9999-999999999999')),
  '00000000-0000-0000-0000-000000000007'
);

ANALYZE security_events;

\echo '=== SCALE ==='
SELECT count(*) AS attestations_platform_wide FROM security_events
 WHERE "eventType" = 'custody_attestation_signed';
SELECT count(*) AS attestations_in_target_workspace FROM security_events
 WHERE "eventType" = 'custody_attestation_signed'
   AND "teamId" = '00000000-0000-0000-0000-000000000007';

\echo ''
\echo '=== FILTERED BY evidenceId, WORST-CASE POSITION ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, "createdAtUtc", "metadataJson"
  FROM security_events
 WHERE "teamId" = '00000000-0000-0000-0000-000000000007'
   AND "eventType" = 'custody_attestation_signed'
   AND "metadataJson" #>> '{attestation,evidenceId}' = '99999999-9999-9999-9999-999999999999'
 ORDER BY "createdAtUtc" DESC
 LIMIT 50;

\echo ''
\echo '=== THE ACCOMPANYING COUNT ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
  FROM security_events
 WHERE "teamId" = '00000000-0000-0000-0000-000000000007'
   AND "eventType" = 'custody_attestation_signed'
   AND "metadataJson" #>> '{attestation,evidenceId}' = '99999999-9999-9999-9999-999999999999';

ROLLBACK;
