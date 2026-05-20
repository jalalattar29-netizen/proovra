-- =============================================================================
-- Phase 32 — Investigation graph data model
-- =============================================================================
--
-- Three tables:
--
--   * investigation_graph_nodes — one row per logical entity in the
--     investigation graph. Most node kinds project from existing
--     domain rows (EVIDENCE → Evidence row, CASE → Case row, etc.);
--     the graph table carries only the projection + visibility
--     metadata. USER_CREATED_ENTITY is the one exception that has
--     no upstream — operators create it via the manual-relationship
--     UI.
--
--   * investigation_graph_edges — directed edges between nodes,
--     with bounded edge_type vocabulary and team-anchored scope.
--     System-built edges have `source_kind = 'SYSTEM'`; user-built
--     edges have `source_kind = 'MANUAL'`.
--
--   * manual_relationships — separate, write-side log of operator-
--     created relationships. Audit trail. Source of truth for
--     MANUALLY_LINKED_TO edges in the graph_edges table.
--
-- Hard rules encoded here:
--   * Every table is team_id-anchored. No cross-team graph traversal
--     is possible at the schema level — the API layer enforces
--     visibility on top.
--   * Edge type / node type are CHECK-bounded against the catalog.
--   * Confidence bounded LOW / MEDIUM / HIGH (matches the rest of
--     the platform's vocabulary).
--   * stale_at_utc lets the reconciliation worker mark edges
--     inactive without deleting them (preserves audit trail).
--   * No raw GPS, no storage_key, no signed URLs in any column.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- Nodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "investigation_graph_nodes" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  -- Bounded node-kind vocabulary. Catalogued in service layer.
  "node_kind"                VARCHAR(32) NOT NULL,
  -- Reference to the upstream entity. For EVIDENCE/CASE/REVIEW_TASK/
  -- etc., this is the source row's UUID. For USER_CREATED_ENTITY,
  -- this is the manual-relationship row id.
  "external_id"              UUID NOT NULL,
  -- Operator-facing label. Bounded. Never includes private notes,
  -- legal notes, or raw evidence content.
  "safe_label"               VARCHAR(240),
  -- Visibility scope. Bounded. Drives the API's visibility filter.
  "visibility_scope"         VARCHAR(32) NOT NULL DEFAULT 'WORKSPACE_INTERNAL',
  -- Soft-delete: when set, the API hides the node + every edge
  -- touching it. Used by the reconciliation worker to tombstone
  -- nodes whose upstream row was destroyed / hidden by legal hold.
  "stale_at_utc"             TIMESTAMPTZ(6),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "investigation_graph_nodes_kind_bounded"
    CHECK ("node_kind" IN (
      'EVIDENCE',
      'CASE',
      'INCIDENT',
      'REVIEW_TASK',
      'ESCALATION',
      'LEGAL_HOLD',
      'EXPORT',
      'REPORT',
      'VERIFICATION_PACKAGE',
      'MEDIA_SIGNAL',
      'OCR',
      'TRANSCRIPT',
      'EXTERNAL_REVIEW',
      'USER_CREATED_ENTITY'
    )),
  CONSTRAINT "investigation_graph_nodes_visibility_bounded"
    CHECK ("visibility_scope" IN (
      'WORKSPACE_INTERNAL',
      'REVIEWER_RESTRICTED',
      'EXTERNAL_REVIEWER_SCOPED',
      'PUBLIC_VERIFY_SAFE'
    ))
);

-- Unique per-team (kind, external_id) so the graph builder can
-- upsert idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_nodes_team_kind_ext_uk"
  ON "investigation_graph_nodes" ("team_id", "node_kind", "external_id");

