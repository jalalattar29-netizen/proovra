-- One ACTIVE emergency grant per (organization, emergency user).
--
-- WHY
-- ---------------------------------------------------------------------------
-- `activateBreakGlass` creates unconditionally. Measured against a live
-- fixture: four simultaneous activations, each carrying its own genuinely
-- approved step-up challenge, produced FOUR overlapping ACTIVE grants for the
-- same organization and the same emergency user.
--
-- Every one of them was individually authorized, so this is not an
-- authorization hole. It is an operational one. The staff console lists live
-- emergency access over a customer's data, and revoking the grant an operator
-- can see leaves three more they cannot — emergency access that survives its
-- own revocation is the failure mode break-glass exists to bound.
--
-- A read-then-create in the service cannot close this: two callers both read
-- "none active" and both create. The exclusion has to be in the database.
--
-- WHY PARTIAL
-- ---------------------------------------------------------------------------
-- Only ACTIVE rows are exclusive. Revoked and expired grants are history and
-- must accumulate freely — a full unique index would make it impossible to
-- grant emergency access to the same person twice, ever.
--
-- BEHAVIOUR ON A DIRTY DATABASE
-- ---------------------------------------------------------------------------
-- A database already holding overlapping ACTIVE grants cannot build this
-- index, and the deploy stops. That is the correct outcome: converging live
-- emergency access is an operator decision about who currently holds
-- privilege over customer data, not something a migration should do while
-- nobody is watching. The index creation below reports the conflict rather
-- than silently skipping, because a silent skip leaves the invariant
-- unenforced on precisely the database that needed it.
--
-- FORWARD-ONLY. No column added, altered or dropped; no row read or written.

-- PRECONDITION 1 — CONFLICT CHECK
-- ---------------------------------------------------------------------------
-- Runs only when the columns it reads are present, so a table missing one
-- fails with the COLUMN GUARD's message below rather than a raw
-- "column does not exist". It is kept in its own block, ahead of the guard,
-- because the safety gate reads the guard out of a bounded window preceding
-- the CREATE INDEX and this block's operator guidance is long enough to push
-- the guard out of range.

DO $$
BEGIN
  -- NESTED, not `AND`-ed: PostgreSQL plans a whole boolean expression before
  -- evaluating it, so an `AND` here resolved the inner query's column
  -- references even when the guard was false and failed with a raw
  -- "column does not exist". A nested IF never plans the inner statement.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'emergency_access_grants'
       AND column_name = 'emergency_user_id'
  ) THEN
  IF EXISTS (
    SELECT 1 FROM emergency_access_grants WHERE status = 'ACTIVE'
     GROUP BY organization_id, emergency_user_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce one ACTIVE break-glass grant per (organization, emergency user): overlapping ACTIVE grants exist.'
      USING HINT =
        'Review the overlapping ACTIVE grants and revoke the redundant ones through the staff console, then re-run this migration. Do not merge them automatically.';
  END IF;
  END IF;
END
$$;

-- PRECONDITION 2 — COLUMN GUARD
-- ---------------------------------------------------------------------------
-- Immediately before the CREATE, naming every indexed column literally.

DO $$
DECLARE
  missing TEXT;
BEGIN
  missing := NULLIF(concat_ws(', ',
    CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'emergency_access_grants' AND column_name = 'organization_id')
      THEN 'organization_id' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'emergency_access_grants' AND column_name = 'emergency_user_id')
      THEN 'emergency_user_id' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'emergency_access_grants' AND column_name = 'status')
      THEN 'status' END), '');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'emergency_access_grants is missing column(s) %.', missing;
  END IF;
END
$$;

CREATE UNIQUE INDEX "emergency_access_grants_active_org_user_uk"
    ON "emergency_access_grants" ("organization_id", "emergency_user_id")
    WHERE "status" = 'ACTIVE';
