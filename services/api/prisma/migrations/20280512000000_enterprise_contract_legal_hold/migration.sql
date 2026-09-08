-- =============================================================================
-- Legal Hold becomes a CONTRACTUAL Enterprise capability.
--
-- THE DEFECT THIS CLOSES
-- -----------------------------------------------------------------------------
-- Legal Hold had no commercial authority that could actually answer the
-- question "may this workspace place one?".
--
--   * `POST /v1/lifecycle/legal-holds` gated on the `FEATURE_LEGAL_HOLD`
--     entitlement, whose only source is an `EntitlementGrant` row written by
--     `applyProductLine`. The plan never fed it, so an ENTERPRISE workspace
--     with no product line applied resolved to the default `false` and could
--     not place a hold — while the catalog advertised the capability.
--   * `POST /v1/governance/legal-holds` and
--     `POST /v1/governance/case-legal-holds` reach the SAME canonical writer
--     (`placeCanonicalLegalHold`) and checked no entitlement at all. Whatever
--     the commercial answer was, those two routes never asked the question.
--
-- So the feature was simultaneously unreachable through one door and ungated
-- through two others.
--
-- THE APPROVED PRODUCT DECISION
-- -----------------------------------------------------------------------------
-- Legal Hold is an ENTERPRISE governance capability, and Enterprise
-- availability is CONTRACT-DRIVEN. Enterprise plan eligibility is not
-- automatic runtime authorization: the plan says the capability may be sold,
-- the contract says whether THIS customer bought it.
--
-- HOW THIS COLUMN DIFFERS FROM ITS NEIGHBOURS, DELIBERATELY
-- -----------------------------------------------------------------------------
-- `evidence_records_per_month`, `ai_operations_per_month`,
-- `collaboration_teams_max` and `collaboration_team_members_max` all read NULL
-- as "the contract is SILENT, so the canonical ENTERPRISE catalog default
-- governs". That convention is right for an ALLOWANCE, which has a safe
-- published default.
--
-- It is wrong for a CAPABILITY GRANT. There is no safe default for "may this
-- customer place legal holds": defaulting it ON for every Enterprise contract
-- would be precisely the `plan === ENTERPRISE` shortcut the product decision
-- forbids, and would grant a governance capability to customers who never
-- contracted for it. So this column reads:
--
--   NULL / FALSE   NOT GRANTED. New Legal Holds are refused with the canonical
--                  typed entitlement denial. This is the fail-closed default,
--                  and it is what every existing row means today — no contract
--                  has ever stated this term, so none of them granted it.
--   TRUE           GRANTED, while the contract is ACTIVE.
--
-- Status still fails closed upstream: `resolveEnterpriseContractLimits`
-- returns NO_CONTRACT_LIMITS for DRAFT / PENDING_ACTIVATION / SUSPENDED /
-- TERMINATED, so this column is not read at all unless the contract is ACTIVE.
-- A suspended contract therefore stops NEW holds without any additional logic.
--
-- WHAT THIS MIGRATION CANNOT AND MUST NOT DO
-- -----------------------------------------------------------------------------
-- It does not touch a single legal hold. Commercial state governs ADMISSION to
-- creating a new hold and nothing else: an ACTIVE hold placed under any past
-- commercial state keeps protecting its evidence through downgrade, contract
-- expiry, entitlement removal and billing suspension, and is released only
-- through the authorized Legal Hold lifecycle. Nothing here reads, updates or
-- expires `evidence_legal_holds`.
--
-- PURELY ADDITIVE. One nullable boolean on a table whose every row keeps its
-- current meaning — no existing contract stated this term, and NULL is exactly
-- "not granted", which is the behaviour those customers have today. No backfill
-- is possible and none is correct: inventing a grant here would be inventing a
-- contract term. Deployable on either image; re-running is a no-op.
--
-- Written in the Phase O-final pattern: the target table is checked for
-- existence first, because `enterprise_contracts` is itself a Phase-4 table and
-- a guard that silently skips is how a column goes missing under a later index.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'enterprise_contracts'
  ) THEN
    RAISE EXCEPTION
      'enterprise_contracts does not exist; the legal-hold contract term cannot be added';
  END IF;
END $$;

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "legal_hold_enabled" BOOLEAN;
