-- =============================================================================
-- Track 1B closure — CONTRACT: drop the legacy Evidence.case_id mirror column.
--
-- ############################################################################
-- #  RELEASE D ONLY. This migration MUST NOT be present in the deployment    #
-- #  artifact for Release A, B or C.                                         #
-- #                                                                          #
-- #  It may run ONLY when ALL of the following are true:                     #
-- #                                                                          #
-- #    1. 20271103000000_case_evidence_link_canonical is APPLIED.            #
-- #    2. 20271104000000_case_evidence_link_integrity is APPLIED.            #
-- #    3. The canonical-read runtime (Release C) is deployed and the          #
-- #       observation window has passed with zero legacy accesses.           #
-- #    4. `node scripts/backfill-case-evidence-links.mjs --check` reports     #
-- #       every blocking category at zero.                                   #
-- ############################################################################
--
-- PHASE 12 POINT 6 — SPLIT out of the former
-- `20271104000000_evidence_case_id_removal`, which performed the backfill,
-- added the foreign keys AND dropped the column in one file. Those are two
-- different release phases; see 20271104000000_case_evidence_link_integrity.
--
-- Forward-only. Touches ONLY `evidence.case_id` (drop, plus any FK/index on
-- it). No other column or history is modified. No row is deleted anywhere.
-- =============================================================================

-- (a) CONTRACT GUARD.
--
--     The column drop is irreversible, so it is gated on readiness proven
--     IN THE DATABASE rather than on a human having run a script first.
--     Every blocking category below is measured here; any non-zero count
--     raises and drops NOTHING. The guard is a no-op once the column is
--     already gone (idempotent re-deployment).
DO $$
DECLARE
  missing_link int;
  cross_workspace int;
  orphan_case_ptr int;
  team_mismatch int;
  duplicate_link int;
  canonical_absent int;
  fk_missing int;
BEGIN
  -- Nothing to guard once the legacy column no longer exists.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'case_id'
  ) THEN
    RAISE NOTICE 'evidence.case_id contract guard: column already absent — nothing to drop.';
    RETURN;
  END IF;

  -- The canonical authority must exist before the legacy mirror is removed.
  SELECT count(*) INTO canonical_absent
  FROM information_schema.tables WHERE table_name = 'case_evidence_links';
  IF canonical_absent = 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop evidence.case_id: the canonical case_evidence_links table does not exist.';
  END IF;

  -- The EXPAND step's referential integrity must be in place and VALIDATED.
  -- Its absence means 20271104000000_case_evidence_link_integrity never ran,
  -- so the canonical table has no proven integrity to inherit the authority.
  SELECT count(*) INTO fk_missing
  FROM (
    SELECT unnest(ARRAY['case_evidence_links_case_id_fkey',
                        'case_evidence_links_evidence_id_fkey']) AS c
  ) req
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'case_evidence_links'::regclass
      AND conname = req.c
      AND convalidated
  );
  IF fk_missing > 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop evidence.case_id: % validated foreign key(s) missing on case_evidence_links — apply 20271104000000_case_evidence_link_integrity first.',
      fk_missing;
  END IF;

  -- 1. Every non-null legacy pointer at a LIVE case must have a canonical link.
  SELECT count(*) INTO missing_link
  FROM evidence e
  JOIN cases c ON c.id = e.case_id
  WHERE e.case_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM case_evidence_links l
      WHERE l.case_id = e.case_id AND l.evidence_id = e.id
    );

  -- 2. A legacy pointer at a case that no longer exists cannot be converted;
  --    it is an unresolved association, reported rather than discarded.
  SELECT count(*) INTO orphan_case_ptr
  FROM evidence e
  WHERE e.case_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.id = e.case_id);

  -- 3. No canonical link may cross a workspace boundary.
  SELECT count(*) INTO cross_workspace
  FROM case_evidence_links l
  JOIN cases c ON c.id = l.case_id
  JOIN evidence e ON e.id = l.evidence_id
  WHERE c.team_id IS DISTINCT FROM e.team_id
     OR l.team_id IS DISTINCT FROM e.team_id;

  -- 4. The legacy pointer's workspace must agree with the canonical link's.
  SELECT count(*) INTO team_mismatch
  FROM evidence e
  JOIN case_evidence_links l
    ON l.case_id = e.case_id AND l.evidence_id = e.id
  WHERE e.case_id IS NOT NULL
    AND l.team_id IS DISTINCT FROM e.team_id;

  -- 5. Duplicate links for one (case, evidence) pair are non-deterministic.
  SELECT count(*) INTO duplicate_link
  FROM (
    SELECT 1 FROM case_evidence_links
    GROUP BY case_id, evidence_id HAVING count(*) > 1
  ) d;

  IF missing_link > 0 OR orphan_case_ptr > 0 OR cross_workspace > 0
     OR team_mismatch > 0 OR duplicate_link > 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop evidence.case_id — readiness is NOT zero: missing_link=%, orphan_case_pointer=%, cross_workspace_link=%, team_mismatch=%, duplicate_link=%. Run scripts/backfill-case-evidence-links.mjs --check, resolve, then re-run.',
      missing_link, orphan_case_ptr, cross_workspace, team_mismatch, duplicate_link;
  END IF;

  RAISE NOTICE 'evidence.case_id contract guard: readiness is zero — proceeding with the drop.';
END
$$;

-- (b) Drop any FK/index on evidence.case_id, then the column itself.
--     (Historically the column carried no FK and no dedicated index;
--     these IF EXISTS drops are defensive.)
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_case_id_fkey;
DROP INDEX IF EXISTS evidence_case_id_idx;
DROP INDEX IF EXISTS idx_evidence_case_id;

-- The drop is skipped when the column is already absent, so the whole file
-- re-runs as a clean no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'case_id'
  ) THEN
    EXECUTE 'ALTER TABLE evidence DROP COLUMN case_id';
  END IF;
END $$;
