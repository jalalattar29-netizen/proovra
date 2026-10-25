-- ENTERPRISE CONTRACT TERM: ASSIGNMENT REQUIRES TEAM PLACEMENT
-- (members audit, unassigned-member decision, 2026-10-26).
--
-- On PRO and TEAM, a non-owner workspace member must be placed in an ACTIVE
-- Collaboration Team before they can be given Team tasks, reviewer
-- assignments, queue work or escalations. Enterprise follows its contract:
-- direct eligible assignment (capability + object reach, no placement) is the
-- Enterprise default, and a contract may state that placement is required.
--
-- ONE nullable BOOLEAN. NULL and FALSE keep today's Enterprise behaviour
-- (direct eligible assignment); only TRUE adds the placement prerequisite.
-- No backfill is possible or correct: no contract has stated this term.
-- EXPAND only, behind the Phase O-final table-existence guard; idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'enterprise_contracts'
  ) THEN
    ALTER TABLE "enterprise_contracts"
      ADD COLUMN IF NOT EXISTS "assignment_requires_team_placement" BOOLEAN;
  END IF;
END $$;
