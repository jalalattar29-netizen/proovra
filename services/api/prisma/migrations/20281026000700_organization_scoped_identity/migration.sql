-- SSO AND SCIM BELONG TO THE ORGANIZATION (members audit DOM-13, owner
-- decision 2026-10-25).
--
-- Identity-provider configuration, SCIM credentials, SCIM groups and the
-- external identities they create are owned by the ORGANIZATION. Membership,
-- role, Collaboration Team placement and Case access stay Workspace-scoped. A
-- SCIM group projects into one or more Workspaces of its Organization through
-- the provisioning authority.
--
-- Until now every one of these rows was keyed by a Workspace (team_id) alone:
-- two workspaces of one Organization could each run their own IdP for the
-- same provider, an external subject was unique across ALL tenants (a second
-- Organization pushing the same SCIM externalId collided), and a SCIM group
-- reached exactly one Workspace by role equality.
--
-- This migration, forward-only, deletes nothing:
--
--   1. organization_id on sso_connections, scim_provisioning_tokens,
--      scim_groups, external_identity_mappings and sso_callback_attempts,
--      backfilled from teams.organization_id (NOT NULL on teams, so the
--      backfill is total), then NOT NULL, a RESTRICT foreign key and indexes.
--      A BEFORE INSERT trigger fills it from team_id for any writer that does
--      not (an older image during a rolling deploy). team_id stays: it is the
--      Workspace the row was configured from — for a SCIM token and an SSO
--      connection, the Organization's default provisioning Workspace.
--   2. ONE live connection per (organization, provider). Where an
--      Organization had several ACTIVE / SUSPENDED connections for one
--      provider (one per workspace), the earliest is kept and the others are
--      DISABLED with revoked_reason DUPLICATE_PROVIDER_IN_ORGANIZATION —
--      kept as history, re-activatable only after the survivor is retired.
--      The partial unique index replaces the per-workspace ACTIVE key, which
--      is then retired (guarded DO block).
--   3. ONE live SCIM group per (organization, external id). Same-externalId
--      groups of sibling workspaces are merged: the earliest stays canonical,
--      the others are ARCHIVED, and every one of them becomes a PROJECTION of
--      the canonical group into its own workspace with its own mapped role —
--      no workspace loses the membership its group gave.
--   4. scim_group_workspace_projections (group → workspace, mapped role,
--      status), seeded from every existing group.
--   5. External identities are unique per ORGANIZATION
--      (organization_id, provider, external_subject_id), replacing the global
--      (provider, external_subject_id) key: tenants no longer collide, and a
--      subject linked in one Organization means nothing in another.
--
-- Idempotent: every step is guarded or conditioned on rows still in their
-- prior state.

-- 1. organization_id --------------------------------------------------------

ALTER TABLE "sso_connections"            ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "scim_provisioning_tokens"   ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "scim_groups"                ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "external_identity_mappings" ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "sso_callback_attempts"      ADD COLUMN IF NOT EXISTS "organization_id" UUID;

UPDATE "sso_connections" x SET "organization_id" = t."organization_id"
  FROM "teams" t WHERE t."id" = x."team_id" AND x."organization_id" IS NULL;
UPDATE "scim_provisioning_tokens" x SET "organization_id" = t."organization_id"
  FROM "teams" t WHERE t."id" = x."team_id" AND x."organization_id" IS NULL;
UPDATE "scim_groups" x SET "organization_id" = t."organization_id"
  FROM "teams" t WHERE t."id" = x."team_id" AND x."organization_id" IS NULL;
UPDATE "external_identity_mappings" x SET "organization_id" = t."organization_id"
  FROM "teams" t WHERE t."id" = x."team_id" AND x."organization_id" IS NULL;
UPDATE "sso_callback_attempts" x SET "organization_id" = t."organization_id"
  FROM "teams" t WHERE t."id" = x."team_id" AND x."organization_id" IS NULL;

CREATE OR REPLACE FUNCTION "proovra_fill_organization_from_team"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organization_id" IS NULL THEN
    SELECT t."organization_id" INTO NEW."organization_id" FROM "teams" t WHERE t."id" = NEW."team_id";
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  tbl TEXT;
  missing INTEGER;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['sso_connections', 'scim_provisioning_tokens', 'scim_groups',
                             'external_identity_mappings', 'sso_callback_attempts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_fill_organization', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION "proovra_fill_organization_from_team"()',
      tbl || '_fill_organization', tbl);
    -- NOT NULL readiness: the backfill above is verified complete for this
    -- table before the constraint is set (zero NULL rows, RAISE otherwise).
    EXECUTE format('SELECT count(*) FROM %I WHERE "organization_id" IS NULL', tbl) INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION '%.organization_id could not be backfilled for every row', tbl;
    END IF;
    -- NOT NULL readiness verified just above (zero NULL rows).
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "organization_id" SET NOT NULL', tbl);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = tbl || '_organization_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
        tbl, tbl || '_organization_id_fkey');
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "sso_connections_organization_status_idx" ON "sso_connections" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "scim_provisioning_tokens_organization_status_idx" ON "scim_provisioning_tokens" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "scim_groups_organization_status_idx" ON "scim_groups" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "external_identity_mappings_organization_user_idx" ON "external_identity_mappings" ("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "sso_callback_attempts_organization_status_idx" ON "sso_callback_attempts" ("organization_id", "status");

-- 2. one live connection per (organization, provider) ------------------------

WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "organization_id", "provider"
                            ORDER BY "created_at" ASC, "id" ASC) AS rn
    FROM "sso_connections"
   WHERE "status" IN ('ACTIVE', 'SUSPENDED')
)
UPDATE "sso_connections" c
   SET "status" = 'DISABLED',
       "revoked_reason" = 'DUPLICATE_PROVIDER_IN_ORGANIZATION',
       "updated_at" = NOW()
  FROM ranked r
 WHERE r."id" = c."id" AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "sso_connections_org_provider_live_uk"
  ON "sso_connections" ("organization_id", "provider")
  WHERE "status" IN ('ACTIVE', 'SUSPENDED');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sso_connections_org_provider_live_uk') THEN
    RAISE EXCEPTION 'the organization-level live-provider key must exist before the workspace-level key is retired';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sso_connections_team_provider_active_uk') THEN
    EXECUTE 'DROP INDEX "sso_connections_team_provider_active_uk"';
  END IF;
