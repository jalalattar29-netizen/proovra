-- =============================================================================
-- EVIDENCE OUTPUT EARNED FACT (2026-09-30, ET-COM-04). EXPAND.
--
-- Whether a plan-funded record may be issued a report or package was decided
-- from the subscription's CURRENT lifecycle every time it was asked. A billing
-- lapse therefore revoked outputs a record had already earned: a report job
-- queued while the plan was paid was refused once the plan lapsed.
--
-- Three nullable columns store what the record earned when it was finalized —
-- the plan that funded it, the basis on which that plan was in force
-- (PAID_SUBSCRIPTION / TRIAL / PAYMENT_GRACE) and when. They are written once,
-- inside the completion transaction, only when the decision at that moment was
-- ENTITLED on a plan basis. NULL = no stored fact: the current lifecycle
-- decides, exactly as before. (A credit-funded record's fact is its ledger row.)
--
-- Additive only: no row is rewritten, no backfill.
-- =============================================================================

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "output_earned_plan" VARCHAR(24);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "output_earned_basis" VARCHAR(32);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "output_earned_at_utc" TIMESTAMPTZ(6);
