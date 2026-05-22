-- =============================================================================
-- Phase 32.8C FINAL-3 — Enterprise Gap Closure
-- =============================================================================
-- Adds:
--   1. reviewer_capacity_snapshots + ReviewerSaturationLevel /
--      ReviewerCapacitySource enums
--   2. reviewer_routing_recommendations + ReviewerRoutingRecommendationType /
--      ReviewerRoutingRecommendationStatus enums
--   3. bulk_operational_action_runs + BulkOperationalActionType /
--      BulkOperationalActionStatus enums
--   4. bulk_operational_action_items + BulkOperationalActionItemStatus enum
--   5. operational_graph_nodes + OperationalGraphNodeType enum
--   6. operational_graph_edges + OperationalGraphEdgeType enum
--   7. organizational_health_snapshots
--
-- Forward-only. All CREATE TABLE / CREATE TYPE statements use IF NOT
-- EXISTS guards.
--
-- Risks:
--   * All seven tables are ADVISORY operational data. Generator
--     failures MUST NEVER block evidence/report/package/verify core
--     flows. Bulk action runs are written by explicit operator POSTs;
--     the dashboard never triggers them on page load.
--   * No data backfill required.
--
-- Rollback (operator-side, in psql):
--   DROP TABLE IF EXISTS "organizational_health_snapshots";
--   DROP TABLE IF EXISTS "operational_graph_edges";
--   DROP TYPE  IF EXISTS "OperationalGraphEdgeType";
--   DROP TABLE IF EXISTS "operational_graph_nodes";
--   DROP TYPE  IF EXISTS "OperationalGraphNodeType";
--   DROP TABLE IF EXISTS "bulk_operational_action_items";
--   DROP TYPE  IF EXISTS "BulkOperationalActionItemStatus";
--   DROP TABLE IF EXISTS "bulk_operational_action_runs";
--   DROP TYPE  IF EXISTS "BulkOperationalActionStatus";
--   DROP TYPE  IF EXISTS "BulkOperationalActionType";
--   DROP TABLE IF EXISTS "reviewer_routing_recommendations";
--   DROP TYPE  IF EXISTS "ReviewerRoutingRecommendationStatus";
--   DROP TYPE  IF EXISTS "ReviewerRoutingRecommendationType";
--   DROP TABLE IF EXISTS "reviewer_capacity_snapshots";
--   DROP TYPE  IF EXISTS "ReviewerCapacitySource";
--   DROP TYPE  IF EXISTS "ReviewerSaturationLevel";
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewerSaturationLevel') THEN
    CREATE TYPE "ReviewerSaturationLevel" AS ENUM ('LOW','NORMAL','HIGH','CRITICAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewerCapacitySource') THEN
    CREATE TYPE "ReviewerCapacitySource" AS ENUM ('DB_DERIVED','WORKER_INTERNAL','OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewerRoutingRecommendationType') THEN
    CREATE TYPE "ReviewerRoutingRecommendationType" AS ENUM (
      'REASSIGN','ESCALATE','SPLIT_LOAD','REQUEST_REVIEWER','PAUSE_ASSIGNMENT'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewerRoutingRecommendationStatus') THEN
    CREATE TYPE "ReviewerRoutingRecommendationStatus" AS ENUM (
      'OPEN','ACCEPTED','DISMISSED','EXPIRED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkOperationalActionType') THEN
    CREATE TYPE "BulkOperationalActionType" AS ENUM (
      'BULK_ASSIGN_WORKFLOWS','BULK_ESCALATE_WORKFLOWS','BULK_SUPPRESS_INCIDENTS',
      'BULK_RESOLVE_WORKFLOWS','BULK_SCHEDULE_RETRY','BULK_ACKNOWLEDGE_INCIDENTS',
      'BULK_ADD_MITIGATION','BULK_DISMISS_RECOMMENDATIONS'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkOperationalActionStatus') THEN
    CREATE TYPE "BulkOperationalActionStatus" AS ENUM (
      'PENDING','RUNNING','COMPLETED','PARTIAL_FAILED','FAILED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkOperationalActionItemStatus') THEN
    CREATE TYPE "BulkOperationalActionItemStatus" AS ENUM (
      'PENDING','COMPLETED','FAILED','SKIPPED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalGraphNodeType') THEN
    CREATE TYPE "OperationalGraphNodeType" AS ENUM (
      'INCIDENT','WORKFLOW','CORRELATION','CASE','EVIDENCE','QUEUE','WORKER',
      'REVIEWER','GOVERNANCE_POLICY','EXPORT','REPORT','PACKAGE'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalGraphEdgeType') THEN
    CREATE TYPE "OperationalGraphEdgeType" AS ENUM (
      'CAUSED','BLOCKS','DEPENDS_ON','IMPACTS','ESCALATES_TO','MITIGATES',
      'OWNS','ASSIGNED_TO','RELATED_TO'
    );
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- reviewer_capacity_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "reviewer_capacity_snapshots" (
  "id"                 UUID                          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"            UUID                          NOT NULL,
  "reviewer_user_id"   UUID                          NOT NULL,

  "assigned_count"     INTEGER                       NOT NULL DEFAULT 0,
  "overdue_count"      INTEGER                       NOT NULL DEFAULT 0,
  "due_soon_count"     INTEGER                       NOT NULL DEFAULT 0,
  "stale_count"        INTEGER                       NOT NULL DEFAULT 0,
  "completed_7d"       INTEGER                       NOT NULL DEFAULT 0,
  "completed_30d"      INTEGER                       NOT NULL DEFAULT 0,

  "saturation_level"   "ReviewerSaturationLevel"     NOT NULL DEFAULT 'NORMAL',
  "capacity_score"     INTEGER                       NOT NULL DEFAULT 0,

  "sampled_at_utc"     TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),
  "source"             "ReviewerCapacitySource"      NOT NULL DEFAULT 'DB_DERIVED',
  "metadata_json"      JSONB,

  "created_at"         TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),

  CONSTRAINT "reviewer_capacity_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reviewer_capacity_snapshots_team_id_sampled_at_utc_idx"
  ON "reviewer_capacity_snapshots" ("team_id", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "reviewer_capacity_snapshots_team_id_saturation_level_idx"
  ON "reviewer_capacity_snapshots" ("team_id", "saturation_level");
CREATE INDEX IF NOT EXISTS "reviewer_capacity_snapshots_reviewer_user_id_sampled_at_utc_idx"
  ON "reviewer_capacity_snapshots" ("reviewer_user_id", "sampled_at_utc" DESC);

-- -----------------------------------------------------------------------------
-- reviewer_routing_recommendations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "reviewer_routing_recommendations" (
  "id"                       UUID                                       NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID                                       NOT NULL,

  "source_reviewer_user_id"  UUID,
  "target_reviewer_user_id"  UUID,
  "workflow_id"              UUID,
  "evidence_id"              UUID,
  "case_id"                  UUID,

  "recommendation_type"      "ReviewerRoutingRecommendationType"        NOT NULL,
  "severity"                 "OperationalWorkflowSeverity"              NOT NULL DEFAULT 'MEDIUM',
  "reason_code"              VARCHAR(80)                                NOT NULL,
  "explanation"              VARCHAR(400)                               NOT NULL,

  "status"                   "ReviewerRoutingRecommendationStatus"      NOT NULL DEFAULT 'OPEN',
  "recommendation_key"       VARCHAR(200)                               NOT NULL,

  "created_at"               TIMESTAMPTZ(6)                             NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6)                             NOT NULL DEFAULT now(),
  "resolved_at_utc"          TIMESTAMPTZ(6),
  "resolved_by_user_id"      UUID,

  CONSTRAINT "reviewer_routing_recommendations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviewer_routing_recommendations_team_id_recommendation_key_key"
    UNIQUE ("team_id", "recommendation_key")
);

CREATE INDEX IF NOT EXISTS "reviewer_routing_recommendations_team_id_status_idx"
  ON "reviewer_routing_recommendations" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "reviewer_routing_recommendations_source_reviewer_user_id_status_idx"
  ON "reviewer_routing_recommendations" ("source_reviewer_user_id", "status");
CREATE INDEX IF NOT EXISTS "reviewer_routing_recommendations_target_reviewer_user_id_status_idx"
  ON "reviewer_routing_recommendations" ("target_reviewer_user_id", "status");
CREATE INDEX IF NOT EXISTS "reviewer_routing_recommendations_recommendation_type_idx"
  ON "reviewer_routing_recommendations" ("recommendation_type");

-- -----------------------------------------------------------------------------
-- bulk_operational_action_runs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "bulk_operational_action_runs" (
  "id"                  UUID                              NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID                              NOT NULL,

  "action_type"         "BulkOperationalActionType"       NOT NULL,
  "status"              "BulkOperationalActionStatus"     NOT NULL DEFAULT 'PENDING',
  "requested_by_user_id" UUID                             NOT NULL,

  "target_ids_json"     JSONB                             NOT NULL,
  "note_text"           VARCHAR(400),
  "result_json"         JSONB,

  "created_at"          TIMESTAMPTZ(6)                    NOT NULL DEFAULT now(),
  "completed_at_utc"    TIMESTAMPTZ(6),

  CONSTRAINT "bulk_operational_action_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bulk_operational_action_runs_team_id_status_idx"
  ON "bulk_operational_action_runs" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "bulk_operational_action_runs_team_id_created_at_idx"
  ON "bulk_operational_action_runs" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "bulk_operational_action_runs_action_type_idx"
  ON "bulk_operational_action_runs" ("action_type");

-- -----------------------------------------------------------------------------
-- bulk_operational_action_items
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "bulk_operational_action_items" (
  "id"                UUID                                NOT NULL DEFAULT gen_random_uuid(),
  "run_id"            UUID                                NOT NULL,
  "team_id"           UUID                                NOT NULL,
  "target_type"       VARCHAR(40)                         NOT NULL,
  "target_id"         UUID                                NOT NULL,
  "status"            "BulkOperationalActionItemStatus"   NOT NULL DEFAULT 'PENDING',
  "error_code"        VARCHAR(80),
  "completed_at_utc"  TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6)                      NOT NULL DEFAULT now(),

  CONSTRAINT "bulk_operational_action_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bulk_operational_action_items_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "bulk_operational_action_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "bulk_operational_action_items_run_id_idx"
  ON "bulk_operational_action_items" ("run_id");
CREATE INDEX IF NOT EXISTS "bulk_operational_action_items_team_id_status_idx"
  ON "bulk_operational_action_items" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "bulk_operational_action_items_target_type_target_id_idx"
  ON "bulk_operational_action_items" ("target_type", "target_id");

-- -----------------------------------------------------------------------------
-- operational_graph_nodes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_graph_nodes" (
  "id"           UUID                            NOT NULL DEFAULT gen_random_uuid(),
  "team_id"      UUID                            NOT NULL,
  "node_type"    "OperationalGraphNodeType"      NOT NULL,
  "entity_id"    UUID                            NOT NULL,
  "label"        VARCHAR(180)                    NOT NULL,
  "severity"     VARCHAR(16)                     NOT NULL,
  "status"       VARCHAR(40)                     NOT NULL,
  "created_at"   TIMESTAMPTZ(6)                  NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6)                  NOT NULL DEFAULT now(),

  CONSTRAINT "operational_graph_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_graph_nodes_team_id_node_type_entity_id_key"
    UNIQUE ("team_id", "node_type", "entity_id")
);

CREATE INDEX IF NOT EXISTS "operational_graph_nodes_team_id_node_type_idx"
  ON "operational_graph_nodes" ("team_id", "node_type");
CREATE INDEX IF NOT EXISTS "operational_graph_nodes_team_id_severity_idx"
  ON "operational_graph_nodes" ("team_id", "severity");

-- -----------------------------------------------------------------------------
-- operational_graph_edges
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_graph_edges" (
  "id"             UUID                          NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID                          NOT NULL,
  "source_node_id" UUID                          NOT NULL,
  "target_node_id" UUID                          NOT NULL,
  "edge_type"      "OperationalGraphEdgeType"    NOT NULL,
  "confidence"     VARCHAR(24)                   NOT NULL,
  "reason_code"    VARCHAR(80)                   NOT NULL,
  "created_at"     TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),

  CONSTRAINT "operational_graph_edges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_graph_edges_team_id_source_node_id_target_node_id_edge_type_key"
    UNIQUE ("team_id", "source_node_id", "target_node_id", "edge_type")
);

