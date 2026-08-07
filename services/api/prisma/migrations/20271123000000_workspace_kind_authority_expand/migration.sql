-- PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002) — EXPAND.
--
-- THE FINDING
-- ---------------------------------------------------------------------------
-- `teams.workspace_kind` is the canonical tenancy fact, and it is NULLABLE.
-- Every production writer already supplies it explicitly — the four creation
-- paths (self-service OWNED, two enterprise ORGANIZATION paths, and the
-- PERSONAL bootstrap) all name a kind — but the column's nullability means the
-- reader cannot rely on it, and so `normalizeWorkspaceKind` carries a
-- FALLBACK: `isPersonal=false` plus `billingPlan === 'ENTERPRISE'` is read as
-- ORGANIZATION.
--
-- That fallback infers a TENANCY fact from a COMMERCIAL one. An Owned
-- workspace whose account is upgraded to ENTERPRISE silently becomes an
-- ORGANIZATION workspace to the authorization chain — which then applies
-- customer-Organization lifecycle to a workspace that has no customer
-- Organization, and a Personal/Owned workspace whose plan is downgraded
-- silently stops having it applied. Neither is a decision anyone made.
--
-- The fix is to make the column mandatory and delete the fallback. That
-- requires knowing every existing row's kind, which requires a backfill, which
-- requires a readiness gate — hence three files rather than one.
--
-- THIS FILE ADDS NOTHING BUT AN INDEX AND A COMMENT. It is genuinely
-- expand-only: no constraint, no NOT NULL, no data change.

-- ---------------------------------------------------------------------------
-- A partial index over the rows a backfill has to find. Cheap, and it keeps
-- the readiness query in the contract migration from scanning the table on a
-- large deployment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'workspace_kind'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "teams_workspace_kind_null_idx" ON "teams" ("id") WHERE "workspace_kind" IS NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Record the authority IN THE DATABASE, where a future reader of the schema
-- will find it, rather than only in a migration nobody re-reads.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'workspace_kind'
  ) THEN
    EXECUTE $sql$
      COMMENT ON COLUMN "teams"."workspace_kind" IS
        'CANONICAL TENANCY KIND. PERSONAL | OWNED | ORGANIZATION. Derived ONLY from structural authority: the Personal Space ownership invariant, explicit account ownership, or the Organization provisioning relation (organizations.kind = CUSTOMER). NEVER from a commercial plan, a subscription, a role name, a display name or a UI route. TEAM is a PLAN and is never a kind.'
    $sql$;
  END IF;
END $$;
