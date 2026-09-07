-- =============================================================================
-- WCR-07 — Enterprise collaboration capacity becomes contractual.
--
-- THE DEFECT THIS CLOSES
-- -----------------------------------------------------------------------------
-- `resolveEnterpriseContractLimits` already turned a contract row into
-- enforceable seats, storage, evidence records and AI operations. Collaboration
-- was not in that list, so two dimensions of an Enterprise agreement were
-- decided by flat constants in the self-serve catalog instead:
--
--   * how many Collaboration Teams a workspace may hold  — a flat 1000;
--   * how many people may sit inside one of them         — a flat 500.
--
-- The second is the one that bites. The per-group ceiling is reconciled down to
-- the seat entitlement, so an organization contracted for 800 seats could put
-- only 500 of them in a single group — a catalog placeholder quietly capping a
-- signed contract. And no contract could state how many groups it bought,
-- because there was nowhere to write it.
--
-- THE RULE, UNCHANGED
-- -----------------------------------------------------------------------------
-- Identical semantics to `evidence_records_per_month` and
-- `ai_operations_per_month`, which this migration deliberately imitates rather
-- than inventing a third convention:
--
--   NULL      the contract is SILENT — the canonical ENTERPRISE catalog default
--             governs, and surfaces render "Contract-managed" rather than
--             publishing a fallback as though it were a sold number;
--   a value   ENFORCED, not merely displayed. It wins outright over the
--             catalog: no max(), no floor, because taking a max() with a
--             placeholder sells capacity nobody agreed to.
--
-- Status still fails closed upstream: `resolveEnterpriseContractLimits` returns
-- NO_CONTRACT_LIMITS for DRAFT / PENDING_ACTIVATION / SUSPENDED / TERMINATED, so
-- neither column is read at all unless the contract is ACTIVE.
--
-- PURELY ADDITIVE. Two nullable columns on a table whose every row keeps its
-- current meaning: an existing contract states nothing about collaboration, so
-- it resolves exactly as it did before this migration. No backfill is possible
-- and none is correct — inventing a number here would be inventing a contract
-- term. Deployable on either image; re-running is a no-op.
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
      'enterprise_contracts does not exist; the contract-limits columns cannot be added';
  END IF;
END $$;

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "collaboration_teams_max" INTEGER;

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "collaboration_team_members_max" INTEGER;

-- A contract term is a positive whole number or the absence of a term. Zero and
-- negatives are not smaller contracts, they are data errors, and the resolver
-- reads a non-positive value as "silent" — which would promote the error into
-- the catalog default and hide it. The writer normalises on the way in
-- (`normalizeContractAllowance`); these constraints make the database refuse it
-- too, so a hand-written UPDATE cannot introduce what the service rejects.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enterprise_contracts_collaboration_teams_max_positive'
  ) THEN
    ALTER TABLE "enterprise_contracts"
      ADD CONSTRAINT "enterprise_contracts_collaboration_teams_max_positive"
      CHECK ("collaboration_teams_max" IS NULL OR "collaboration_teams_max" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enterprise_contracts_collaboration_members_max_positive'
  ) THEN
    ALTER TABLE "enterprise_contracts"
      ADD CONSTRAINT "enterprise_contracts_collaboration_members_max_positive"
      CHECK ("collaboration_team_members_max" IS NULL OR "collaboration_team_members_max" > 0);
  END IF;
END $$;
