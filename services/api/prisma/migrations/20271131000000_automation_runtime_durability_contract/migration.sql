-- PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) — CONTRACT.
--
-- SELF-GUARDED. Every constraint below is preceded IN THIS SAME FILE by the
-- readiness count that authorises it, and each RAISEs. A raise inside
-- `prisma migrate deploy` leaves a FAILED migration row that blocks everything
-- after it, which is exactly the behaviour wanted: this file must refuse on a
-- database that is not ready rather than destroy or invent its way to green.
--
-- RELEASE WAVE: D. This file must NOT be present in the artifact for Release
-- A, B or C.
--
-- It drops nothing that holds data. The only DROP is the helper index the
-- expand migration created for this file's own readiness scan.

DO $$
DECLARE
  missing_key       BIGINT;
  bad_generation    BIGINT;
  bad_attempts      BIGINT;
  duplicate_source  BIGINT;
  terminal_leased   BIGINT;
  contradictory     BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'automation_runs'
  ) THEN
    RETURN;
  END IF;

  -- READINESS 1 — every run carries an action idempotency key. Without it a
  -- retry cannot prove it is the SAME intent, and a retried webhook or email
  -- becomes a second delivery.
  SELECT count(*) INTO missing_key
    FROM "automation_runs" WHERE "action_idempotency_key" IS NULL;
  IF missing_key <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % automation_runs have no action_idempotency_key. Run 20271130000000 (backfill) first.',
      missing_key;
  END IF;

  -- READINESS 2 — no negative fence or attempt counter. A negative generation
  -- would make the fence comparison meaningless.
  SELECT count(*) INTO bad_generation
    FROM "automation_runs" WHERE "claim_generation" IS NULL OR "claim_generation" < 0;
  IF bad_generation <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % automation_runs have a null or negative claim_generation.',
      bad_generation;
  END IF;

  SELECT count(*) INTO bad_attempts
    FROM "automation_runs" WHERE "attempt_count" IS NULL OR "attempt_count" < 0;
  IF bad_attempts <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % automation_runs have a null or negative attempt_count.',
      bad_attempts;
  END IF;

  -- READINESS 3 — one source event produces at most one run PER RULE. Two runs
  -- for the same (team, rule, source event) means the outbox identity did not
  -- collapse a replay, and enforcing uniqueness over that would silently drop
  -- one of them.
  SELECT count(*) INTO duplicate_source FROM (
    SELECT 1
      FROM "automation_runs"
     WHERE "source_event_id" IS NOT NULL
     GROUP BY "team_id", "rule_id", "source_event_id"
    HAVING count(*) > 1
  ) d;
  IF duplicate_source <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % (team, rule, source_event_id) groups have more than one run. A replayed event did not collapse.',
      duplicate_source;
  END IF;

  -- READINESS 4 — a terminal run must not hold a live lease. One that does is
  -- a row two writers still believe they own.
  SELECT count(*) INTO terminal_leased
    FROM "automation_runs"
   WHERE "status" IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'DEAD_LETTERED')
     AND "lease_expires_at_utc" IS NOT NULL
     AND "lease_expires_at_utc" > now();
  IF terminal_leased <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % terminal automation_runs still hold an unexpired lease.',
      terminal_leased;
  END IF;

  -- READINESS 5 — no run is both dead-lettered and successful.
  SELECT count(*) INTO contradictory
    FROM "automation_runs"
   WHERE "dead_lettered_at_utc" IS NOT NULL
     AND "status" = 'SUCCEEDED';
  IF contradictory <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % automation_runs are both dead-lettered and SUCCEEDED.',
      contradictory;
  END IF;

  -- -------------------------------------------------------------------------
  -- The constraints the five counts above authorise.
  -- -------------------------------------------------------------------------
  EXECUTE 'ALTER TABLE "automation_runs" ALTER COLUMN "action_idempotency_key" SET NOT NULL';
  EXECUTE 'ALTER TABLE "automation_runs" ALTER COLUMN "claim_generation" SET NOT NULL';
  EXECUTE 'ALTER TABLE "automation_runs" ALTER COLUMN "attempt_count" SET NOT NULL';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_fence_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_fence_non_negative" CHECK ("claim_generation" >= 0 AND "attempt_count" >= 0)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_terminal_not_contradictory'
  ) THEN
    EXECUTE 'ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_terminal_not_contradictory" CHECK (NOT ("dead_lettered_at_utc" IS NOT NULL AND "status" = ''SUCCEEDED''))';
  END IF;

  -- One run per (team, rule, source event). The partial index leaves historical
  -- rows — which legitimately have no source event — entirely alone.
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "automation_runs_source_event_uniq" ON "automation_runs" ("team_id", "rule_id", "source_event_id") WHERE "source_event_id" IS NOT NULL';

  -- The expand migration''s readiness helper has done its job.
  EXECUTE 'DROP INDEX IF EXISTS "automation_runs_source_event_expand_idx"';
END $$;

-- ---------------------------------------------------------------------------
-- The delivery outbox''s fence, on the same terms.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad_generation BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_webhook_deliveries'
       AND column_name = 'claim_generation'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO bad_generation
    FROM "automation_webhook_deliveries"
   WHERE "claim_generation" IS NULL OR "claim_generation" < 0;
  IF bad_generation <> 0 THEN
    RAISE EXCEPTION
      'ARCH-005 CONTRACT REFUSED: % automation_webhook_deliveries have a null or negative claim_generation.',
      bad_generation;
  END IF;

  EXECUTE 'ALTER TABLE "automation_webhook_deliveries" ALTER COLUMN "claim_generation" SET NOT NULL';
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automation_webhook_deliveries_fence_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE "automation_webhook_deliveries" ADD CONSTRAINT "automation_webhook_deliveries_fence_non_negative" CHECK ("claim_generation" >= 0)';
  END IF;
END $$;
