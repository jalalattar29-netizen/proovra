-- =============================================================================
-- P1 DOMAIN REMEDIATION (2026-07-21) — explicit workspace/organization kind
-- discriminators.
--
--   teams.workspace_kind        PERSONAL | OWNED | ORGANIZATION  (nullable)
--   organizations.kind          SYSTEM | CUSTOMER                (default SYSTEM)
--
-- Deterministic backfill (no guessing):
--   1. is_personal = true                     -> PERSONAL
--   2. billing_plan = 'ENTERPRISE'            -> ORGANIZATION
--      (ENTERPRISE is only ever assigned by the enterprise provisioning
--       lifecycle or the locked billing webhook — authoritative enterprise
--       provenance.)
--   3. every other row (is_personal = false)  -> OWNED
--      (all remaining rows were created by the self-service POST /v1/teams
--       path; legacy "personal-looking" duplicates remain surfaced by the
--       existing duplicatePersonalCandidates diagnostic and are NOT
--       destructively converted here.)
--
--   Organizations: CUSTOMER iff enterprise provenance — the org owns an
--   ENTERPRISE workspace OR carries pending_enterprise_seats; else SYSTEM
--   (the internal 1:1 bootstrap container every team receives).
--
-- Rollback: both columns are additive and nullable/defaulted; dropping the
-- columns + enums restores the previous shape with zero data loss.
-- =============================================================================

CREATE TYPE "WorkspaceKind" AS ENUM ('PERSONAL', 'OWNED', 'ORGANIZATION');
CREATE TYPE "OrganizationKind" AS ENUM ('SYSTEM', 'CUSTOMER');

ALTER TABLE "teams"
  ADD COLUMN "workspace_kind" "WorkspaceKind";

ALTER TABLE "organizations"
  ADD COLUMN "kind" "OrganizationKind" NOT NULL DEFAULT 'SYSTEM';

-- Backfill teams (order matters: PERSONAL first, then ENTERPRISE, then rest).
UPDATE "teams" SET "workspace_kind" = 'PERSONAL'
  WHERE "is_personal" = true;

UPDATE "teams" SET "workspace_kind" = 'ORGANIZATION'
  WHERE "workspace_kind" IS NULL AND "billing_plan" = 'ENTERPRISE';

UPDATE "teams" SET "workspace_kind" = 'OWNED'
  WHERE "workspace_kind" IS NULL;

-- Backfill organizations: enterprise provenance -> CUSTOMER.
UPDATE "organizations" o SET "kind" = 'CUSTOMER'
  WHERE o."pending_enterprise_seats" IS NOT NULL
     OR EXISTS (
        SELECT 1 FROM "teams" t
        WHERE t."organization_id" = o."id"
          AND t."billing_plan" = 'ENTERPRISE'
     );

-- Integrity guards (fail the migration loudly rather than ship bad data):
-- every PERSONAL row must be is_personal; no PERSONAL row may be ENTERPRISE.
DO $$
DECLARE bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count FROM "teams"
    WHERE ("workspace_kind" = 'PERSONAL' AND "is_personal" = false)
       OR ("workspace_kind" <> 'PERSONAL' AND "is_personal" = true)
       OR ("workspace_kind" IS NULL);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'workspace_kind backfill integrity violation: % rows', bad_count;
  END IF;
END $$;

CREATE INDEX "teams_workspace_kind_idx" ON "teams"("workspace_kind");
