-- ============================================================================
-- PHASE 12B CLUSTER 8 — legacy legal-hold store removal.
--
-- ############################################################################
-- #  DO NOT APPLY THIS MIGRATION YET.                                        #
-- #                                                                          #
-- #  It may run ONLY when ALL of the following are true:                     #
-- #                                                                          #
-- #    1. 20271107000000_legal_hold_backfill has been APPLIED.               #
-- #    2. scripts/legal-hold-convergence-report.mjs has been re-run and      #
-- #       `protectedEvidenceCount` did NOT decrease versus the pre-backfill  #
-- #       run, and `blockingConflictCount` is 0.                             #
-- #    3. Every legacy row is converted — i.e. per store,                    #
-- #       total == the matching convergedFrom*Store count. A non-zero        #
-- #       residual means holds exist ONLY in a legacy table, and dropping    #
-- #       that table would DESTROY a preservation control.                   #
-- #    4. Zero runtime dependencies remain on `case_legal_holds` /           #
-- #       `legal_holds`: the effective-hold evaluator no longer reads them   #
-- #       and no service or worker queries them.                             #
-- #                                                                          #
-- #  As of authoring, (1) is FALSE — migrations are not applied in this      #
-- #  environment — and (4) is deliberately FALSE: the evaluator still reads  #
-- #  both legacy tables, because it must keep honouring holds that have not  #
-- #  been converted yet. Removing that read is the LAST step, not the first. #
-- ############################################################################
--
-- The guard block below enforces (3) at apply time. If a single unconverted
-- row exists, this migration RAISES and drops nothing. That guard is the
-- reason it is safe to have this file in the repository at all: it cannot
-- silently destroy a hold even if applied by mistake.
-- ============================================================================

-- ============================================================================
-- PHASE 12 POINT 3 — CONTRACT GUARD.
--
-- The drop is irreversible, so every prerequisite is measured IN THE DATABASE
-- rather than assumed from a script someone may or may not have run. Any
-- non-zero blocking count raises and drops NOTHING. The whole block is a
-- no-op once the legacy stores are already gone, so re-deployment is safe.
-- ============================================================================
DO $$
DECLARE
  unconverted_case int;
  unconverted_lifecycle int;
  duplicate_mapping int;
  unresolved_active int;
  invalid_target int;
  release_state_mismatch int;
  duplicate_mapping_probe int;
  canonical_col_missing int;
