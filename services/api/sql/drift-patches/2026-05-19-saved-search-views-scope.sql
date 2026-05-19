-- =============================================================================
-- Drift patch — saved_search_views.scope (Phase 25.5 reviewer-ops hardening)
-- =============================================================================
--
-- Symptom this patch fixes:
--   GET /v1/reviewer-ops/saved-views → P2022 (Prisma cannot find the column
--   `scope` in saved_search_views). The reviewer-ops saved-views endpoint
--   raises before reaching any business logic. UI shows the reviewer-ops
--   landing page crashing on saved-view load.
--
-- Root cause:
--   The Phase 25.5 migration `20260602100000_phase25_5_reviewer_ops_hardening`
--   adds the `scope` column to `saved_search_views`, but the Neon production
--   database did not apply it (migration state diverged from code). The
--   Prisma client compiled against the schema then issues queries that
--   project `scope`, and the database rejects them.
--
-- Hard rules for this patch:
--   - PARTIAL-STATE SAFE — every statement must be idempotent. The patch
--     may be applied on a healthy database, on a half-patched database, or
--     on a database where the column has been manually re-added. None of
--     those paths must error.
--   - NO BACKFILL — the column has a non-null default and existing rows
--     should receive the default at write time. We do not touch existing
--     rows.
--   - NO INDEX REBUILDS unless missing.
--   - Wrap in a single transaction so partial application is reverted.
--
-- Operator commands:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-saved-search-views-scope.sql
--
-- After running, hit:
--   GET /admin/runtime/schema-status
-- It should now report `saved_search_views.scope = present`.

BEGIN;

-- 1) The Phase 24 base table itself must exist. If it doesn't, this patch
--    is the wrong tool — the operator should run migrations from scratch.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'saved_search_views'
  ) THEN
    RAISE EXCEPTION 'saved_search_views table is missing — run Phase 24 migrations first, not this drift patch';
  END IF;
END$$;

-- 2) Add the `scope` column with the same default that the Phase 25.5
--    migration would have set. IF NOT EXISTS makes this idempotent.
ALTER TABLE "saved_search_views"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(24) NOT NULL DEFAULT 'SEARCH';

-- 3) Restore the supporting indexes if they were never created. CREATE
--    INDEX IF NOT EXISTS is idempotent.
CREATE INDEX IF NOT EXISTS saved_search_views_team_scope_idx
  ON "saved_search_views" ("team_id", "scope");

CREATE INDEX IF NOT EXISTS saved_search_views_team_scope_visibility_idx
  ON "saved_search_views" ("team_id", "scope", "visibility");

COMMIT;

-- =============================================================================
-- Done. Next steps:
--   1. Re-run the API process so the in-memory Prisma client picks up the
--      new column from the still-cached schema (Prisma is schema-aware at
--      build time, so the client is already expecting the column — the
--      restart is only needed if the API was failing readiness in a loop).
--   2. Confirm via /admin/runtime/schema-status that drift status is HEALTHY.
--   3. Hit GET /v1/reviewer-ops/saved-views and confirm 200.
-- =============================================================================
