-- PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002) — BACKFILL.
--
-- WHAT MAY BE USED AS AUTHORITY, AND WHAT MAY NOT
-- ---------------------------------------------------------------------------
-- Three structural facts, in this order. Each is a statement about how the row
-- came to exist, not about what anyone is paying:
--
--   1. THE PERSONAL SPACE OWNERSHIP INVARIANT — `is_personal = TRUE`. A
--      Personal Space is bootstrapped for an identity and is one per identity;
--      nothing else sets this flag.
--   2. THE ORGANIZATION PROVISIONING RELATION — the parent Organization's
--      `kind = 'CUSTOMER'`. A CUSTOMER Organization is created only by
--      enterprise provisioning, and every workspace under one is an
--      ORGANIZATION workspace by construction.
--   3. EXPLICIT ACCOUNT OWNERSHIP — a non-personal workspace under a SYSTEM
--      Organization. SYSTEM Organizations are the internal containers the
--      platform creates to satisfy the NOT NULL `organization_id`; a workspace
--      inside one belongs to the account that owns it. That is OWNED.
--
-- EXPLICITLY NOT USED, and this is the point of the whole change:
--   * `billing_plan` / `billing_status` — a plan is a commercial fact. The
--     fallback being removed read `ENTERPRISE` as ORGANIZATION, which is how
--     an Owned workspace silently changed tenancy on an upgrade.
--   * subscription state, role names, display names, UI routes.
--
-- AMBIGUITY REFUSES. A row that matches none of the three is left NULL, and
-- the contract migration will REFUSE to proceed and name it. Guessing is what
-- produced the finding.
--
-- Re-runnable: every statement is conditioned on `workspace_kind IS NULL`, so
-- a second run changes zero rows and an explicitly-set kind is never
-- overwritten.

-- ---------------------------------------------------------------------------
-- 1. PERSONAL — the ownership invariant.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'workspace_kind'
  ) THEN
    EXECUTE $sql$
      UPDATE "teams"
         SET "workspace_kind" = 'PERSONAL'
       WHERE "workspace_kind" IS NULL
         AND "is_personal" = TRUE
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. ORGANIZATION — the provisioning relation.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'workspace_kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'kind'
  ) THEN
    EXECUTE $sql$
      UPDATE "teams" t
         SET "workspace_kind" = 'ORGANIZATION'
        FROM "organizations" o
       WHERE o."id" = t."organization_id"
         AND t."workspace_kind" IS NULL
         AND t."is_personal" = FALSE
         AND o."kind" = 'CUSTOMER'
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. OWNED — explicit account ownership inside an internal container.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'workspace_kind'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'kind'
  ) THEN
    EXECUTE $sql$
      UPDATE "teams" t
         SET "workspace_kind" = 'OWNED'
        FROM "organizations" o
       WHERE o."id" = t."organization_id"
         AND t."workspace_kind" IS NULL
         AND t."is_personal" = FALSE
         AND o."kind" = 'SYSTEM'
    $sql$;
  END IF;
END $$;
