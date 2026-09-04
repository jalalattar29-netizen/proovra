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

DO $$
DECLARE
  conflicts INTEGER;
BEGIN
  SELECT COUNT(*) INTO conflicts
    FROM (
      SELECT organization_id, emergency_user_id
        FROM emergency_access_grants
       WHERE status = 'ACTIVE'
       GROUP BY organization_id, emergency_user_id
      HAVING COUNT(*) > 1
    ) AS overlapping;

  IF conflicts > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce one ACTIVE break-glass grant per (organization, emergency user): % overlapping group(s) exist.',
      conflicts
      USING HINT =
        'Review the overlapping ACTIVE grants and revoke the redundant ones through the staff console, then re-run this migration. Do not merge them automatically.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "emergency_access_grants_active_org_user_uk"
    ON "emergency_access_grants" ("organization_id", "emergency_user_id")
    WHERE "status" = 'ACTIVE';
