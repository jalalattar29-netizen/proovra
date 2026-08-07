-- PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) — EXPAND.
--
-- THE FINDING
-- ---------------------------------------------------------------------------
-- The Automation feature is configurable and inert. `dispatchAutomationTrigger`
-- has zero production callers, so a rule a customer enables in the UI never
-- runs. Where execution DID exist it was in-memory: webhook delivery was
-- scheduled with `setImmediate`/`setTimeout`, so an API restart mid-flight lost
-- the delivery with no durable record that anything was owed.
--
-- And `automation_runs` had no fence. A run could be picked up by two workers
-- at once, a worker whose lease had expired could still write a terminal state
-- over a newer attempt's, there was no attempt counter, no retry schedule, and
-- no dead-letter — so a run that failed transiently was simply lost, and a run
-- interrupted mid-flight stayed RUNNING forever.
--
-- WHAT THIS ADDS, AND WHY EACH COLUMN
-- ---------------------------------------------------------------------------
--   source_event_id          the durable identity of the domain event that
--                            produced this run. Written INSIDE the source
--                            transaction, so a rolled-back source transaction
--                            leaves no run and a replayed event collapses.
--   action_idempotency_key   the durable identity of the ACTION intent. A
--                            retry reuses it, so a retried email or webhook is
--                            the same intent rather than a second one.
--   claimed_at_utc           when the current holder claimed it.
--   lease_expires_at_utc     when that claim stops being valid. A worker that
--                            dies leaves an expired lease, not a stuck row.
--   claim_generation         monotonic fence. Every claim increments it; every
--                            terminal write names the generation it claimed
--                            under, so a stale worker's success or failure
--                            updates ZERO rows instead of overwriting a newer
--                            attempt.
--   attempt_count            bounded retries need a counter that survives a
--                            restart.
--   next_attempt_at_utc      the retry schedule, in the database rather than in
--                            a setTimeout that a restart forgets.
--   failed_at_utc            terminal failure time, distinct from completed_at
--                            which the old code also used for success.
--   dead_lettered_at_utc     when retries were exhausted and the run stopped
--                            being work.
--   failure_code             BOUNDED classification (never a message, never a
--                            response body, never a URL with a query string).
--
-- EXPAND ONLY. Every column is nullable or defaulted, so every existing row is
-- immediately valid and no reader changes behaviour until the code deploys.
-- The status CHECK is WIDENED here — widening can never invalidate an existing
-- row, and the new code must be able to write RETRY_SCHEDULED and
-- DEAD_LETTERED the moment it deploys. The NOT NULLs, the narrowing CHECKs and
-- the uniqueness are 20271131000000, behind readiness counts that RAISE.

-- ---------------------------------------------------------------------------
-- 0. Widen the two status columns BEFORE widening their CHECKs.
--
-- Both are VARCHAR(20), chosen when the longest value was 'RETRY_SCHEDULED'.
-- 'DEAD_LETTERED_UNKNOWN' is 21 characters, so without this the widened CHECK
-- would accept a value the COLUMN then refuses — and the refusal surfaces as a
-- write that "matched no rows", which is indistinguishable from ordinary
-- fence contention. A reconciler would then revisit the same row forever
-- without ever terminating it.
--
-- Widening a VARCHAR is EXPAND-safe by construction: every value that fit the
-- old length fits the new one, no row is rewritten, and no reader changes.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'status'
       AND character_maximum_length < 32
  ) THEN
    EXECUTE 'ALTER TABLE "automation_runs" ALTER COLUMN "status" TYPE VARCHAR(32)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_webhook_deliveries'
       AND column_name = 'status'
       AND character_maximum_length < 32
  ) THEN
    EXECUTE 'ALTER TABLE "automation_webhook_deliveries" ALTER COLUMN "status" TYPE VARCHAR(32)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The durability columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'automation_runs'
  ) THEN
    RETURN;
  END IF;

  FOR col IN
    SELECT * FROM (VALUES
      ('source_event_id',        'VARCHAR(160)'),
      ('action_idempotency_key', 'VARCHAR(160)'),
      ('claimed_at_utc',         'TIMESTAMPTZ(6)'),
      ('lease_expires_at_utc',   'TIMESTAMPTZ(6)'),
      ('claim_generation',       'INTEGER NOT NULL DEFAULT 0'),
      ('attempt_count',          'INTEGER NOT NULL DEFAULT 0'),
      ('next_attempt_at_utc',    'TIMESTAMPTZ(6)'),
      ('failed_at_utc',          'TIMESTAMPTZ(6)'),
      ('dead_lettered_at_utc',   'TIMESTAMPTZ(6)'),
      ('failure_code',           'VARCHAR(60)'),
      -- ARCH-005 §1 — AMBIGUITY. An outcome the system cannot determine is
      -- neither success nor failure; it waits under a bounded reconciliation
      -- policy instead of joining the retry ladder, because re-executing an
      -- action that MAY already have committed is a duplicate side effect and
      -- not a retry.
      ('ambiguous_at_utc',        'TIMESTAMPTZ(6)'),
      ('reconciliation_attempts', 'INTEGER NOT NULL DEFAULT 0')
    ) AS t(name, decl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'automation_runs'
         AND column_name = col.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE "automation_runs" ADD COLUMN %I %s', col.name, col.decl
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Widen the status allowlist.
--
-- RETRY_SCHEDULED and DEAD_LETTERED are new terminal/queued states. RUNNING is
-- RETAINED rather than renamed: it is the status this table has always used
-- for a claimed run, it is written by code already in production, and renaming
-- a status in the same migration that adds a fence would mean a rolling deploy
-- has two vocabularies for one fact. (`PROCESSING` is the intelligence-run
-- vocabulary and belongs to a different table; importing it here would create
-- the ambiguity this programme keeps removing.)
--
-- Widening is EXPAND-safe by construction: every value that satisfied the old
-- CHECK satisfies the new one.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'automation_runs'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_status_allowlist'
    ) THEN
      EXECUTE 'ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_status_allowlist"';
    END IF;
    EXECUTE $ck$
      ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_status_allowlist"
        CHECK ("status" IN (
          'PENDING',
          'RUNNING',
          'RETRY_SCHEDULED',
          'SUCCEEDED',
          'FAILED',
          'SKIPPED',
          'DEAD_LETTERED',
          -- ARCH-005 §1 — the two states that carry "we do not know".
          -- AMBIGUOUS is NOT terminal: it is awaiting bounded reconciliation.
          -- DEAD_LETTERED_UNKNOWN is terminal and is deliberately DISTINCT
          -- from FAILED, which means the far side refused. Collapsing the two
          -- would tell an operator a receiver rejected an event it may in
          -- fact have processed, and they would resend it.
          'AMBIGUOUS',
          'DEAD_LETTERED_UNKNOWN'
        ))
    $ck$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Claim / retry / reconcile read indexes.