CREATE INDEX IF NOT EXISTS "investigation_graph_nodes_team_kind_idx"
  ON "investigation_graph_nodes" ("team_id", "node_kind")
  WHERE "stale_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- Edges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "investigation_graph_edges" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "source_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "target_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  -- Bounded edge-type vocabulary.
  "edge_type"                VARCHAR(48) NOT NULL,
  -- 'SYSTEM' for builder-produced edges, 'MANUAL' for operator-
  -- created edges. Source distinction matters for the visibility
  -- + acknowledgement UX.
  "source_kind"              VARCHAR(16) NOT NULL DEFAULT 'SYSTEM',
  "confidence"               VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  -- Operator-readable summary. Bounded. Safe-wording-library
  -- enforced at the service layer.
  "safe_summary"             VARCHAR(240),
  "created_by_user_id"       UUID,
  "stale_at_utc"             TIMESTAMPTZ(6),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "investigation_graph_edges_type_bounded"
    CHECK ("edge_type" IN (
      'BELONGS_TO_CASE',
      'CAPTURED_IN_SESSION',
      'SAME_HASH_AS',
      'SIMILAR_TO',
      'POSSIBLE_DERIVATIVE_OF',
      'REFERENCES_SAME_INCIDENT',
      'REVIEWED_BY',
      'ESCALATED_FROM',
      'BLOCKED_BY_LEGAL_HOLD',
      'EXPORTED_AS',
      'GENERATED_REPORT',
      'GENERATED_PACKAGE',
      'HAS_MEDIA_SIGNAL',
      'HAS_TRANSCRIPT',
      'HAS_OCR',
      'MANUALLY_LINKED_TO'
    )),
  CONSTRAINT "investigation_graph_edges_source_kind_bounded"
    CHECK ("source_kind" IN ('SYSTEM', 'MANUAL')),
  CONSTRAINT "investigation_graph_edges_confidence_bounded"
    CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH'))
);

-- Upsert key: per-team unique (source, target, edge_type).
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_edges_team_triple_uk"
  ON "investigation_graph_edges" ("team_id", "source_node_id", "target_node_id", "edge_type");

-- Outgoing traversal: "given a node, what are its outbound edges?"
CREATE INDEX IF NOT EXISTS "investigation_graph_edges_outbound_idx"
  ON "investigation_graph_edges" ("team_id", "source_node_id", "edge_type")
  WHERE "stale_at_utc" IS NULL;

-- Incoming traversal.
CREATE INDEX IF NOT EXISTS "investigation_graph_edges_inbound_idx"
  ON "investigation_graph_edges" ("team_id", "target_node_id", "edge_type")
  WHERE "stale_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- Manual relationships (audit log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "manual_relationships" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"                  UUID NOT NULL,
  "source_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "target_node_id"           UUID NOT NULL REFERENCES "investigation_graph_nodes"("id") ON DELETE CASCADE,
  "edge_type"                VARCHAR(48) NOT NULL,
  "created_by_user_id"       UUID NOT NULL,
  -- Operator note. Bounded. Audit-only; never indexed by search.
  "safe_note"                VARCHAR(400),
  -- Lifecycle: ACTIVE while the relationship stands; RETRACTED
  -- when an operator removes it (we keep the row for audit).
  "status"                   VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "retracted_by_user_id"     UUID,
  "retracted_at_utc"         TIMESTAMPTZ(6),
  "retraction_reason"        VARCHAR(240),
  "created_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "manual_relationships_edge_type_bounded"
    CHECK ("edge_type" IN (
      'REFERENCES_SAME_INCIDENT',
      'MANUALLY_LINKED_TO'
    )),
  CONSTRAINT "manual_relationships_status_bounded"
    CHECK ("status" IN ('ACTIVE', 'RETRACTED'))
);

CREATE INDEX IF NOT EXISTS "manual_relationships_team_status_idx"
  ON "manual_relationships" ("team_id", "status", "created_at_utc" DESC);

CREATE INDEX IF NOT EXISTS "manual_relationships_source_target_idx"
  ON "manual_relationships" ("team_id", "source_node_id", "target_node_id");

COMMIT;
