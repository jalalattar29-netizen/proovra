-- =============================================================================
-- Reviewer operations become a contract term an Enterprise agreement can
-- EXCLUDE.
--
-- THE COMMERCIAL CONTRACT
-- -----------------------------------------------------------------------------
-- FREE, Pay-per-evidence and PRO do not include reviewer operations; TEAM
-- does; ENTERPRISE includes advanced reviewer workflows when the organization
-- contract includes them. The catalog (`PlanCapabilities
-- .reviewerOperationsIncluded`) could state the first three, but the contract
-- had nowhere to say "this Enterprise customer did not buy reviewer
-- operations", so `workspaceIncludesReviewerOperations` answered ENTERPRISE
-- from the plan string alone.
--
-- WHY SILENCE MEANS INCLUDED HERE (the opposite of `legal_hold_enabled`)
-- -----------------------------------------------------------------------------
-- Legal Hold had never been granted to anyone, so NULL = not granted kept every
-- existing row's behaviour. Reviewer operations are the reverse: every
-- Enterprise customer has them today. Reading NULL as "not granted" would
-- withdraw them from every existing Enterprise organization on deploy, a
-- commercial change nobody signed. So:
--
--   NULL / TRUE   INCLUDED — the ENTERPRISE catalog answer, what every
--                 existing row means today.
--   FALSE         EXCLUDED, while the contract is ACTIVE.
--
-- The term cannot GRANT anything: FREE, PAYG and PRO are refused by the
-- catalog before the contract is read, so a TRUE on a lower plan is inert.
--
-- WHAT IT CANNOT DO
-- -----------------------------------------------------------------------------
-- It governs NEW reviewer-operations work only. It deletes, rewrites and hides
-- nothing: review workflows, decisions, rounds, escalations and their history
-- are untouched, and no row of any other table is read or written.
--
-- PURELY ADDITIVE. One nullable boolean; no default, no backfill (NULL is
-- exactly today's behaviour), no index, no constraint. Safe on either image:
-- an older image never selects the column; a newer one finds NULL and gives
-- the answer the product gave before. Re-running is a no-op.
--
-- Written in the Phase O-final pattern its neighbour uses: the target table is
-- checked for existence first.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'enterprise_contracts'
  ) THEN
    RAISE EXCEPTION
      'enterprise_contracts does not exist; the reviewer-operations contract term cannot be added';
  END IF;
END $$;

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "reviewer_operations_enabled" BOOLEAN;
