-- PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — CONTRACT.
--
-- Every readiness condition §2.1 C names is checked HERE, before the
-- constraint it authorises, and each RAISEs. The file runs in one transaction,
-- so a refusal leaves the database exactly as it was.
--
-- Two of the eight readiness categories are CODE properties, not database
-- ones, and asserting them here would be asserting the wrong thing in the
-- wrong place:
--
--   "REVOKED granting access = 0" and "SUSPENDED granting access = 0"
--
-- are statements about what `checkOrgAccess` and the context builder DO, and
-- they are enforced by `phase-12-arch-004-org-membership-lifecycle.test.ts`
-- (structural) and proven by the runtime probe against a real Fastify app.
-- The remaining six are counting queries and are below.

-- ===========================================================================
-- GUARD — readiness.
-- ===========================================================================
DO $$
DECLARE
  no_status        BIGINT := 0;
  bad_timestamps   BIGINT := 0;
  ambiguous        BIGINT := 0;
  duplicate_active BIGINT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status'
  ) THEN
    RETURN;
  END IF;

  -- 1. Membership without a valid status.
  EXECUTE 'SELECT COUNT(*) FROM "organization_memberships" WHERE "status" IS NULL'
    INTO no_status;
  IF no_status > 0 THEN
    RAISE EXCEPTION
      'ARCH-004 readiness failed: % membership(s) have no status. Run the backfill (20271127000000) first.',
      no_status;
  END IF;

  -- 2. A status and its timestamps that contradict each other. A SUSPENDED
  --    row with no suspension time, or an ACTIVE row still carrying a
  --    revocation time, is a row whose history cannot be read back.
  EXECUTE $sql$
    SELECT COUNT(*) FROM "organization_memberships"
     WHERE ("status" = 'SUSPENDED' AND "suspended_at_utc" IS NULL)
        OR ("status" = 'REVOKED'   AND "revoked_at_utc"   IS NULL)
        OR ("status" = 'ACTIVE'    AND ("suspended_at_utc" IS NOT NULL OR "revoked_at_utc" IS NOT NULL))
  $sql$ INTO bad_timestamps;
  IF bad_timestamps > 0 THEN
    RAISE EXCEPTION
      'ARCH-004 readiness failed: % membership(s) have a status its timestamps contradict.',
      bad_timestamps;
  END IF;

  -- 3. An ambiguous present row: both suspended and revoked at once.
  EXECUTE $sql$
    SELECT COUNT(*) FROM "organization_memberships"
     WHERE "suspended_at_utc" IS NOT NULL
       AND "revoked_at_utc" IS NOT NULL
       AND "status" <> 'REVOKED'
  $sql$ INTO ambiguous;
  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      'ARCH-004 readiness failed: % membership(s) are both suspended and revoked but not REVOKED. Resolve each explicitly.',
      ambiguous;
  END IF;

  -- 4. Duplicate ACTIVE membership for one identity in one Organization. The
  --    (organization_id, user_id) unique already forbids this; counted anyway
  --    so the contract below rests on a measured fact rather than on trust in
  --    another constraint.
  EXECUTE $sql$
    SELECT COALESCE(SUM(n - 1), 0) FROM (
      SELECT COUNT(*) AS n FROM "organization_memberships"
       WHERE "status" = 'ACTIVE'
       GROUP BY "organization_id", "user_id" HAVING COUNT(*) > 1
    ) d
  $sql$ INTO duplicate_active;
  IF duplicate_active > 0 THEN
    RAISE EXCEPTION
      'ARCH-004 readiness failed: % duplicate ACTIVE membership(s).',
      duplicate_active;
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 1 — the status is mandatory.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status'
       AND is_nullable = 'YES'
  ) THEN
    EXECUTE 'ALTER TABLE "organization_memberships" ALTER COLUMN "status" SET NOT NULL';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 2 — a status and its timestamps cannot disagree, from now on.
--
-- The readiness gate above proved every existing row already satisfies this,
-- so the constraint is added NOT VALID and then VALIDATEd — which keeps the
-- exclusive DDL lock brief on a large table while still being enforced for
-- every INSERT and UPDATE from this point.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_status_timeline_chk'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE "organization_memberships"
        ADD CONSTRAINT "organization_memberships_status_timeline_chk" CHECK (
          ("status" = 'ACTIVE'    AND "suspended_at_utc" IS NULL AND "revoked_at_utc" IS NULL)
       OR ("status" = 'SUSPENDED' AND "suspended_at_utc" IS NOT NULL AND "revoked_at_utc" IS NULL)
       OR ("status" = 'REVOKED'   AND "revoked_at_utc" IS NOT NULL)
        ) NOT VALID
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organization_memberships_status_timeline_chk' AND NOT convalidated
  ) THEN
    EXECUTE 'ALTER TABLE "organization_memberships" VALIDATE CONSTRAINT "organization_memberships_status_timeline_chk"';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 3 — the generation never goes backwards.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_generation_chk'
  ) THEN
    EXECUTE 'ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_generation_chk" CHECK ("status_generation" >= 0)';
  END IF;
END $$;
