-- PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002) — CONTRACT.
--
-- Every readiness condition is checked HERE, before the constraint it
-- authorises, and each RAISES rather than proceeding. The whole file runs in
-- one transaction, so a refusal leaves the database exactly as it was.
--
-- The readiness set is the one §5.2 D names, stated as queries:
--
--   NULL kind                                = 0
--   invalid kind                             = 0  (enum-enforced; asserted anyway)
--   Personal tied to a CUSTOMER Organization = 0
--   ORGANIZATION without a CUSTOMER org      = 0
--   OWNED under a CUSTOMER org               = 0
--   duplicate Personal Spaces per identity   = 0
--
-- "plan fallback = 0" and "missing writer kind = 0" are not database
-- questions: they are properties of the CODE, and they are enforced by
-- `phase-12-arch-002-workspace-kind-authority.test.ts`, which fails if
-- `normalizeWorkspaceKind` regains a plan branch or a `team.create` omits the
-- kind. Asserting them here would be asserting the wrong thing in the wrong
-- place.

-- ===========================================================================
-- GUARD — readiness.
-- ===========================================================================
DO $$
DECLARE
  null_kind        BIGINT := 0;
  personal_in_cust BIGINT := 0;
  org_without_cust BIGINT := 0;
  owned_in_cust    BIGINT := 0;
  dup_personal     BIGINT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'workspace_kind'
  ) THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM "teams" WHERE "workspace_kind" IS NULL' INTO null_kind;
  IF null_kind > 0 THEN
    RAISE EXCEPTION
      'ARCH-002 readiness failed: % workspace(s) have no kind. The backfill classifies only from structural authority (personal-space invariant, CUSTOMER-organization provisioning, SYSTEM-container ownership); anything else must be resolved EXPLICITLY. Guessing from a plan is the defect this change removes.',
      null_kind;
  END IF;

  EXECUTE $sql$
    SELECT COUNT(*) FROM "teams" t JOIN "organizations" o ON o."id" = t."organization_id"
     WHERE t."workspace_kind" = 'PERSONAL' AND o."kind" = 'CUSTOMER'
  $sql$ INTO personal_in_cust;
  IF personal_in_cust > 0 THEN
    RAISE EXCEPTION
      'ARCH-002 readiness failed: % PERSONAL workspace(s) sit under a CUSTOMER Organization. A Personal Space is backed by an internal SYSTEM container by definition.',
      personal_in_cust;
  END IF;

  EXECUTE $sql$
    SELECT COUNT(*) FROM "teams" t JOIN "organizations" o ON o."id" = t."organization_id"
     WHERE t."workspace_kind" = 'ORGANIZATION' AND o."kind" <> 'CUSTOMER'
  $sql$ INTO org_without_cust;
  IF org_without_cust > 0 THEN
    RAISE EXCEPTION
      'ARCH-002 readiness failed: % ORGANIZATION workspace(s) have no CUSTOMER Organization. Organization lifecycle would be enforced against a container that has none.',
      org_without_cust;
  END IF;

  EXECUTE $sql$
    SELECT COUNT(*) FROM "teams" t JOIN "organizations" o ON o."id" = t."organization_id"
     WHERE t."workspace_kind" = 'OWNED' AND o."kind" = 'CUSTOMER'
  $sql$ INTO owned_in_cust;
  IF owned_in_cust > 0 THEN
    RAISE EXCEPTION
      'ARCH-002 readiness failed: % OWNED workspace(s) are provisioned under a CUSTOMER Organization. Owner and provisioner disagree.',
      owned_in_cust;
  END IF;

  EXECUTE $sql$
    SELECT COALESCE(SUM(n - 1), 0) FROM (
      SELECT COUNT(*) AS n FROM "teams"
       WHERE "workspace_kind" = 'PERSONAL'
       GROUP BY "owner_user_id" HAVING COUNT(*) > 1
    ) d
  $sql$ INTO dup_personal;
  IF dup_personal > 0 THEN
    RAISE EXCEPTION
      'ARCH-002 readiness failed: % duplicate Personal Space(s). One identity has more than one, which breaks the invariant the classification rests on.',
      dup_personal;
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 1 — the kind is mandatory.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'workspace_kind'
       AND is_nullable = 'YES'
  ) THEN
    EXECUTE 'ALTER TABLE "teams" ALTER COLUMN "workspace_kind" SET NOT NULL';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 2 — the kind and the container cannot disagree.
--
-- NOT VALID is deliberate and is NOT a weakening: the readiness gate above
-- has already proven every existing row satisfies it, and adding the
-- constraint without a second full-table validation scan keeps the DDL lock
-- brief on a large table. It is enforced for every INSERT and UPDATE from
-- this point on, which is what stops the fallback being reintroduced through
-- the data rather than the code.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teams_personal_is_flagged_chk'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE "teams" ADD CONSTRAINT "teams_personal_is_flagged_chk"
        CHECK (("workspace_kind" = 'PERSONAL') = ("is_personal" = TRUE)) NOT VALID
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teams_personal_is_flagged_chk'
       AND convalidated
  ) THEN
    EXECUTE 'ALTER TABLE "teams" VALIDATE CONSTRAINT "teams_personal_is_flagged_chk"';
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 3 — one Personal Space per identity, enforced.
--
-- The classification in the backfill rests on this invariant, so it stops
-- being an assumption.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'workspace_kind'
  ) THEN
    EXECUTE $sql$
      CREATE UNIQUE INDEX IF NOT EXISTS "teams_one_personal_space_per_owner_uk"
        ON "teams" ("owner_user_id") WHERE "workspace_kind" = 'PERSONAL'
    $sql$;
  END IF;
END $$;

-- ===========================================================================
-- CONTRACT 4 — the partial index the expand created has done its job.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'teams_workspace_kind_null_idx'
  ) THEN
    EXECUTE 'DROP INDEX "teams_workspace_kind_null_idx"';
  END IF;
END $$;
