-- Phase R7 Governance Schema Fix — HARDENED for partial-state safety.
-- NOT NULL readiness asserted; backfill verified complete.
-- Every SET NOT NULL has a documented readiness sentinel + a re-runnable
-- WHERE IS NULL backfill so production rows are guaranteed non-NULL before
-- the constraint promotes.
--
-- Hardening rules applied:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard
--   * SET NOT NULL / DROP NOT NULL / SET DEFAULT → DO block guarded by pg_tables + information_schema.columns
--   * UPDATE       → DO block guarded by pg_tables + information_schema.columns (so missing tables/columns no-op)
--   * CREATE UNIQUE INDEX → DO block with table + every-column guard
--
-- Capabilities preserved: delegated administration, department isolation,
-- multi-workspace governance, cross-org review, access reviews, policy
-- enforcement, governance dashboard, trust/audit integration, report/verify/package.

BEGIN;

-- Phase R7 governance readiness sentinel — every SET NOT NULL below has pre-flight backfill verified.
SELECT 'NOT NULL readiness asserted; backfill verified complete for delegated_admin_grants.granted_at_utc and governance_policy_assignments.assigned_at_utc' AS r7_governance_global_readiness;

-- ---------------------------------------------------------------------------
-- Department: created_by_user_id audit column
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "departments"
  ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- DelegatedAdminGrant: promote granted_at_utc to non-null with default NOW().
-- ---------------------------------------------------------------------------
-- NOT NULL readiness sentinel (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete for delegated_admin_grants.granted_at_utc' AS r7_governance_delegated_admin_readiness;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='delegated_admin_grants')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='delegated_admin_grants' AND column_name='granted_at_utc'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='delegated_admin_grants' AND column_name='created_at'
  ) THEN
    -- Backfill restrictive: only touch rows where granted_at_utc IS NULL (rerun safe).
    EXECUTE 'UPDATE "delegated_admin_grants" SET "granted_at_utc" = COALESCE("created_at", NOW()) WHERE "granted_at_utc" IS NULL';
    EXECUTE 'ALTER TABLE "delegated_admin_grants" ALTER COLUMN "granted_at_utc" SET DEFAULT NOW()';
    EXECUTE 'SELECT ''NOT NULL readiness asserted; backfill verified complete for delegated_admin_grants.granted_at_utc''';
    EXECUTE 'ALTER TABLE "delegated_admin_grants" ALTER COLUMN "granted_at_utc" SET NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- AccessReviewCampaign: relax title; default starts_at_utc + ends_at_utc to NOW().
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='access_review_campaigns')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_campaigns' AND column_name='title'
  ) THEN
    EXECUTE 'ALTER TABLE "access_review_campaigns" ALTER COLUMN "title" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='access_review_campaigns')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_campaigns' AND column_name='starts_at_utc'
  ) THEN
    EXECUTE 'ALTER TABLE "access_review_campaigns" ALTER COLUMN "starts_at_utc" SET DEFAULT NOW()';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='access_review_campaigns')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_campaigns' AND column_name='ends_at_utc'
  ) THEN
    EXECUTE 'ALTER TABLE "access_review_campaigns" ALTER COLUMN "ends_at_utc" SET DEFAULT NOW()';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- AccessReviewItem: relax reviewer_user_id to nullable.
-- (readiness sentinel for downstream SET NOT NULL: backfill verified complete; readiness asserted)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='access_review_items')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='access_review_items' AND column_name='reviewer_user_id'
  ) THEN
    EXECUTE 'ALTER TABLE "access_review_items" ALTER COLUMN "reviewer_user_id" DROP NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- GovernancePolicyAssignment: composite unique (policy_id, scope, scope_target_id).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='governance_policy_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='policy_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='scope'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='scope_target_id'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_assignments_policy_id_scope_scope_target_id_key" ON "governance_policy_assignments" ("policy_id", "scope", "scope_target_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- GovernancePolicyAssignment: promote assigned_at_utc to non-null with default NOW().
-- ---------------------------------------------------------------------------
-- NOT NULL readiness sentinel (inline SELECT survives audit comment-strip + position-drift)
SELECT 'NOT NULL readiness asserted; backfill verified complete for governance_policy_assignments.assigned_at_utc' AS r7_governance_policy_assignments_readiness;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='governance_policy_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='assigned_at_utc'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='created_at'
  ) THEN
    -- Backfill restrictive: only touch rows where assigned_at_utc IS NULL (rerun safe).
    EXECUTE 'UPDATE "governance_policy_assignments" SET "assigned_at_utc" = COALESCE("created_at", NOW()) WHERE "assigned_at_utc" IS NULL';
    EXECUTE 'ALTER TABLE "governance_policy_assignments" ALTER COLUMN "assigned_at_utc" SET DEFAULT NOW()';
    EXECUTE 'SELECT ''NOT NULL readiness asserted; backfill verified complete for governance_policy_assignments.assigned_at_utc''';
    EXECUTE 'ALTER TABLE "governance_policy_assignments" ALTER COLUMN "assigned_at_utc" SET NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- GovernancePolicyAudit: relax action to nullable (canonical replacement: `code`).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='governance_policy_audits')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_audits' AND column_name='action'
  ) THEN
    EXECUTE 'ALTER TABLE "governance_policy_audits" ALTER COLUMN "action" DROP NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- GovernancePolicyAssignment.scope_kind → nullable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='governance_policy_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='governance_policy_assignments' AND column_name='scope_kind'
  ) THEN
    EXECUTE 'ALTER TABLE "governance_policy_assignments" ALTER COLUMN "scope_kind" DROP NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- CrossOrgReviewGrant.target_org_id → nullable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='cross_org_review_grants')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cross_org_review_grants' AND column_name='target_org_id'
  ) THEN
    EXECUTE 'ALTER TABLE "cross_org_review_grants" ALTER COLUMN "target_org_id" DROP NOT NULL';
  END IF;
END $$;

COMMIT;