END $$;

-- 4. projection table (created before 3 so the merge can write into it) ------

-- A brand-new table: created once; the existence guard only makes a
-- re-application of this file a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scim_group_workspace_projections') THEN
    CREATE TABLE "scim_group_workspace_projections" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "scim_group_id"      UUID         NOT NULL,
  "organization_id"    UUID         NOT NULL,
  "workspace_id"       UUID         NOT NULL,
  "mapped_role"        VARCHAR(24)  NOT NULL,
  "status"             VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "scim_group_workspace_projections_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_group_workspace_projections_group_fkey') THEN
    ALTER TABLE "scim_group_workspace_projections"
      ADD CONSTRAINT "scim_group_workspace_projections_group_fkey"
      FOREIGN KEY ("scim_group_id") REFERENCES "scim_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_group_workspace_projections_workspace_fkey') THEN
    ALTER TABLE "scim_group_workspace_projections"
      ADD CONSTRAINT "scim_group_workspace_projections_workspace_fkey"
      FOREIGN KEY ("workspace_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_group_workspace_projections_organization_fkey') THEN
    ALTER TABLE "scim_group_workspace_projections"
      ADD CONSTRAINT "scim_group_workspace_projections_organization_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_group_workspace_projections_role_vocab') THEN
    ALTER TABLE "scim_group_workspace_projections"
      ADD CONSTRAINT "scim_group_workspace_projections_role_vocab"
      CHECK ("mapped_role" IN ('ADMIN', 'MEMBER', 'VIEWER'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_group_workspace_projections_status_vocab') THEN
    ALTER TABLE "scim_group_workspace_projections"
      ADD CONSTRAINT "scim_group_workspace_projections_status_vocab"
      CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "scim_group_workspace_projections_live_uk"
  ON "scim_group_workspace_projections" ("scim_group_id", "workspace_id")
  WHERE "status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "scim_group_workspace_projections_workspace_idx"
  ON "scim_group_workspace_projections" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "scim_group_workspace_projections_organization_idx"
  ON "scim_group_workspace_projections" ("organization_id", "status");

-- 3. one live SCIM group per (organization, external id); every group's
--    workspace reach is carried as a projection of its canonical group. ------

WITH canon AS (
  SELECT g."id",
         g."team_id",
         g."organization_id",
         g."mapped_role",
         g."status",
         g."created_by_user_id",
         CASE WHEN g."external_id" IS NULL THEN g."id"
              ELSE FIRST_VALUE(g."id") OVER (
                     PARTITION BY g."organization_id", g."external_id"
                     ORDER BY (g."status" = 'ACTIVE') DESC, g."created_at" ASC, g."id" ASC)
         END AS "canonical_id"
    FROM "scim_groups" g
)
INSERT INTO "scim_group_workspace_projections"
  ("scim_group_id", "organization_id", "workspace_id", "mapped_role", "status", "created_by_user_id")
SELECT c."canonical_id", c."organization_id", c."team_id",
       CASE WHEN c."mapped_role" IN ('ADMIN', 'MEMBER', 'VIEWER') THEN c."mapped_role" ELSE 'MEMBER' END,
       c."status", c."created_by_user_id"
  FROM canon c
 WHERE c."status" IN ('ACTIVE', 'ARCHIVED')
   AND NOT EXISTS (
     SELECT 1 FROM "scim_group_workspace_projections" p
      WHERE p."scim_group_id" = c."canonical_id" AND p."workspace_id" = c."team_id"
   )
ON CONFLICT DO NOTHING;

WITH dup AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "organization_id", "external_id"
                            ORDER BY ("status" = 'ACTIVE') DESC, "created_at" ASC, "id" ASC) AS rn
    FROM "scim_groups"
   WHERE "external_id" IS NOT NULL AND "status" = 'ACTIVE'
)
UPDATE "scim_groups" g
   SET "status" = 'ARCHIVED', "updated_at" = NOW()
  FROM dup d
 WHERE d."id" = g."id" AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_org_external_id_live_uk"
  ON "scim_groups" ("organization_id", "external_id")
  WHERE "status" = 'ACTIVE' AND "external_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'scim_groups_org_external_id_live_uk') THEN
    RAISE EXCEPTION 'the organization-level SCIM group key must exist before the workspace-level key is retired';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'scim_groups_team_external_id_uk') THEN
    EXECUTE 'DROP INDEX "scim_groups_team_external_id_uk"';
  END IF;
END $$;

-- 5. external identities unique per organization ----------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "external_identity_mappings_org_provider_subject_uk"
  ON "external_identity_mappings" ("organization_id", "provider", "external_subject_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'external_identity_mappings_org_provider_subject_uk') THEN
    RAISE EXCEPTION 'the organization-level external identity key must exist before the global key is retired';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'external_identity_mappings_provider_subject_uk') THEN
    EXECUTE 'DROP INDEX "external_identity_mappings_provider_subject_uk"';
  END IF;
END $$;
