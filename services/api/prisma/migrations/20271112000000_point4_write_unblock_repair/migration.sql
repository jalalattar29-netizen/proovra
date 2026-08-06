-- =============================================================================
-- PHASE 12 POINT 4/6 — write-unblock REPAIR. NON-DESTRUCTIVE. RELEASE A.
--
-- PHASE 12 POINT 6 — SPLIT out of the former
-- `20271112000000_point4_schema_authority_convergence`, which fixed a LIVE
-- production write failure by DROPPING columns. That put the only available
-- fix for a broken runtime write path inside a CONTRACT_DROP, which cannot be
-- deployed in the first release wave. The removal now lives in
-- `20271117000000_point4_schema_authority_contract` (Release D); this file
-- carries the part that unblocks the writes, and it drops nothing.
--
-- THE DEFECT
--   Phase R7 renamed several Prisma FIELDS while deliberately keeping the
--   original physical column via `@map`. A later catch-up migration then read
--   the renamed datamodel as though the fields were NEW and ADDED a second
--   physical column for each — three of them NOT NULL with no default.
--
--   The runtime writes only the @map-ed original, so Prisma never sends the
--   duplicate. On any database carrying the full migration history:
--
--     prisma.crossOrgReviewGrant.create()      -> null value in column "created_by_user_id"
--     prisma.delegatedAdminGrant.create()      -> null value in column "grantee_user_id"
--     prisma.redactionPolicyAssignment.create() -> null value in column "policy_version_id"
--
--   Delegated-admin grants, cross-org review grants and redaction policy
--   assignments cannot be created at all.
--
-- THE REPAIR
--   Relax the NOT NULL on the three orphaned duplicates. That is the whole
--   fix: with the constraint gone the insert succeeds and the duplicate simply
--   stays NULL, which is the truth — nothing writes it. No row is read, no row
--   is written, no column is removed, and the physical removal stays available
--   for Release D once the observation window closes.
--
--   Every relaxation is guarded on the column actually existing AND actually
--   being NOT NULL, so this file is a clean no-op on a database that never
--   acquired the duplicates (and on one where Release D already removed them).
--
-- SECTION 2 — security_events.severity type convergence (unchanged, moved
--   here because it is a REPAIR, not a removal).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SECTION 1 — relax the orphaned NOT NULL duplicates
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT * FROM (
      VALUES
        ('cross_org_review_grants',       'created_by_user_id'),
        ('delegated_admin_grants',        'grantee_user_id'),
        ('redaction_policy_assignments',  'policy_version_id')
    ) AS v(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = pair.tbl
        AND column_name = pair.col
        AND is_nullable = 'NO'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', pair.tbl, pair.col);
      RAISE NOTICE 'point4 write-unblock: %.% relaxed to NULLABLE (orphaned duplicate column; physical removal deferred to 20271117000000).', pair.tbl, pair.col;
    END IF;
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- SECTION 2 — security_events.severity: converge migration history with
-- production and with the datamodel.
--
-- The datamodel declares `severity String @db.VarChar(16)` with a comment
-- recording WHY: a live incident (/v1/me/inbox filtering severity:"HIGH"
-- generating `WHERE "severity" = $1::"SecurityEventSeverity"`) proved the
-- production column is VARCHAR, not the enum. The datamodel was pinned to
-- production reality.
--
-- The MIGRATION HISTORY, however, still builds the column as the
-- `SecurityEventSeverity` enum, so a database created from scratch diverges
-- from both production and the datamodel — and `migrate diff` proposes
-- dropping and recreating a live column to reconcile it.
--
-- This converts the column to VARCHAR(16) only where it is still the enum.
-- Enum -> varchar is a widening conversion: every existing label is preserved
-- verbatim. On production (already VARCHAR) the guard makes this a no-op.
-- The enum TYPE is deliberately left in place: other columns may reference it,
-- and dropping a type is not needed to converge this column.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'security_events'
      AND column_name = 'severity'
      AND udt_name = 'SecurityEventSeverity'
  ) THEN
    ALTER TABLE security_events
      ALTER COLUMN severity DROP DEFAULT;
    ALTER TABLE security_events
      ALTER COLUMN severity TYPE VARCHAR(16) USING severity::text;
    ALTER TABLE security_events
      ALTER COLUMN severity SET DEFAULT 'INFO';
  END IF;
END
$$;
