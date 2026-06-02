-- Phase 15 — Semantic search foundation (additive only).
--
-- Three additive changes, all defended by per-column / per-extension
-- guards so a partial-state DB (the canonical Phase O risk model)
-- is a clean no-op:
--
--   1. CREATE EXTENSION IF NOT EXISTS vector — wrapped in a
--      DO $$ EXCEPTION WHEN insufficient_privilege block. On
--      hosted Postgres (Neon / Supabase / RDS) the extension is
--      typically pre-approved; on stricter clusters it requires
--      superuser. In the failure path the migration logs a NOTICE
--      and skips the remaining vector work — the semantic search
--      runtime falls back to keyword-only without erroring out.
--
--   2. ALTER TABLE evidence_semantic_chunks ADD COLUMN
--      embedding_vector vector(1536) — sibling column. The
--      existing `embedding` Bytes column is preserved for
--      backward compatibility with the in-process cosine ranker.
--
--   3. CREATE INDEX evidence_semantic_chunks_embedding_ivfflat_idx
--      ON evidence_semantic_chunks USING ivfflat
--      (embedding_vector vector_l2_ops) WITH (lists = 100) —
--      the ivfflat index that makes SQL-level nearest-neighbour
--      lookups O(log n) instead of O(n).
--
-- Hard rules satisfied:
--   * Phase O pattern: every CREATE / ALTER inside a DO $$ block
--     guarded by pg_extension + information_schema.columns so a
--     partial-state DB is a clean no-op.
--   * Terminating ; on every CREATE / ALTER / CREATE INDEX statement.
--   * Per-column existence guards on the ivfflat index.
--   * No DROP TABLE, no DROP COLUMN, no RENAME.
--   * The `embedding` Bytes column is NEVER removed — the migration
--     is purely additive.

BEGIN;

SELECT 'Phase 15 semantic search: additive pgvector column + ivfflat index; in-process cosine remains the fallback path.' AS phase_15_readiness;

-- ---------------------------------------------------------------------------
-- 1. pgvector extension — best-effort install.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE $sql$ CREATE EXTENSION IF NOT EXISTS vector $sql$;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pgvector extension requires superuser to install; semantic search will run keyword-only until the extension is enabled by an operator';
WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension install skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 2. evidence_semantic_chunks.embedding_vector — additive sibling column.
--    Gated on pg_extension so we only attempt the ALTER when vector
--    is actually installed.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_semantic_chunks')
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='evidence_semantic_chunks'
         AND column_name='embedding_vector'
    )
  THEN
    EXECUTE $sql$ ALTER TABLE "evidence_semantic_chunks" ADD COLUMN IF NOT EXISTS "embedding_vector" vector(1536) $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. ivfflat index on embedding_vector — gated on both the extension
--    AND the column existing. `lists = 100` is a reasonable starting
--    value for the < 100k-row scale Phase 15 targets; a future tuning
--    pass can rebuild with a higher lists value.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')
    AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_semantic_chunks')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='evidence_semantic_chunks'
         AND column_name='embedding_vector'
    )
  THEN
    EXECUTE $sql$ CREATE INDEX IF NOT EXISTS "evidence_semantic_chunks_embedding_ivfflat_idx" ON "evidence_semantic_chunks" USING ivfflat ("embedding_vector" vector_l2_ops) WITH (lists = 100) $sql$;
  END IF;
END $$;

COMMIT;
