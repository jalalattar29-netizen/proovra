-- =============================================================================
-- PHASE 12 POINT 4/6 — schema-authority CONTRACT. RELEASE D ONLY.
--
-- ############################################################################
-- #  This migration MUST NOT be present in the deployment artifact for       #
-- #  Release A, B or C.                                                      #
-- #                                                                          #
-- #  Prerequisites:                                                          #
-- #    1. 20271112000000_point4_write_unblock_repair is APPLIED.             #
-- #    2. The Release-C runtime is deployed and the observation window has   #
-- #       passed with zero reads or writes of the objects removed here.      #
-- ############################################################################
--
-- PHASE 12 POINT 6 — SPLIT out of the former
-- `20271112000000_point4_schema_authority_convergence`. That file mixed a
-- REPAIR that unblocks live production writes with the destructive removal of
-- the same columns; the repair now ships in Release A and only the removal
-- remains here.
--
-- SECTION 1 — five DUPLICATE COLUMNS, all written by nothing.
--
--   Canonical column (written by the runtime)  | duplicate (written by nothing)
--   -------------------------------------------+--------------------------------
--   cross_org_review_grants.granted_by_user_id | created_by_user_id
--   delegated_admin_grants.granted_to_user_id  | grantee_user_id
--   redaction_policy_assignments.version_id    | policy_version_id
--   redaction_policy_assignments.revoked_at    | revoked_at_utc
--   redaction_policy_versions.published_at     | published_at_utc
--
--   The guard refuses the drop if any row holds a duplicate value that
--   DIVERGES from its canonical twin — divergence would mean real data lives
--   only in the duplicate, and that is an operator decision, not a migration's.
--
--   PHASE 12 POINT 6 — the divergence test was `duplicate IS DISTINCT FROM
--   canonical`, which counts a NULL duplicate beside a populated canonical as
--   divergence. That is exactly the shape every row written after
--   20271112000000_point4_write_unblock_repair has (Prisma never sends the
--   duplicate, so it stays NULL) and the shape every pre-existing row with a
--   nullable duplicate already had. As written the guard would have RAISED on
--   healthy data and made this contract permanently unrunnable. A NULL
--   duplicate holds no data and therefore nothing can be lost by dropping it,
--   so the test now fires only on a duplicate that is NOT NULL and disagrees.
--
-- SECTION 2 — three SUPERSEDED SINGULAR TABLES.
--
--   `governance_policy_audit`, `redaction_activity` and
--   `redaction_policy_audit` were created by earlier migrations and then
--   superseded by the canonical plural tables the Prisma models map to
--   (`governance_policy_audits`, `redaction_activities`,
--   `redaction_policy_audits`), which ARE actively read and written through
--   Prisma delegates. The singular tables have zero runtime references of any
--   kind. They are dropped only when empty; a non-empty legacy table RAISES so
--   an operator can migrate or export the rows first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SECTION 1 — duplicate columns
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  pair record;
  diverged bigint;
BEGIN
  FOR pair IN
    SELECT * FROM (
      VALUES
        ('cross_org_review_grants',      'created_by_user_id', 'granted_by_user_id'),
        ('delegated_admin_grants',       'grantee_user_id',    'granted_to_user_id'),
        ('redaction_policy_assignments', 'policy_version_id',  'version_id'),
        ('redaction_policy_assignments', 'revoked_at_utc',     'revoked_at'),
        ('redaction_policy_versions',    'published_at_utc',   'published_at')
    ) AS v(tbl, duplicate_col, canonical_col)
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = pair.tbl AND column_name = pair.duplicate_col
    );

    -- The canonical twin must exist, otherwise the "duplicate" is the only
    -- copy of the value and dropping it WOULD destroy data.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = pair.tbl AND column_name = pair.canonical_col
    ) THEN
      RAISE EXCEPTION
        'REFUSING to drop %.%: the canonical column %.% does not exist, so the duplicate is the only copy of this value.',
        pair.tbl, pair.duplicate_col, pair.tbl, pair.canonical_col;
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS DISTINCT FROM %I',
      pair.tbl, pair.duplicate_col, pair.duplicate_col, pair.canonical_col
    ) INTO diverged;

    IF diverged > 0 THEN
      RAISE EXCEPTION
        'REFUSING to drop %.%: % row(s) hold a non-null value that differs from the canonical %.%. Reconcile them before re-running — a migration must not discard the only copy of a value.',
        pair.tbl, pair.duplicate_col, diverged, pair.tbl, pair.canonical_col;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP COLUMN %I', pair.tbl, pair.duplicate_col);
    RAISE NOTICE 'point4 contract: dropped duplicate column %.% (0 divergent rows).', pair.tbl, pair.duplicate_col;
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 2 — superseded singular tables
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  rows_left bigint;
  legacy_table text;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY[
    'governance_policy_audit',
    'redaction_activity',
    'redaction_policy_audit'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=legacy_table) THEN
      EXECUTE format('SELECT count(*) FROM %I', legacy_table) INTO rows_left;
      IF rows_left > 0 THEN
        RAISE EXCEPTION
          'REFUSING to drop superseded table %: it still holds % row(s). Export or migrate them into the canonical plural table first — a migration must not destroy audit history.',
          legacy_table, rows_left;
      END IF;
      EXECUTE format('DROP TABLE %I', legacy_table);
    END IF;
  END LOOP;
END
$$;
