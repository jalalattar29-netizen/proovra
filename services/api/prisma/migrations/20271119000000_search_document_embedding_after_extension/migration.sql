-- =============================================================================
-- PHASE 12 POINT 8 — create `evidence_search_documents.embedding` and its ANN
-- index AFTER the pgvector extension exists.
--
-- RELEASE A. Additive, idempotent, non-destructive.
--
-- THE DEFECT THIS REPAIRS
-- ---------------------------------------------------------------------------
--   `20260620100000_phase24_31_consolidated_drift_patches` creates both the
--   `embedding vector(384)` column and its IVFFLAT index inside
--
--       IF has_pgvector THEN … ELSE RAISE NOTICE 'skipped' END IF;
--
--   and `CREATE EXTENSION vector` is issued by
--   `20270701000000_phase15_semantic_search` — a year later in lexical order.
--   Migrations apply in order, so on ANY database built from this chain the
--   guard is false when it is evaluated, the block is skipped, and neither the
--   column nor the index is ever created. Re-running is impossible: the
--   migration is already recorded as applied.
--
--   The datamodel meanwhile DECLARES the column
--   (`EvidenceSearchDocument.embedding Unsupported("vector(384)")?`) and
--   `raw-schema-ownership.json` registers the index as an
--   `EXTENSION_CONDITIONAL_INDEX` expected to exist whenever the extension is
--   installed. Both are true of the production database, where the extension
--   was installed out of band before that migration ran; neither is true of a
--   database rebuilt from the artifact.
--
--   That is why nothing caught it. Every check ran against a database that had
--   drifted into correctness. It was found by applying the release artifact to
--   an empty PostgreSQL 16 + pgvector and running `db:raw-schema-verify`, which
--   reported the index "gone or mutated".
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT
-- ---------------------------------------------------------------------------
--   `20260620100000` is applied in production. Its bytes are frozen: changing
--   them changes its Prisma checksum and breaks `migrate deploy` on every
--   database that carries it.
--
-- SAFETY
-- ---------------------------------------------------------------------------
--   Every statement is conditional and idempotent, so this is a no-op on a
--   database that already has the objects — which is the expected state in
--   production. It still refuses to guess: if pgvector is somehow absent, it
--   RAISES rather than silently skipping the way the original did, because a
--   silent skip is precisely what hid the problem for a year.
-- =============================================================================

DO $$
DECLARE
  has_pgvector boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_pgvector;

  IF NOT has_pgvector THEN
    -- Point 5 made pgvector a production prerequisite: the embedding chain
    -- cannot run without it. Failing loudly here is the whole point — the
    -- original's `RAISE NOTICE … skipped` is why this went unnoticed.
    RAISE EXCEPTION
      'pgvector is not installed, but 20270701000000_phase15_semantic_search should have created it. Refusing to leave evidence_search_documents.embedding undeclared while the datamodel declares it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evidence_search_documents'
  ) THEN
    RAISE EXCEPTION 'evidence_search_documents does not exist; the search platform migrations did not run.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evidence_search_documents'
      AND column_name = 'embedding'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_search_documents" ADD COLUMN "embedding" vector(384)';
    RAISE NOTICE 'point8: created evidence_search_documents.embedding.';
  ELSE
    RAISE NOTICE 'point8: evidence_search_documents.embedding already present — no change.';
  END IF;

  -- The index name matches the one 20260620100000 would have created, so a
  -- database that DID get it (production) is left exactly as it is.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'evidence_search_documents'
      AND indexname = 'evidence_search_documents_embedding_ivfflat'
  ) THEN
    EXECUTE 'CREATE INDEX "evidence_search_documents_embedding_ivfflat"
             ON "evidence_search_documents"
             USING ivfflat ("embedding" vector_cosine_ops)
             WITH (lists = 100)';
    RAISE NOTICE 'point8: created evidence_search_documents_embedding_ivfflat.';
  ELSE
    RAISE NOTICE 'point8: evidence_search_documents_embedding_ivfflat already present — no change.';
  END IF;
END
$$;
