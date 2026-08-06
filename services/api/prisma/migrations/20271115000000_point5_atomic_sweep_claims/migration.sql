-- PHASE 12 — POINT 5: atomic claims for the governance sweep family.
--
-- Three documented concurrency guarantees did not exist. Each was written as a
-- read followed by a write, which is not a claim: two callers both read "no
-- holder" and both write one.
--
--   1. `runGovernanceReconciliation` documents "One RUNNING row per (kind,
--      lockKey) at a time" and described an "advisory + RUNNING-row check".
--      There is no advisory lock in the module. Two concurrent invocations —
--      the interval scheduler and an operator-triggered run, or two worker
--      instances — both observed no RUNNING row and both created one, so both
--      executed the reconciliation body. For DESTRUCTION_SWEEP that means the
--      destruction pipeline ran twice over the same approved reviews.
--
--   2. The destruction orchestrator reuses a non-terminal
--      `DestructionExecution` per review "instead of creating a duplicate",
--      and the work registry declared the mechanism as
--      `unique_execution_constraint`. No such constraint existed. Two runs
--      both found none and both created one, producing two certificates, two
--      lineage hashes and two `destruction_executed` ledger rows for a single
--      approved destruction.
--
--   3. The archive auto-transition sweep derives an evidence row's CURRENT
--      tier from its most recent transition row and then writes a new one.
--      With no claim, two ticks both read the same current tier and both
--      wrote a PENDING transition, so the same object was copied to the
--      archive storage class twice and billed twice, and the tier history
--      recorded two transitions out of a state it only left once.
--
-- All three are fixed by making the DATABASE the arbiter: a partial unique
-- index over exactly the rows that must be singular. The application code now
-- attempts the INSERT and treats a unique violation as "someone else holds
-- it", which is a claim rather than a hope.
--
-- PRE-EXISTING DUPLICATES
-- ---------------------------------------------------------------------------
-- A live database may already contain rows the new indexes forbid, and
-- CREATE UNIQUE INDEX would fail against them. Each is resolved FORWARD and
-- TRUTHFULLY first: the newest row keeps the slot and the older ones move to a
-- terminal FAILED state carrying a bounded reason, so an operator can see
-- exactly which rows were resolved and why. Nothing is deleted, and no
-- destruction outcome is invented — a duplicate execution row that never
-- completed is recorded as failed, which is what it is.
--
-- GUARD SHAPE
-- ---------------------------------------------------------------------------
-- Each index is created in its own DO block whose `information_schema.columns`
-- existence checks sit IMMEDIATELY before the EXECUTE, per the repository's
-- Phase-O pattern. The resolution UPDATEs are kept out of those blocks so
-- nothing separates a guard from the statement it guards.

-- ---------------------------------------------------------------------------
-- 1. governance_reconciliation_runs — one RUNNING row per (kind, lock_key)
-- ---------------------------------------------------------------------------

UPDATE "governance_reconciliation_runs" AS older
SET
  "status" = 'FAILED',
  "finished_at_utc" = NOW(),
  "error_summary" = 'point5_duplicate_running_run_resolved_by_atomic_lock_migration'
