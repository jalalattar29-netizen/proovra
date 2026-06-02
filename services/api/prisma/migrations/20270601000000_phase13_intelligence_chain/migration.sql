-- Phase 13 — Intelligence chain wiring (additive only).
--
-- Single Phase 13 migration permitted by the synthesis. Three
-- additive changes:
--
--   1. evidence_similarities.graph_edge_id  — nullable FK that
--      back-references an investigation_graph_edges row whenever
--      the similarity has been promoted to a SIMILAR_TO edge by
--      the media-intelligence reconcile worker. One-way promotion;
--      nothing in the graph writes back here.
--
--   2. CHECK constraint on investigation_graph_nodes.node_kind —
--      additive ENTITY entry. The pre-existing constraint is
--      DROPped + re-CREATEd with the full bounded set (existing
--      values + ENTITY). This is the only way to widen a Postgres
--      CHECK constraint and is the additive pattern used by the
--      Phase 31 closure migrations.
--
--   3. CHECK constraint on investigation_graph_edges.edge_type —
--      additive EXTRACTED_FROM entry. Same drop-and-recreate
--      pattern as above.
--
-- Hard rules satisfied:
--   * Phase O pattern: every CREATE / ALTER inside a DO $$ block
--     guarded by pg_tables + information_schema.columns so a
--     partial-state DB is a clean no-op.
--   * Terminating ; on every CREATE TABLE / ALTER TABLE / CREATE
--     INDEX (INDEX_COLUMN_RISK gate).
--   * Per-column existence guards on indexes that reference the
--     new column.
--   * No DROP TABLE, no DROP COLUMN, no RENAME.
--   * No new table — we extend evidence_similarities + widen two
--     existing CHECK constraints.

BEGIN;

SELECT 'Phase 13 intelligence chain: additive only; widens two CHECK constraints and adds one nullable FK column.' AS phase_13_readiness;

-- ---------------------------------------------------------------------------
-- 1. evidence_similarities.graph_edge_id — nullable FK column
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_similarities') THEN
    EXECUTE 'ALTER TABLE "evidence_similarities" ADD COLUMN IF NOT EXISTS "graph_edge_id" UUID NULL';
  END IF;
END $$;

-- Add the FK separately so the column-existence guard above can do
-- its job on partial-state DBs. We also guard the parent table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_similarities')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='investigation_graph_edges')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_similarities' AND column_name='graph_edge_id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_schema='public'
       AND table_name='evidence_similarities'
       AND constraint_name='evidence_similarities_graph_edge_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_similarities"
              ADD CONSTRAINT "evidence_similarities_graph_edge_id_fkey"
              FOREIGN KEY ("graph_edge_id")
              REFERENCES "investigation_graph_edges"("id")
              ON DELETE SET NULL';
  END IF;
END $$;

-- Partial index for the back-reference (only rows promoted to a
-- graph edge). Operator surfaces look this up by graph_edge_id when
-- pivoting from a SIMILAR_TO edge into its audit row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='evidence_similarities')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='evidence_similarities' AND column_name='graph_edge_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_similarities_graph_edge_id_idx"
              ON "evidence_similarities" ("graph_edge_id")
              WHERE "graph_edge_id" IS NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. investigation_graph_nodes.node_kind CHECK — widen with ENTITY
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='investigation_graph_nodes') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_schema='public'
         AND table_name='investigation_graph_nodes'
         AND constraint_name='investigation_graph_nodes_kind_bounded'
    ) THEN
      EXECUTE 'ALTER TABLE "investigation_graph_nodes" DROP CONSTRAINT "investigation_graph_nodes_kind_bounded"';
    END IF;
    EXECUTE 'ALTER TABLE "investigation_graph_nodes"
              ADD CONSTRAINT "investigation_graph_nodes_kind_bounded"
              CHECK ("node_kind" IN (
                ''EVIDENCE'',
                ''CASE'',
                ''INCIDENT'',
                ''REVIEW_TASK'',
                ''ESCALATION'',
                ''LEGAL_HOLD'',
                ''EXPORT'',
                ''REPORT'',
                ''VERIFICATION_PACKAGE'',
                ''MEDIA_SIGNAL'',
                ''OCR'',
                ''TRANSCRIPT'',
                ''EXTERNAL_REVIEW'',
                ''USER_CREATED_ENTITY'',
                ''ENTITY''
              ))';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. investigation_graph_edges.edge_type CHECK — widen with EXTRACTED_FROM
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='investigation_graph_edges') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_schema='public'
         AND table_name='investigation_graph_edges'
         AND constraint_name='investigation_graph_edges_type_bounded'
    ) THEN
      EXECUTE 'ALTER TABLE "investigation_graph_edges" DROP CONSTRAINT "investigation_graph_edges_type_bounded"';
    END IF;
    EXECUTE 'ALTER TABLE "investigation_graph_edges"
              ADD CONSTRAINT "investigation_graph_edges_type_bounded"
              CHECK ("edge_type" IN (
                ''BELONGS_TO_CASE'',
                ''CAPTURED_IN_SESSION'',
                ''SAME_HASH_AS'',
                ''SIMILAR_TO'',
                ''POSSIBLE_DERIVATIVE_OF'',
                ''REFERENCES_SAME_INCIDENT'',
                ''REVIEWED_BY'',
                ''ESCALATED_FROM'',
                ''BLOCKED_BY_LEGAL_HOLD'',
                ''EXPORTED_AS'',
                ''GENERATED_REPORT'',
                ''GENERATED_PACKAGE'',
                ''HAS_MEDIA_SIGNAL'',
                ''HAS_TRANSCRIPT'',
                ''HAS_OCR'',
                ''MANUALLY_LINKED_TO'',
                ''EXTRACTED_FROM''
              ))';
  END IF;
END $$;

COMMIT;
