-- PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — EXPAND.
--
-- THE FINDING
-- ---------------------------------------------------------------------------
-- Ordinary revocation of an Organization membership was a physical DELETE.
-- `removeOrganizationMembership` closed the provenance grants first, so the
-- GRANT trail survived — but the membership row did not, so the system could
-- not answer "was this person a member, who removed them, when, and why?"
-- from the membership itself. There was also no SUSPENDED state: an
-- administrator wanting to pause someone's governance access had only the
-- irreversible option, so in practice they used it.
--
-- WHY THREE VALUES AND NOT FOUR
-- ---------------------------------------------------------------------------
-- ACTIVE / SUSPENDED / REVOKED, matching `TeamMemberStatus` exactly. PENDING
-- is deliberately absent: an unaccepted invitation is `organization_invites`'
-- business, and duplicating it here would create a second authority for the
-- same fact — which is the class of defect this whole exercise removes.
--
-- EXPAND ONLY. Every column is nullable or defaulted, so an existing row is
-- immediately valid and no reader changes behaviour until the code deploys.
-- The NOT NULL, the CHECKs and the unique index are 20271128000000, behind a
-- readiness gate that refuses rather than destroys.

-- ---------------------------------------------------------------------------
-- 1. The status enum.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrganizationMembershipStatus') THEN
    CREATE TYPE "OrganizationMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The lifecycle columns.
--
-- `status` defaults to ACTIVE so every EXISTING row is valid the moment this
-- runs. That default is the honest reading and not a guess: a membership row
-- exists today only if it was never removed, because removal was a DELETE.
-- The backfill states it explicitly anyway, so a row inserted between this
-- migration and that one is also covered.
--
-- `status_generation` starts at 0 and is incremented by every transition
-- inside the same guarded UPDATE that changes the status. A caller naming a
-- stale generation updates zero rows, which is what makes a concurrent
-- suspend/restore deterministic rather than last-writer-wins.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'organization_memberships'
  ) THEN
    RETURN;
  END IF;

  FOR col IN
    SELECT * FROM (VALUES
      ('status',                '"OrganizationMembershipStatus" NOT NULL DEFAULT ''ACTIVE'''),
      ('status_changed_at_utc', 'TIMESTAMPTZ(6)'),
      ('suspended_at_utc',      'TIMESTAMPTZ(6)'),
      ('suspended_by_user_id',  'UUID'),
      ('suspension_reason',     'VARCHAR(400)'),
      ('revoked_at_utc',        'TIMESTAMPTZ(6)'),
      ('revoked_by_user_id',    'UUID'),
      ('revocation_reason',     'VARCHAR(400)'),
      ('status_source',         'VARCHAR(32)'),
      ('valid_until_utc',       'TIMESTAMPTZ(6)'),
      ('status_generation',     'INTEGER NOT NULL DEFAULT 0')
    ) AS t(name, decl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'organization_memberships'
         AND column_name = col.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE "organization_memberships" ADD COLUMN %I %s',
        col.name, col.decl
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Attribution foreign keys.
--
-- SetNull, not Cascade: removing an administrator must never erase the record
-- of what they did.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'suspended_by_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_suspended_by_user_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_suspended_by_user_id_fkey" FOREIGN KEY ("suspended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'revoked_by_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_revoked_by_user_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Read indexes.
--
-- Every access decision after this change filters on status, and the platform
-- context lists a user's ACTIVE memberships on every page load.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_memberships'
       AND column_name = 'status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "organization_memberships_organization_id_status_idx" ON "organization_memberships" ("organization_id", "status")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "organization_memberships_user_id_status_idx" ON "organization_memberships" ("user_id", "status")';
  END IF;
END $$;