CREATE INDEX IF NOT EXISTS "operational_graph_edges_team_id_edge_type_idx"
  ON "operational_graph_edges" ("team_id", "edge_type");
CREATE INDEX IF NOT EXISTS "operational_graph_edges_source_node_id_idx"
  ON "operational_graph_edges" ("source_node_id");
CREATE INDEX IF NOT EXISTS "operational_graph_edges_target_node_id_idx"
  ON "operational_graph_edges" ("target_node_id");

-- -----------------------------------------------------------------------------
-- organizational_health_snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organizational_health_snapshots" (
  "id"                          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID,
  "workspace_id"                UUID,

  "health_score"                INTEGER,
  "operational_maturity_score"  INTEGER,
  "governance_maturity_score"   INTEGER,
  "audit_readiness_score"       INTEGER,
  "reviewer_maturity_score"     INTEGER,

  "incident_frequency_7d"       INTEGER,
  "workflow_completion_7d"      INTEGER,
  "queue_reliability_score"     INTEGER,
  "artifact_reliability_score"  INTEGER,

  "sampled_at_utc"              TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "source"                      VARCHAR(40)     NOT NULL,
  "metadata_json"               JSONB,

  "created_at"                  TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),

  CONSTRAINT "organizational_health_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "organizational_health_snapshots_team_id_sampled_at_utc_idx"
  ON "organizational_health_snapshots" ("team_id", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "organizational_health_snapshots_workspace_id_sampled_at_utc_idx"
  ON "organizational_health_snapshots" ("workspace_id", "sampled_at_utc" DESC);
