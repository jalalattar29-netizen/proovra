-- OPERATIONS SOURCE IDENTITY — declared, not inferred.
--
-- WHY
-- ---
-- A condition's lifecycle — who may resolve it, what probe answers "is it
-- still true", how it recovers and recurs, who it is for — was derived from
-- `category` (fourteen values for thirty-five sources), then from
-- `fingerprint` (which covered the eleven shapes the discovery sweep writes
-- and left fifteen other production emitters, in both hosts, falling through
-- to an "unregistered" contract that was OPERATOR_DECISION).
--
-- That last part is the defect this closes: a condition the system could not
-- identify AT ALL was operator-resolvable. Not knowing what something is made
-- it MORE closable.
--
-- Every writer now passes a typed source id from the canonical registry, and
-- this column persists it. `fingerprint` keeps its job — deduplication — and
-- loses the one it was never designed for.
--
-- SHAPE
-- -----
-- One nullable VARCHAR(120). No default, no constraint, and DELIBERATELY NO
-- NOT NULL: rows written before this column existed carry NULL, the backfill
-- below stamps only the fingerprint shapes that mean exactly one source, and
-- anything ambiguous stays NULL and resolves at runtime to
-- NO_DIRECT_RESOLUTION. Tightening to NOT NULL is a LATER deployment, after
-- the backfill has been observed in production; new writes are already
-- enforced by the typed writer signature.
--
-- A VARCHAR rather than a PostgreSQL enum: the TypeScript registry is the
-- compile-time authority, and an enum here would be a second authority that
-- has to be migrated in lockstep every time a source is registered.
--
-- NO INDEX. The only predicate that reads this column is the tenant-surface
-- exclusion of PLATFORM_INTERNAL sources, and that runs as a filter on a scan
-- the existing `(scope, team_id, status)` index already selects — a handful of
-- rows per workspace. An index here would be speculative.
--
-- EXPAND-ONLY AND SAFE TO APPLY BEFORE THE IMAGE THAT USES IT.
-- An older build never selects the column. A rolled-back build leaves it
-- unread. Nothing is dropped, no type narrowed, no row deleted.
ALTER TABLE "public"."operational_incidents"
  ADD COLUMN IF NOT EXISTS "source_id" VARCHAR(120);

-- ---------------------------------------------------------------------------
-- BACKFILL — only where one fingerprint shape means exactly ONE source.
--
-- Every mapping below is the exact `legacyFingerprints` declaration of its
-- source in `packages/shared-runtime/src/ops/source-lifecycle.ts`, and
-- `operations-source-identity.test.ts` fails if this file and that registry
-- disagree. The runtime resolves a NULL row through the SAME table, so a row
-- this backfill stamps and a row it misses reach the identical contract — the
-- backfill is an optimisation, never a second opinion.
--
-- WHAT IS NOT BACKFILLED, and why that is the point:
--   * anything matching no pattern stays NULL;
--   * anything a pattern cannot disambiguate is absent from the list entirely;
--   * a NULL row fails closed to NO_DIRECT_RESOLUTION.
--
-- NO HISTORY IS REWRITTEN. This touches one previously-absent column on the
-- incident row. `operational_incident_events` and
-- `operational_incident_sla_cycles` are not read and not written; no status,
-- resolution, note, actor, occurrence count or SLA cycle changes.
--
-- Guarded by `source_id IS NULL` so re-running is a no-op, and anchored on the
-- separator (`prefix:`) so a future `report_backlog_v2` cannot inherit
-- `report_backlog`.
DO $$
DECLARE
  mapping RECORD;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
      ('tsa_failure:',                        'evidence_integrity.tsa_failed'),
      ('ots_failure:',                        'evidence_integrity.ots_failed'),
      ('ots_pending_aged:',                   'evidence_integrity.ots_pending_aged'),
      ('OTS:',                                'evidence_integrity.ots_budget_exhausted'),
      ('REPORT:',                             'pipeline.report_generation_failed'),
      ('worker_package_gate:',                'pipeline.package_generation_denied'),
      ('dashboard:pipeline:report_backlog:',  'pipeline.report_backlog'),
      ('dashboard:pipeline:package_backlog:', 'pipeline.package_backlog'),
      ('dashboard:integrity:unsigned_aged:',  'pipeline.signed_without_report_aged'),
      ('dashboard:review:stale_assignments:', 'review.stale_workflows'),
      ('dashboard:coordination:stale_backlog:','coordination.backlog_stale'),
      ('dashboard:reliability:retry_storms:', 'queue.retry_storm'),
      ('dashboard:telemetry:queue_stale:',    'platform.telemetry_stale'),
      ('dashboard:worker:heartbeat_stale:',   'platform.worker_heartbeat_stale'),
      ('review-escalation:',                  'review.escalation'),
      ('reviewer:escalation_storm:',          'review.escalation_storm'),
      ('idp-outage:',                         'identity.idp_outage'),
      ('runtime-block:',                      'identity.runtime_block'),
      ('runtime-high-risk-sessions:',         'identity.high_risk_session_surge'),
      ('destruction_executed:',               'governance.destruction_executed'),
      ('governance_notification:',            'governance.notification_escalated'),
      ('immutable_storage_drift:',            'storage.immutable_drift'),
      ('seed:',                               'platform.operational_seed'),
      ('upload:security_event:',              'intake.delivery_failed'),
      ('communications:security_event:',      'communications.provider_failure'),
      ('webhook:security_event:',             'webhook.security_failure'),
      ('identity_security:security_event:',   'identity.security_condition'),
      ('governance:security_event:',          'governance.policy_condition'),
      ('worker:security_event:',              'security.unclassified_signal')
    ) AS t(prefix, source_id)
  LOOP
    UPDATE "public"."operational_incidents"
       SET "source_id" = mapping.source_id
     WHERE "source_id" IS NULL
       AND "fingerprint" LIKE mapping.prefix || '%';
  END LOOP;
END $$;