WHERE
  older."status" = 'RUNNING'
  AND EXISTS (
    SELECT 1
    FROM "governance_reconciliation_runs" AS newer
    WHERE newer."status" = 'RUNNING'
      AND newer."kind" = older."kind"
      AND newer."lock_key" = older."lock_key"
      AND (newer."started_at_utc", newer."id") > (older."started_at_utc", older."id")
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_reconciliation_runs'
       AND column_name='kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_reconciliation_runs'
       AND column_name='lock_key'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_reconciliation_runs'
       AND column_name='status'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "governance_reconciliation_runs_running_lock_uniq" ON "governance_reconciliation_runs" ("kind", "lock_key") WHERE "status" = ''RUNNING''';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. destruction_executions — one non-terminal execution per review
-- ---------------------------------------------------------------------------

UPDATE "destruction_executions" AS older
SET
  "status" = 'FAILED',
  "failed_at_utc" = NOW(),
  "error_code" = 'DUPLICATE_ACTIVE_EXECUTION',
  "error_detail" = 'Resolved by 20271115000000_point5_atomic_sweep_claims: more than one non-terminal execution existed for this destruction review because the orchestrator claim was not atomic. The most recent row keeps the slot; this one is recorded as failed rather than deleted.',
  "phase" = 'failed'
WHERE
  older."status" NOT IN ('COMPLETED', 'FAILED', 'ROLLED_BACK')
  AND EXISTS (
    SELECT 1
    FROM "destruction_executions" AS newer
    WHERE newer."status" NOT IN ('COMPLETED', 'FAILED', 'ROLLED_BACK')
      AND newer."destruction_review_id" = older."destruction_review_id"
      AND (newer."planned_at_utc", newer."id") > (older."planned_at_utc", older."id")
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_executions'
       AND column_name='destruction_review_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_executions'
       AND column_name='status'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "destruction_executions_active_review_uniq" ON "destruction_executions" ("destruction_review_id") WHERE "status" NOT IN (''COMPLETED'', ''FAILED'', ''ROLLED_BACK'')';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2b. destruction_reviews — one ACTIVE review per evidence
-- ---------------------------------------------------------------------------
--
-- The datamodel says, above the index list: "Only one active (PENDING /
-- UNDER_REVIEW / DEFERRED) review per evidence at a time. Service layer
-- enforces the membership check; the unique constraint here protects against
-- races." There is no unique constraint. The retention reconciler's "atomic"
-- creation is a `findFirst` inside a transaction followed by a `create`, and
-- at READ COMMITTED that read takes no lock — so a global run and a
-- workspace-scoped run, which hold DIFFERENT lock keys and may therefore
-- overlap by design, both saw no active review and both created one. The
-- second write also rebinds `Evidence.activeDestructionReviewId`, orphaning
-- the first review while leaving it PENDING in the operator's queue.
--
-- APPROVED is included: a review awaiting execution is as active as one
-- awaiting decision, and the reconciler already treats it that way.

UPDATE "destruction_reviews" AS older
SET
  "status" = 'CANCELLED',
  "decision_note" = 'Cancelled by 20271115000000_point5_atomic_sweep_claims: more than one active destruction review existed for this evidence because the reconciler''s check-then-create was not atomic. The most recent review keeps the slot. No destruction decision is implied by this cancellation — re-open a review if one is still wanted.'
WHERE
  older."status" IN ('PENDING', 'UNDER_REVIEW', 'DEFERRED', 'APPROVED')
  AND EXISTS (
    SELECT 1
    FROM "destruction_reviews" AS newer
    WHERE newer."status" IN ('PENDING', 'UNDER_REVIEW', 'DEFERRED', 'APPROVED')
      AND newer."evidence_id" = older."evidence_id"
      AND (newer."created_at", newer."id") > (older."created_at", older."id")
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_reviews'
       AND column_name='evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='destruction_reviews'
       AND column_name='status'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "destruction_reviews_active_evidence_uniq" ON "destruction_reviews" ("evidence_id") WHERE "status" IN (''PENDING'', ''UNDER_REVIEW'', ''DEFERRED'', ''APPROVED'')';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. archive_tier_transitions — one in-flight transition per evidence
-- ---------------------------------------------------------------------------

UPDATE "archive_tier_transitions" AS older
SET
  "state" = 'FAILED',
  "failure_reason" = 'duplicate_in_flight_transition_resolved_by_point5'
WHERE
  older."state" IN ('PENDING', 'EXECUTING', 'RESTORE_REQUESTED')
  AND EXISTS (
    SELECT 1
    FROM "archive_tier_transitions" AS newer
    WHERE newer."state" IN ('PENDING', 'EXECUTING', 'RESTORE_REQUESTED')
      AND newer."evidence_id" = older."evidence_id"
      AND (newer."transitioned_at_utc", newer."id") > (older."transitioned_at_utc", older."id")
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='archive_tier_transitions'
       AND column_name='evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='archive_tier_transitions'
       AND column_name='state'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "archive_tier_transitions_active_evidence_uniq" ON "archive_tier_transitions" ("evidence_id") WHERE "state" IN (''PENDING'', ''EXECUTING'', ''RESTORE_REQUESTED'')';
  END IF;
END $$;