--
-- The sweep asks exactly two questions on every tick — "what is due?" and
-- "whose lease has expired?" — and both are partial so the index stays small
-- next to a table whose overwhelming majority of rows are terminal.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'next_attempt_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_runs_due_idx" ON "automation_runs" ("next_attempt_at_utc", "created_at") WHERE "status" IN (''PENDING'', ''RETRY_SCHEDULED'')';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'lease_expires_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_runs_expired_lease_idx" ON "automation_runs" ("lease_expires_at_utc") WHERE "status" = ''RUNNING''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'source_event_id'
  ) THEN
    -- Helper for the contract migration's readiness scan; dropped there.
    EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_runs_source_event_expand_idx" ON "automation_runs" ("team_id", "source_event_id") WHERE "source_event_id" IS NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Delivery-side durability: the webhook outbox needs the same two facts.
--
-- `automation_webhook_deliveries` already carries attempt_count/next_attempt_at
-- from E3.2. What it lacks is a LEASE, so two sweeps could claim the same row
-- across processes, and a dead worker's DELIVERING row was indistinguishable
-- from a live one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'automation_webhook_deliveries'
  ) THEN
    RETURN;
  END IF;

  FOR col IN
    SELECT * FROM (VALUES
      ('lease_expires_at_utc',     'TIMESTAMPTZ(6)'),
      ('claim_generation',         'INTEGER NOT NULL DEFAULT 0'),
      ('ambiguous_at_utc',         'TIMESTAMPTZ(6)'),
      ('reconciliation_attempts',  'INTEGER NOT NULL DEFAULT 0')
    ) AS t(name, decl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'automation_webhook_deliveries'
         AND column_name = col.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE "automation_webhook_deliveries" ADD COLUMN %I %s', col.name, col.decl
      );
    END IF;
  END LOOP;

  EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_webhook_deliveries_due_idx" ON "automation_webhook_deliveries" ("next_attempt_at") WHERE "status" IN (''PENDING'', ''RETRY_SCHEDULED'')';
  EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_webhook_deliveries_expired_lease_idx" ON "automation_webhook_deliveries" ("lease_expires_at_utc") WHERE "status" = ''DELIVERING''';
  -- The ambiguity reconciler asks one question: which unknown outcomes are due
  -- to be revisited? Its own partial index, because AMBIGUOUS rows are a
  -- different population from the retry queue and must never share its scan.
  EXECUTE 'CREATE INDEX IF NOT EXISTS "automation_webhook_deliveries_ambiguous_due_idx" ON "automation_webhook_deliveries" ("next_attempt_at") WHERE "status" = ''AMBIGUOUS''';

  -- Widen the delivery status allowlist. Widening can never invalidate an
  -- existing row.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automation_webhook_deliveries_status_allowlist'
  ) THEN
    EXECUTE 'ALTER TABLE "automation_webhook_deliveries" DROP CONSTRAINT "automation_webhook_deliveries_status_allowlist"';
  END IF;
  EXECUTE $ck2$
    ALTER TABLE "automation_webhook_deliveries"
      ADD CONSTRAINT "automation_webhook_deliveries_status_allowlist"
      CHECK ("status" IN (
        'PENDING',
        'DELIVERING',
        'SUCCEEDED',
        'FAILED',
        'SKIPPED',
        'RETRY_SCHEDULED',
        'RETRY_EXHAUSTED',
        -- ARCH-005 §1 — see the automation_runs note above. A webhook that
        -- timed out MAY have been processed by the receiver; resending it is a
        -- duplicate downstream action, not a retry.
        'AMBIGUOUS',
        'DEAD_LETTERED_UNKNOWN'
      ))
  $ck2$;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Documentation of authority, in the database.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'claim_generation'
  ) THEN
    EXECUTE 'COMMENT ON COLUMN "automation_runs"."claim_generation" IS ''Monotonic claim fence. Incremented by every claim; every terminal write must name the generation it claimed under, so a stale worker updates zero rows. Written only by services/worker/src/automation-dispatch.ts.''';
    EXECUTE 'COMMENT ON COLUMN "automation_runs"."source_event_id" IS ''Durable identity of the domain event that produced this run, written inside the source transaction by services/api/src/services/automation/automation-outbox.service.ts.''';
  END IF;
END $$;
