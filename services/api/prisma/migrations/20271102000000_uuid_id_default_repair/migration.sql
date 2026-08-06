-- =============================================================================
-- PHASE 12 — uuid id DEFAULT repair (clean-DB reproducibility).
--
-- schema.prisma declares `@default(dbgenerated("gen_random_uuid()"))` on these
-- tables' `id`, so the Prisma client OMITS the id on insert — but the creating
-- migrations never added the DB default. On every environment built purely
-- from migrations, inserts crash with a null-constraint violation on `id`
-- (proven live: qc_samples via the phase-37-98 lifecycle gate — QC sampling
-- silently failed and lost samples).
--
-- Guarded + idempotent: sets the default ONLY where it is missing; no rows
-- are touched, no historical data changes, safe to re-run, safe on databases
-- that already carry the default.
-- =============================================================================
DO $$
DECLARE
  t text;
  bad_default text;
BEGIN
  -- gen_random_uuid() must exist (built-in since PostgreSQL 13; pgcrypto
  -- provides it earlier). Fail loudly, never silently skip.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'gen_random_uuid'
  ) THEN
    RAISE EXCEPTION 'uuid_id_default_repair: gen_random_uuid() is not available in this database';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'capture_device_attestations',
    'capture_trust_event_records',
    'devices',
    'evidence_exchange_package_builds',
    'external_review_activities',
    'external_review_comments',
    'external_review_decisions',
    'external_reviewer_role_assignments',
    'governance_policy_audits',
    'qc_samples',
    'redaction_activities'
  ] LOOP
    -- An UNEXPECTED existing default is a conflicting-schema signal: fail
    -- explicitly rather than silently accepting or overwriting it.
    SELECT column_default INTO bad_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t
      AND column_name = 'id' AND data_type = 'uuid'
      AND column_default IS NOT NULL
      AND column_default NOT LIKE 'gen_random_uuid()%';
    IF bad_default IS NOT NULL THEN
      RAISE EXCEPTION 'uuid_id_default_repair: table % has an incompatible id default (%) — resolve manually', t, bad_default;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t
        AND column_name = 'id' AND data_type = 'uuid'
        AND column_default IS NULL
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT gen_random_uuid()', t);
    END IF;
  END LOOP;
END $$;
