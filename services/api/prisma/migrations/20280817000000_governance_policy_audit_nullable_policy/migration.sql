-- =============================================================================
-- GOVERNANCE POLICY AUDIT WITHOUT A POLICY (2026-09-30, PA-03). EXPAND.
--
-- A policy EVALUATION is audited even when no policy applied: "nothing
-- governed this request" is part of the record. governance_policy_audits
-- required policy_id and pointed it at governance_policies, so those rows were
-- written with the all-zero UUID as a stand-in — which violates the foreign
-- key. Every such insert failed, inside a catch that discarded the error, and
-- the evaluation record was lost.
--
-- policy_id becomes NULLable: NULL = the evaluation had no policy. The foreign
-- key is unchanged (it does not constrain NULL). Nothing is rewritten; every
-- existing row keeps its policy.
--
-- Idempotent and guarded: relaxes the column only where it exists and is
-- still NOT NULL.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'governance_policy_audits'
      AND column_name = 'policy_id'
      AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE "governance_policy_audits" ALTER COLUMN "policy_id" DROP NOT NULL';
  END IF;
END $$;
