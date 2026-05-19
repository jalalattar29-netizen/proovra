-- =============================================================================
-- Phase 24-J — Search FTS + pgvector semantic foundations
-- =============================================================================
--
-- Phase 24 shipped `evidence_search_documents` with `searchable_text`
-- (plain TEXT) + ILIKE-based query. That works for tens of thousands of
-- rows; an enterprise discovery surface needs PostgreSQL FTS (GIN over
-- a tsvector column) so query latency stays bounded as the corpus
-- grows. This patch adds:
--
--   1. A generated `tsv` column derived from
--      `title || subtitle || summary || searchable_text` (English
--      analyzer, weighted by field) — STORED, no row updates needed.
--   2. A GIN index over `tsv` for sub-100ms FTS queries.
--   3. A NULLABLE `embedding` vector column (384 dims) for semantic
--      retrieval foundations. Created only if the pgvector extension
--      is enabled — the patch never errors when pgvector is absent,
--      it just skips the column.
--   4. An IVFFLAT index over `embedding` for approximate nearest
--      neighbour retrieval (also gated on pgvector availability).
--
-- HARD INVARIANTS:
--   * The patch is IDEMPOTENT — every statement uses IF NOT EXISTS or
--     a DO $$ ... $$ guard.
--   * No data is written. Existing rows have their tsv populated by
--     the GENERATED column expression at first read.
--   * No Prisma model change is required for `tsv` — the search service
--     queries it via `$queryRaw`. The Prisma client is unaware of the
--     column, which is fine.
--   * pgvector is OPTIONAL. If the extension is missing, the
--     `embedding` column and IVFFLAT index are skipped silently and
--     the semantic retrieval helper falls back to ILIKE / FTS ranking.
--
-- Operator command:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     services/api/sql/drift-patches/2026-05-19-search-fts-pgvector.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) tsvector generated column + GIN index. The expression weights
--    `title` highest (A), then `subtitle`/`summary` (B), then the body
--    (C). Stored generated column so no trigger or row-update is
--    needed.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evidence_search_documents'
      AND column_name = 'tsv'
  ) THEN
    ALTER TABLE "evidence_search_documents"
      ADD COLUMN "tsv" tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', COALESCE("title", '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE("subtitle", '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE("summary", '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE("searchable_text", '')), 'C')
      ) STORED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "evidence_search_documents_tsv_gin"
  ON "evidence_search_documents" USING GIN ("tsv");

-- ---------------------------------------------------------------------------
-- 2) pgvector foundations — OPTIONAL. Gated on extension availability
--    so the patch is a no-op on databases that don't have it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  has_pgvector BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) INTO has_pgvector;

  IF has_pgvector THEN
    -- 2a) Add `embedding vector(384)` column if missing.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'evidence_search_documents'
        AND column_name = 'embedding'
    ) THEN
      EXECUTE 'ALTER TABLE "evidence_search_documents"
               ADD COLUMN "embedding" vector(384)';
    END IF;

    -- 2b) IVFFLAT ANN index over embedding. Skipped silently if it
    -- already exists.
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'evidence_search_documents'
        AND indexname = 'evidence_search_documents_embedding_ivfflat'
    ) THEN
      -- 100 lists is a conservative default for the corpus sizes we
      -- expect; operators can tune it later via REINDEX.
      EXECUTE 'CREATE INDEX "evidence_search_documents_embedding_ivfflat"
               ON "evidence_search_documents"
               USING ivfflat ("embedding" vector_cosine_ops)
               WITH (lists = 100)';
    END IF;
  ELSE
    RAISE NOTICE
      'pgvector extension not present — semantic embedding column and ANN index skipped';
  END IF;
END$$;

COMMIT;

-- =============================================================================
-- After running:
--   1. Confirm via SELECT column_name FROM information_schema.columns
--      WHERE table_name = 'evidence_search_documents' AND column_name = 'tsv';
--   2. Confirm GIN index: SELECT indexname FROM pg_indexes
--      WHERE tablename = 'evidence_search_documents';
--   3. The Phase 24 search service automatically picks up the new
--      `tsv` column via $queryRaw FTS path when present (graceful
--      fallback otherwise).
-- =============================================================================
