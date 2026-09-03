-- A PESSIMISTIC workspace, then the exact predicate the service issues.
--
-- The question is not "is the JSONB path indexed" (it is not) but "is the set
-- the JSONB filter runs over bounded by something that IS indexed". The
-- service filters on teamId AND eventType before it looks inside metadataJson,
-- and both are covered by btree indexes.
\timing off
BEGIN;

CREATE TEMP TABLE bench_team(id uuid) ON COMMIT DROP;
INSERT INTO bench_team VALUES ('11111111-1111-1111-1111-111111111111');

-- 50,000 custody attestations in ONE workspace. Real workspaces sign one per
-- evidence record; 50k is far past any observed tenant and is chosen so a
-- passing number here needs no extrapolation.
INSERT INTO security_events (id, severity, "createdAtUtc", "eventType", "metadataJson", "teamId")
SELECT
  gen_random_uuid(),
  'INFO',
  now() - (g || ' seconds')::interval,
  'custody_attestation_signed',
  jsonb_build_object(
    'attestation',
    jsonb_build_object(
      'evidenceId', gen_random_uuid()::text,
      'signedBy', 'bench',
      'algorithm', 'ed25519'
    )
  ),
  '11111111-1111-1111-1111-111111111111'
FROM generate_series(1, 50000) g;

-- Plus 200,000 OTHER events in the same workspace, so the eventType predicate
-- has to do real work rather than the table being uniformly one kind.
INSERT INTO security_events (id, severity, "createdAtUtc", "eventType", "metadataJson", "teamId")
SELECT
  gen_random_uuid(), 'INFO', now() - (g || ' seconds')::interval,
  'login_succeeded', '{}'::jsonb,
  '11111111-1111-1111-1111-111111111111'
FROM generate_series(1, 200000) g;

-- One row we will actually look for, deliberately OLD so it sits at the far
-- end of the createdAt ordering — the worst position for it.
INSERT INTO security_events (id, severity, "createdAtUtc", "eventType", "metadataJson", "teamId")
VALUES (
  gen_random_uuid(), 'INFO', now() - interval '400 days',
  'custody_attestation_signed',
  jsonb_build_object('attestation', jsonb_build_object(
    'evidenceId', '99999999-9999-9999-9999-999999999999')),
  '11111111-1111-1111-1111-111111111111'
);

ANALYZE security_events;

\echo '=== ROW COUNTS ==='
SELECT "eventType", count(*) FROM security_events
 WHERE "teamId" = '11111111-1111-1111-1111-111111111111'
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== THE QUERY THE SERVICE ISSUES (filtered by evidenceId) ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT id, "createdAtUtc", "metadataJson"
  FROM security_events
 WHERE "teamId" = '11111111-1111-1111-1111-111111111111'
   AND "eventType" = 'custody_attestation_signed'
   AND "metadataJson" #>> '{attestation,evidenceId}' = '99999999-9999-9999-9999-999999999999'
 ORDER BY "createdAtUtc" DESC
 LIMIT 50;

\echo ''
\echo '=== THE SAME QUERY UNFILTERED (the common case) ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT id, "createdAtUtc", "metadataJson"
  FROM security_events
 WHERE "teamId" = '11111111-1111-1111-1111-111111111111'
   AND "eventType" = 'custody_attestation_signed'
 ORDER BY "createdAtUtc" DESC
 LIMIT 50;

\echo ''
\echo '=== THE COUNT THAT ACCOMPANIES IT ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT count(*)
  FROM security_events
 WHERE "teamId" = '11111111-1111-1111-1111-111111111111'
   AND "eventType" = 'custody_attestation_signed'
   AND "metadataJson" #>> '{attestation,evidenceId}' = '99999999-9999-9999-9999-999999999999';

ROLLBACK;