BEGIN
  -- Already contracted — nothing left to guard.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'case_legal_holds')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legal_holds') THEN
    RAISE NOTICE 'legal-hold contract guard: legacy stores already absent — nothing to drop.';
    RETURN;
  END IF;

  -- ---- 1. The canonical model must be present and complete ----------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'evidence_legal_holds'
  ) THEN
    RAISE EXCEPTION 'REFUSING to drop legacy legal-hold stores: canonical evidence_legal_holds does not exist.';
  END IF;

  SELECT count(*) INTO canonical_col_missing
  FROM (
    SELECT unnest(ARRAY['scope','source_store','source_row_id','historical','version',
                        'release_approval_state','organization_id']) AS c
  ) req
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence_legal_holds' AND column_name = req.c
  );
  IF canonical_col_missing > 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop legacy legal-hold stores: % canonical column(s) missing — apply 20271106000000_legal_hold_canonical first.',
      canonical_col_missing;
  END IF;

  -- The backfill's deterministic idempotency key must exist, which is the
  -- schema-level proof that 20271107000000 could have run at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'evidence_legal_holds'
      AND indexname = 'evidence_legal_holds_source_store_source_row_id_key'
  ) THEN
    RAISE EXCEPTION
      'REFUSING to drop legacy legal-hold stores: the backfill idempotency key (source_store, source_row_id) is absent.';
  END IF;

  -- ---- 2. Every legacy row maps to exactly one canonical row ---------------
  --
  -- PHASE 12 POINT 6 — the two counts below used to be static statements, so
  -- a database where exactly ONE legacy store had already been removed aborted
  -- with a bare `relation "case_legal_holds" does not exist` instead of the
  -- bounded refusal this guard is supposed to produce. The early-return above
  -- only fires when BOTH are absent. Each store is now measured only when it
  -- is actually present; an absent store has nothing left to convert.
  unconverted_case := 0;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'case_legal_holds') THEN
    EXECUTE $q$
      SELECT count(*) FROM "case_legal_holds" h
      WHERE NOT EXISTS (
        SELECT 1 FROM "evidence_legal_holds" x
        WHERE x."source_store" = 'CASE_LEGAL_HOLD'::"LegalHoldSourceStore"
          AND x."source_row_id" = h."id"
      )
    $q$ INTO unconverted_case;
  END IF;

  unconverted_lifecycle := 0;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legal_holds') THEN
    EXECUTE $q$
      SELECT count(*) FROM "legal_holds" h
      WHERE NOT EXISTS (
        SELECT 1 FROM "evidence_legal_holds" x
        WHERE x."source_store" = 'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore"
          AND x."source_row_id" = h."id"
      )
    $q$ INTO unconverted_lifecycle;
  END IF;

  SELECT count(*) INTO duplicate_mapping
  FROM (
    SELECT 1 FROM "evidence_legal_holds"
    WHERE "source_row_id" IS NOT NULL
    GROUP BY "source_store", "source_row_id" HAVING count(*) > 1
  ) d;

  -- ---- 3. No ACTIVE hold may remain unresolvable ---------------------------
  -- An ACTIVE historical row has no provable target, so the evaluator fails
  -- closed on it. Dropping the legacy store while one exists would destroy
  -- the only remaining evidence of what it protected.
  SELECT count(*) INTO unresolved_active
  FROM "evidence_legal_holds"
  WHERE "historical" = true AND "status" = 'ACTIVE';

  -- ---- 4. No canonical row may have an invalid scope/target ----------------
  SELECT count(*) INTO invalid_target
  FROM "evidence_legal_holds"
  WHERE "historical" = false
    AND NOT (
         ("scope" = 'EVIDENCE'  AND "evidence_id" IS NOT NULL)
      OR ("scope" = 'CASE'      AND "case_id" IS NOT NULL AND "evidence_id" IS NULL)
      OR ("scope" = 'WORKSPACE' AND "team_id" IS NOT NULL AND "evidence_id" IS NULL AND "case_id" IS NULL)
    );

  -- ---- 5. No release-state may have been lost in conversion ----------------
  -- A legacy row that is ACTIVE must never have arrived as released/expired:
  -- that would be a silent downgrade of a live preservation control.
  -- PHASE 12 POINT 6 — same partial-removal hazard as the counts above: each
  -- half is measured only when its store still exists.
  release_state_mismatch := 0;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'case_legal_holds') THEN
    EXECUTE $q$
      SELECT count(*)
      FROM "case_legal_holds" h
      JOIN "evidence_legal_holds" x
        ON x."source_store" = 'CASE_LEGAL_HOLD'::"LegalHoldSourceStore"
       AND x."source_row_id" = h."id"
      WHERE h."status"::text = 'ACTIVE' AND x."status" <> 'ACTIVE'
    $q$ INTO release_state_mismatch;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'legal_holds') THEN
    EXECUTE $q$
      SELECT count(*)
      FROM "legal_holds" h
      JOIN "evidence_legal_holds" x
        ON x."source_store" = 'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore"
       AND x."source_row_id" = h."id"
      WHERE h."state"::text = 'ACTIVE' AND x."status" <> 'ACTIVE'
    $q$ INTO duplicate_mapping_probe;
    release_state_mismatch := release_state_mismatch + duplicate_mapping_probe;
  END IF;

  IF unconverted_case > 0 OR unconverted_lifecycle > 0 OR duplicate_mapping > 0
     OR unresolved_active > 0 OR invalid_target > 0 OR release_state_mismatch > 0 THEN
    RAISE EXCEPTION
      'REFUSING to drop legacy legal-hold stores — readiness is NOT zero: unconverted_case=%, unconverted_lifecycle=%, duplicate_mapping=%, unresolved_active_historical=%, invalid_target=%, release_state_mismatch=%. Run 20271107000000_legal_hold_backfill and scripts/legal-hold-convergence-report.mjs, resolve every blocking class, then re-run.',
      unconverted_case, unconverted_lifecycle, duplicate_mapping,
      unresolved_active, invalid_target, release_state_mismatch;
  END IF;

  RAISE NOTICE 'legal-hold contract guard: readiness is zero — proceeding with the drop.';
END
$$;

DROP TABLE IF EXISTS "case_legal_holds";
DROP TABLE IF EXISTS "legal_holds";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseLegalHoldStatus') THEN
    DROP TYPE "CaseLegalHoldStatus";
  END IF;
END
$$;
