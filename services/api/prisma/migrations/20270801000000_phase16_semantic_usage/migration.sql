-- Phase 16 — Semantic usage rollup (additive only).
--
-- Adds one new table `semantic_usage_daily` for the workspace-day
-- counters consulted by `canEmbedMore` (daily chunk cap) and the
-- `getSemanticUsageSummary` UI surface. Phase O additive pattern:
--
--   * single DO $$ block, defensive `IF NOT EXISTS`
--   * unique composite (workspace_id, date_utc) so upsert collapses
--     concurrent writers
--   * no DROP, no RENAME, no destructive ALTER
--   * terminating ; on every CREATE / ALTER statement
--   * timestamp later than 20270701000000_phase15_semantic_search
--
-- The unique index doubles as the read path for the daily cap query —
-- `SELECT chunks_embedded FROM semantic_usage_daily WHERE workspace_id = $1 AND date_utc = $2`
-- is an index-only lookup.

BEGIN;

SELECT 'Phase 16 semantic usage: additive workspace-day rollup table for embedding cost controls.' AS phase_16_readiness;

-- ---------------------------------------------------------------------------
-- 1. semantic_usage_daily — workspace-day counter rollup.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname='public' AND tablename='semantic_usage_daily'
  )
  THEN
    EXECUTE $sql$
      CREATE TABLE "semantic_usage_daily" (
        "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id"     UUID NOT NULL,
        "date_utc"         DATE NOT NULL,
        "chunks_embedded"  INTEGER NOT NULL DEFAULT 0,
        "tokens_consumed"  BIGINT  NOT NULL DEFAULT 0,
        "eur_spent_micros" BIGINT  NOT NULL DEFAULT 0,
        "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        CONSTRAINT "semantic_usage_daily_pkey" PRIMARY KEY ("id")
      )
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Unique composite (workspace_id, date_utc). Per-row guard.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM pg_tables
       WHERE schemaname='public' AND tablename='semantic_usage_daily'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='semantic_usage_daily'
         AND column_name='workspace_id'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='semantic_usage_daily'
         AND column_name='date_utc'
    )
  THEN
    EXECUTE $sql$
      CREATE UNIQUE INDEX IF NOT EXISTS "semantic_usage_daily_workspace_id_date_utc_key"
        ON "semantic_usage_daily" ("workspace_id", "date_utc")
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Workspace-only index for cheap monthly aggregates.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM pg_tables
       WHERE schemaname='public' AND tablename='semantic_usage_daily'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='semantic_usage_daily'
         AND column_name='workspace_id'
    )
  THEN
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS "semantic_usage_daily_workspace_id_idx"
        ON "semantic_usage_daily" ("workspace_id")
    $sql$;
  END IF;
END $$;

COMMIT;
