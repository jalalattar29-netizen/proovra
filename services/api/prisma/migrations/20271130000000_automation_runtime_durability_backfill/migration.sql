-- PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) — BACKFILL.
--
-- DETERMINISTIC AND RE-RUNNABLE. Every statement is conditioned on the value
-- it is about to write being absent, so running this twice changes nothing the
-- first run did not already change.
--
-- WHAT IT REFUSES TO DO
-- ---------------------------------------------------------------------------
-- It INVENTS NOTHING. In particular:
--
--   * A historical run has no source event id, because no writer ever produced
--     one. It stays NULL. Manufacturing an id from the run's own columns would
--     make an event look like it had been observed when it never was, and the
--     contract migration's uniqueness would then be enforcing a fiction.
--
--   * A historical RUNNING run is NOT resolved here. It was interrupted by a
--     process that is long gone and nobody can say whether its action reached
--     the outside world. It is left RUNNING with an EXPIRED lease, which is
--     precisely the shape the reconciler is built to handle: it will be
--     reclaimed, re-attempted under the action's idempotency key, and reach a
--     real terminal state — or dead-lettered. Writing SUCCEEDED or FAILED here
--     would be inventing an outcome.
--
--   * No row is deleted. No attempt counter is renumbered.
--
-- WHAT IT DOES STATE
-- ---------------------------------------------------------------------------
--   * `attempt_count` and `claim_generation` explicitly, rather than leaning on
--     a column default that a later migration might change.
--   * `failed_at_utc` from `completed_at` for rows ALREADY terminal in FAILED —
--     the same fact, moved into the column that now owns it.
--   * `action_idempotency_key` from the run's own durable identity for rows
--     that already exist. This is a DERIVATION, not an invention: the key's
--     whole job is to be stable per (run, action), and the run id is exactly
--     that. New runs derive it the same way in the producer.
--   * An EXPIRED lease on historical RUNNING rows, so the reconciler can see
--     them. `created_at` is the honest lease start for a run whose claim was
--     never recorded.

-- ---------------------------------------------------------------------------
-- 1. State the counters explicitly.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'claim_generation'
  ) THEN
    RETURN;
  END IF;

  EXECUTE 'UPDATE "automation_runs" SET "claim_generation" = 0 WHERE "claim_generation" IS NULL';
  EXECUTE 'UPDATE "automation_runs" SET "attempt_count" = 0 WHERE "attempt_count" IS NULL';

  -- A run that already reached a terminal state made exactly one attempt.
  EXECUTE $q$
    UPDATE "automation_runs"
       SET "attempt_count" = 1
     WHERE "attempt_count" = 0
       AND "status" IN ('SUCCEEDED', 'FAILED')
  $q$;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Move the failure timestamp into the column that owns it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'failed_at_utc'
  ) THEN
    EXECUTE $q$
      UPDATE "automation_runs"
         SET "failed_at_utc" = "completed_at"
       WHERE "status" = 'FAILED'
         AND "failed_at_utc" IS NULL
         AND "completed_at" IS NOT NULL
    $q$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Derive the action idempotency key.
--
-- `automation-run:<run id>` — stable, unique by construction, and derived from
-- a durable column rather than from anything a caller supplied. The producer
-- writes exactly this shape for new runs, so historical and new rows share one
-- format and the retry path cannot tell them apart.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'action_idempotency_key'
  ) THEN
    EXECUTE $q$
      UPDATE "automation_runs"
         SET "action_idempotency_key" = 'automation-run:' || "id"::text
       WHERE "action_idempotency_key" IS NULL
    $q$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Expose historical stranded runs to the reconciler.
--
-- An interrupted run is left RUNNING — its outcome is genuinely unknown — but
-- it is given an EXPIRED lease so it is visible as reclaimable rather than
-- invisible as permanently in-flight. `created_at` is used as the claim time
-- because no claim was ever recorded; that is the earliest defensible reading
-- and it makes the lease unambiguously expired.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_runs'
       AND column_name = 'lease_expires_at_utc'
  ) THEN
    EXECUTE $q$
      UPDATE "automation_runs"
         SET "claimed_at_utc" = COALESCE("started_at", "created_at"),
             "lease_expires_at_utc" = COALESCE("started_at", "created_at")
       WHERE "status" = 'RUNNING'
         AND "lease_expires_at_utc" IS NULL
    $q$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The same two facts on the delivery outbox.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'automation_webhook_deliveries'
       AND column_name = 'lease_expires_at_utc'
  ) THEN
    EXECUTE 'UPDATE "automation_webhook_deliveries" SET "claim_generation" = 0 WHERE "claim_generation" IS NULL';
    EXECUTE $q$
      UPDATE "automation_webhook_deliveries"
         SET "lease_expires_at_utc" = COALESCE("last_attempt_at", "created_at")
       WHERE "status" = 'DELIVERING'
         AND "lease_expires_at_utc" IS NULL
    $q$;
  END IF;
END $$;
