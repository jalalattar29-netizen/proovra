-- =============================================================================
-- Phase 2.7X Stage 6 — Tighten teams.organization_id to NOT NULL.
--
-- Preconditions (verified):
--   1. Stage 2 backfill created 1:1 Organization per Team. Stage 5
--      readiness probe confirms 0 nulls in teams.organization_id at
--      apply time.
--   2. Both team-create code paths (POST /v1/teams and the
--      personal-workspace bootstrap service) are updated to
--      atomically create the Organization + ORG_OWNER membership +
--      Team in the same transaction. No code path can produce a
--      team with NULL organization_id after this migration lands.
--
-- Risk-scan classification: WARNING (ALTER COLUMN SET NOT NULL).
-- This is the documented Stage 6 hardening exception.
--
-- The FK behavior on `teams.organization_id` was previously
-- `ON DELETE SET NULL`. Stage 6 changes this to `ON DELETE RESTRICT`
-- because SET NULL is incompatible with NOT NULL. RESTRICT prevents
-- operator-driven org deletion while the org still has bound teams
-- — operators must explicitly relocate teams first. This is the
-- correct production semantic.
-- =============================================================================

-- Drop the existing FK (which had SET NULL semantics).
ALTER TABLE "teams" DROP CONSTRAINT IF EXISTS "teams_organization_id_fkey";

-- Tighten the column.
ALTER TABLE "teams" ALTER COLUMN "organization_id" SET NOT NULL;

-- Recreate the FK with RESTRICT semantics.
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
