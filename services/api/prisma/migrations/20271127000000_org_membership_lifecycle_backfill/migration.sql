-- PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — BACKFILL.
--
-- WHAT CAN AND CANNOT BE RECONSTRUCTED
-- ---------------------------------------------------------------------------
-- Before this change, removal was a physical DELETE. That has an unavoidable
-- consequence for the backfill, and it is worth stating plainly rather than
-- papering over:
--
--   * EVERY SURVIVING ROW IS ACTIVE. Not a guess — a structural fact. A row
--     exists today if and only if nobody removed it, because removal deleted
--     it. There is no surviving row that "was suspended", because SUSPENDED
--     did not exist, and none that "was revoked", because revocation erased
--     the row.
--
--   * HISTORICALLY DELETED MEMBERSHIPS CANNOT BE RECONSTRUCTED, and this
--     migration does not pretend otherwise. It invents no REVOKED rows for
--     people who were removed before today. The evidence for those removals
--     lives where it always did — in `membership_grants` (closed grants) and
--     the audit trail — and inventing membership rows from it would be
--     fabricating a lifecycle the database never recorded.
--
-- So the backfill is deliberately small: it states ACTIVE explicitly (covering
-- any row inserted between the expand and now), and stamps
-- `status_changed_at_utc` from `created_at` so the timeline is not null. It
-- writes no suspension, no revocation, and no actor it does not have.
--
-- Re-runnable: every statement is conditioned so a second run changes zero
-- rows.

-- ---------------------------------------------------------------------------
-- 1. Status — explicit, not left to the column default.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status'
  ) THEN
    EXECUTE $sql$
      UPDATE "organization_memberships"
         SET "status" = 'ACTIVE'
       WHERE "status" IS NULL
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The status timeline starts when the membership did.
--
--    `created_at` is the only durable evidence of when this membership reached
--    its current state, because it has never left that state.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status_changed_at_utc'
  ) THEN
    EXECUTE $sql$
      UPDATE "organization_memberships"
         SET "status_changed_at_utc" = "created_at"
       WHERE "status_changed_at_utc" IS NULL
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Provenance — the honest value is "we do not know which authority created
--    this row", recorded as LEGACY_BACKFILL rather than guessed as MANUAL.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status_source'
  ) THEN
    EXECUTE $sql$
      UPDATE "organization_memberships"
         SET "status_source" = 'LEGACY_BACKFILL'
       WHERE "status_source" IS NULL
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Generation — every surviving row is at generation 0, its initial state.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status_generation'
  ) THEN
    EXECUTE 'UPDATE "organization_memberships" SET "status_generation" = 0 WHERE "status_generation" IS NULL';
  END IF;
END $$;
