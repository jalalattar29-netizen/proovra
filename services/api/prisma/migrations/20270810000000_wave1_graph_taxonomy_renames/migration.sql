-- Wave 1 — Investigation graph taxonomy renames + new deferred kinds.
--
-- Additive CHECK widening. Producers will write the new canonical names;
-- existing rows using the old names remain valid (kept as deprecated
-- aliases for backward compatibility for one release).
--
-- Renames (both old + new are co-listed in the CHECK):
--   REVIEW_TASK      → REVIEW_WORKFLOW            (old kept as alias)
--   ESCALATION       → REVIEW_ESCALATION          (old kept as alias)
--   EXTERNAL_REVIEW  → EXTERNAL_REVIEWER_GRANT    (old kept as alias)
--   MEDIA_SIGNAL     → MEDIA_INTELLIGENCE_SIGNAL  (old kept as alias)
--   ENTITY           → EXTRACTED_ENTITY           (old kept as alias)
--
-- New deferred node kinds (no producer in this wave; CHECK pre-widened
-- so future waves can land producers without another CHECK migration):
--   EVIDENCE_PART, CASE_EVIDENCE_LINK, REVIEW_DECISION,
--   MEDIA_INTELLIGENCE_RECORD, CUSTODY_EVENT
--
-- New deferred edge types (no producer in this wave):
--   HAS_PART, HAS_REVIEW_DECISION, HAS_MEDIA_RECORD, HAS_CUSTODY_EVENT
--
-- Hard rules satisfied:
--   * Phase O additive pattern: every ALTER inside a DO $$ block guarded
--     by pg_tables so a partial-state DB is a clean no-op.
--   * The constraint widening uses DROP CONSTRAINT IF EXISTS + ADD
--     CONSTRAINT (the only Postgres pattern for widening a CHECK).
--   * No DROP TABLE, no DROP COLUMN, no RENAME, no data movement.
--   * Idempotent — re-running on a DB that already has the widened
--     constraint is a no-op (DROP IF EXISTS + ADD with the same set).

BEGIN;

SELECT 'Wave 1 graph taxonomy renames: additive CHECK widening for 5 renames + 5 new node kinds + 4 new edge types.' AS wave1_readiness;

-- ---------------------------------------------------------------------------
-- 1. investigation_graph_nodes.node_kind CHECK — widen with the renamed
--    canonical names + the 5 new deferred kinds. Existing names remain
--    valid (deprecated aliases).
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
                ''REVIEW_WORKFLOW'',
                ''REVIEW_TASK'',
                ''REVIEW_ESCALATION'',
                ''ESCALATION'',
                ''LEGAL_HOLD'',
                ''EXPORT'',
                ''REPORT'',
                ''VERIFICATION_PACKAGE'',
                ''MEDIA_INTELLIGENCE_SIGNAL'',
                ''MEDIA_SIGNAL'',
                ''OCR'',
                ''TRANSCRIPT'',
                ''EXTERNAL_REVIEWER_GRANT'',
                ''EXTERNAL_REVIEW'',
                ''USER_CREATED_ENTITY'',
                ''EXTRACTED_ENTITY'',
                ''ENTITY'',
                ''EVIDENCE_PART'',
                ''CASE_EVIDENCE_LINK'',
                ''REVIEW_DECISION'',
                ''MEDIA_INTELLIGENCE_RECORD'',
                ''CUSTODY_EVENT''
              ))';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. investigation_graph_edges.edge_type CHECK — widen with the 4 new
--    deferred edge types. Existing types remain valid.
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
                ''EXTRACTED_FROM'',
                ''HAS_PART'',
                ''HAS_REVIEW_DECISION'',
                ''HAS_MEDIA_RECORD'',
                ''HAS_CUSTODY_EVENT''
              ))';
  END IF;
END $$;

COMMIT;
