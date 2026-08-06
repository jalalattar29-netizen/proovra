-- =============================================================================
-- PHASE 12 POINT 6 — legal-hold scope/target CHECK: tighten to the strict
-- EVIDENCE branch. RELEASE D ONLY.
--
-- ############################################################################
-- #  Prerequisites:                                                          #
-- #    1. 20271106000000_legal_hold_canonical is APPLIED (relaxed CHECK).    #
-- #    2. 20271107000000_legal_hold_backfill is APPLIED.                     #
-- #    3. The Release-C runtime is deployed: the canonical placement command #
-- #       (services/api/src/services/governance/legal-hold.service.ts)       #
-- #       writes case_id = NULL for scope = 'EVIDENCE'.                      #
-- #    4. The observation window has passed with EVIDENCE_WITH_CASE_TAG at   #
-- #       zero in scripts/legal-hold-convergence-report.mjs.                 #
-- ############################################################################
--
-- WHY IT IS A SEPARATE RELEASE
--   `20271106000000_legal_hold_canonical` runs while the PRE-cutover build is
--   still serving traffic, and that build passes a caller-supplied `caseId`
--   straight into an EVIDENCE-scoped hold. Installing
--   `EVIDENCE ⇒ case_id IS NULL` at expand time would have made the database
--   reject the next case-contextual hold the deployed runtime tried to place —
--   a preservation control failing at the moment an operator reaches for it.
--   So expand installs the relaxed form and the tightening waits here.
--
-- WHAT IT DOES NOT DO
--   It NEVER blanks `case_id` to make the constraint pass. A tagged row is
--   governance context ("hold placed on this record, arising from that case")
--   and destroying it to satisfy a constraint is exactly the failure this
--   phase forbids. If any tagged row remains, the migration RAISES, names the
--   count and leaves the relaxed constraint in place — every row and every
--   constraint survives unchanged.
--
-- Idempotent: a no-op once the strict form is installed.
-- =============================================================================

DO $$
DECLARE
  tagged_evidence_rows bigint;
  current_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evidence_legal_holds'
  ) THEN
    RAISE EXCEPTION
      'REFUSING to tighten the legal-hold scope/target CHECK: evidence_legal_holds does not exist — apply 20271106000000_legal_hold_canonical first.';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO current_def
  FROM pg_constraint
  WHERE conname = 'evidence_legal_holds_scope_target_chk'
    AND conrelid = 'public.evidence_legal_holds'::regclass;

  IF current_def IS NULL THEN
    RAISE EXCEPTION
      'REFUSING to tighten the legal-hold scope/target CHECK: the expand-step constraint evidence_legal_holds_scope_target_chk is absent — apply 20271106000000_legal_hold_canonical first.';
  END IF;

  -- Already strict — nothing to do.
  IF current_def LIKE '%case_id IS NULL%' AND current_def LIKE '%evidence_id IS NOT NULL%' THEN
    IF position('evidence_id IS NOT NULL AND case_id IS NULL' in replace(current_def, '"', '')) > 0
       OR position('case_id IS NULL AND evidence_id IS NOT NULL' in replace(current_def, '"', '')) > 0 THEN
      RAISE NOTICE 'legal-hold scope/target CHECK is already strict — no change.';
      RETURN;
    END IF;
  END IF;

  SELECT count(*) INTO tagged_evidence_rows
  FROM "evidence_legal_holds"
  WHERE "historical" = false AND "scope" = 'EVIDENCE' AND "case_id" IS NOT NULL;

  IF tagged_evidence_rows > 0 THEN
    RAISE EXCEPTION
      'REFUSING to tighten the legal-hold scope/target CHECK: % EVIDENCE-scoped hold(s) still carry a contextual case_id tag. The tag is governance context and is NOT blanked to make a constraint pass. Resolve them (see EVIDENCE_WITH_CASE_TAG in scripts/legal-hold-convergence-report.mjs), then re-run. Nothing was changed.',
      tagged_evidence_rows;
  END IF;

  ALTER TABLE "evidence_legal_holds"
    DROP CONSTRAINT "evidence_legal_holds_scope_target_chk";

  ALTER TABLE "evidence_legal_holds"
    ADD CONSTRAINT "evidence_legal_holds_scope_target_chk" CHECK (
      "historical" = true
      OR ("scope" = 'EVIDENCE' AND "evidence_id" IS NOT NULL AND "case_id" IS NULL)
      OR ("scope" = 'CASE' AND "case_id" IS NOT NULL AND "evidence_id" IS NULL)
      OR ("scope" = 'WORKSPACE' AND "team_id" IS NOT NULL AND "evidence_id" IS NULL AND "case_id" IS NULL)
    ) NOT VALID;
  ALTER TABLE "evidence_legal_holds" VALIDATE CONSTRAINT "evidence_legal_holds_scope_target_chk";

  RAISE NOTICE 'legal-hold scope/target CHECK tightened to the strict EVIDENCE branch (0 tagged rows).';
END
$$;
