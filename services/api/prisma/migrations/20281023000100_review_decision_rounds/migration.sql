-- REVIEW DECISION ROUNDS (2026-10-23).
--
-- A reopened review could never receive a new verdict: the decision log held
-- one row per (workflow, stage), and the earlier FIRST row both resolved the
-- derived state and occupied the unique key. The same held after a
-- request-more-information outcome. Decisions now carry the ROUND they were
-- made in, the workflow carries its current round, and state is derived from
-- the current round only. Earlier rounds stay on the log, unchanged.
--
-- EXPAND + BACKFILL, then a guarded swap of the unique key (same columns plus
-- round). Existing rows
-- and workflows start in round 0, so the old key's guarantee is kept for them.
-- A workflow that was reopened after decisions moves to round 1, and the
-- decisions made after its (last) reopen are classified into round 1 — the
-- only round boundary the existing columns record. No decision content is
-- changed. Idempotent.
-- ROLLBACK: drop the new index, recreate the old one, drop both columns
-- (only valid while no round has more than one row per stage).

ALTER TABLE "workflow_review_decisions" ADD COLUMN IF NOT EXISTS "round" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "evidence_review_workflows" ADD COLUMN IF NOT EXISTS "decision_round" INTEGER NOT NULL DEFAULT 0;

UPDATE "evidence_review_workflows" w
   SET "decision_round" = 1
 WHERE w."reopened_at_utc" IS NOT NULL
   AND w."decision_round" = 0
   AND EXISTS (
     SELECT 1 FROM "workflow_review_decisions" d
      WHERE d."workflow_id" = w."id" AND d."decided_at" <= w."reopened_at_utc"
   );

UPDATE "workflow_review_decisions" d
   SET "round" = 1
  FROM "evidence_review_workflows" w
 WHERE d."workflow_id" = w."id"
   AND w."decision_round" = 1
   AND d."round" = 0
   AND d."decided_at" > w."reopened_at_utc";

-- The (workflow, round, stage) key FIRST, so the table is never without
-- per-stage uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_review_decisions_workflow_id_round_stage_key"
  ON "workflow_review_decisions"("workflow_id", "round", "stage");

-- RETIRE the (workflow, stage) key — ONLY while the round-aware key exists.
-- The guard and the drop are one block, so the RAISE authorises the drop.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'workflow_review_decisions_workflow_id_round_stage_key'
  ) THEN
    RAISE EXCEPTION
      'review decision rounds refused: the (workflow_id, round, stage) key is missing, so retiring (workflow_id, stage) would leave no per-stage uniqueness';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS "workflow_review_decisions_workflow_id_stage_key"';
END $$;
