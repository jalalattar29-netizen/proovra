-- =============================================================================
-- 2026-11-01 — the rest of the contract record.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Two nullable columns on
-- enterprise_contracts. No row is rewritten and an older image reads neither.
--
-- 1. external_contract_ref: the sales reference lived only on the provisioning
--    request, so the contract could not say what it was signed under.
-- 2. status_before_termination: withdrawing a termination has to return the
--    contract to what it was, and that was recorded nowhere.
-- =============================================================================

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "external_contract_ref" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "status_before_termination" "EnterpriseContractStatus";
