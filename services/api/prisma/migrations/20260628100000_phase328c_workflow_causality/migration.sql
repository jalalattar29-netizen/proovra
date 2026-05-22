-- =============================================================================
-- Phase 32.8C FINAL-2 — Workflow Orchestration + Operational Causality
-- =============================================================================
-- Adds:
--   1. operational_workflows + 5 enums (workflowType / status / severity /
--      priority / eventType / actionType — 6 enums total)
--   2. operational_workflow_events
--   3. operational_workflow_actions
--   4. operational_causality_links + 2 enums (relation / confidence)
--   5. operational_causality_chains + 2 enums (chainStatus / rootCauseType)
--
-- Forward-only. All CREATE statements use IF NOT EXISTS. All enums wrapped
-- in DO $$ IF NOT EXISTS guards.
--
-- Risks:
--   * All five tables are ADVISORY operational data. Generator failures
--     MUST NEVER block evidence / report / package / verify core flows.
--   * No data backfill required. Tables populate lazily on dashboard read
--     and via explicit operator actions.
--   * No FK to OperationalIncident / OperationalCorrelation — workflows
--     and chains soft-link via UUID columns. This is deliberate so that
--     incident deletion never cascades into the workflow audit history.
--
-- Rollback (operator-side, in psql):
--   DROP INDEX IF EXISTS ALL operational_causality_chains_* indexes;
--   DROP TABLE IF EXISTS "operational_causality_chains";
--   DROP TYPE  IF EXISTS "OperationalCausalityChainStatus";
--   DROP TYPE  IF EXISTS "OperationalCausalityRootCauseType";
--   DROP INDEX IF EXISTS ALL operational_causality_links_* indexes;
--   DROP TABLE IF EXISTS "operational_causality_links";
--   DROP TYPE  IF EXISTS "OperationalCausalityConfidence";
--   DROP TYPE  IF EXISTS "OperationalCausalityRelation";
--   DROP TABLE IF EXISTS "operational_workflow_actions";
--   DROP TYPE  IF EXISTS "OperationalWorkflowActionType";
--   DROP TABLE IF EXISTS "operational_workflow_events";
--   DROP TYPE  IF EXISTS "OperationalWorkflowEventType";
--   DROP TABLE IF EXISTS "operational_workflows";
--   DROP TYPE  IF EXISTS "OperationalWorkflowPriority";
--   DROP TYPE  IF EXISTS "OperationalWorkflowSeverity";
--   DROP TYPE  IF EXISTS "OperationalWorkflowStatus";
--   DROP TYPE  IF EXISTS "OperationalWorkflowType";
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. enums
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowType') THEN
    CREATE TYPE "OperationalWorkflowType" AS ENUM (
      'REPORT_RETRY',
      'PACKAGE_RETRY',
      'REVIEW_ESCALATION',
      'GOVERNANCE_ESCALATION',
      'QUEUE_RECOVERY',
      'TELEMETRY_RECOVERY',
      'INTEGRITY_REVIEW',
      'AUDIT_READINESS',
      'CASE_RISK_MITIGATION',
      'COORDINATION_RESOLUTION',
      'EXPORT_BLOCKER_RESOLUTION',
      'OTHER'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowStatus') THEN
    CREATE TYPE "OperationalWorkflowStatus" AS ENUM (
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'WAITING_ON_SYSTEM',
      'WAITING_ON_REVIEWER',
      'WAITING_ON_GOVERNANCE',
      'MITIGATING',
      'RESOLVED',
      'SUPPRESSED',
      'FAILED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowSeverity') THEN
    CREATE TYPE "OperationalWorkflowSeverity" AS ENUM (
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowPriority') THEN
    CREATE TYPE "OperationalWorkflowPriority" AS ENUM (
      'P0',
      'P1',
      'P2',
      'P3'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowEventType') THEN
    CREATE TYPE "OperationalWorkflowEventType" AS ENUM (
      'CREATED',
      'ASSIGNED',
      'STARTED',
      'RETRY_SCHEDULED',
      'RETRY_ATTEMPTED',
      'ESCALATED',
      'MITIGATION_ADDED',
      'STATUS_CHANGED',
      'RESOLVED',
      'SUPPRESSED',
      'FAILED',
      'REOPENED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalWorkflowActionType') THEN
    CREATE TYPE "OperationalWorkflowActionType" AS ENUM (
      'ASSIGN',
      'START',
      'SCHEDULE_RETRY',
      'RECORD_RETRY_FAILURE',
      'ESCALATE',
      'ADD_MITIGATION',
      'RESOLVE',
      'SUPPRESS',
      'REOPEN'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalCausalityRelation') THEN
    CREATE TYPE "OperationalCausalityRelation" AS ENUM (
      'CAUSED_BY',
      'FOLLOWED_BY',
      'ESCALATED_TO',
      'BLOCKED_BY',
      'MITIGATED_BY',
      'RETRIED_BY',
      'RELATED_TO',
      'PART_OF',
      'ROOT_CAUSE_OF'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalCausalityConfidence') THEN
    CREATE TYPE "OperationalCausalityConfidence" AS ENUM (
      'DIRECT',
      'INFERRED_HIGH',
      'INFERRED_MEDIUM',
      'INFERRED_LOW'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalCausalityChainStatus') THEN
    CREATE TYPE "OperationalCausalityChainStatus" AS ENUM (
      'ACTIVE',
      'RESOLVED',
      'SUPPRESSED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalCausalityRootCauseType') THEN
    CREATE TYPE "OperationalCausalityRootCauseType" AS ENUM (
      'PIPELINE_FAILURE',
      'REVIEWER_BOTTLENECK',
      'GOVERNANCE_BLOCKER',
      'INTEGRITY_AUDIT',
      'TELEMETRY_QUEUE',
      'COORDINATION_CASE_RISK',
      'OTHER'
    );
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. operational_workflows
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_workflows" (
  "id"                       UUID                              NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID                              NOT NULL,
  "workflow_key"             VARCHAR(200)                      NOT NULL,
  "workflow_type"            "OperationalWorkflowType"         NOT NULL,
  "status"                   "OperationalWorkflowStatus"       NOT NULL DEFAULT 'OPEN',
  "severity"                 "OperationalWorkflowSeverity"     NOT NULL DEFAULT 'MEDIUM',
  "priority"                 "OperationalWorkflowPriority"     NOT NULL DEFAULT 'P2',

  "title"                    VARCHAR(180)                      NOT NULL,
  "safe_summary"             VARCHAR(400)                      NOT NULL,

  "source_incident_id"       UUID,
  "source_correlation_id"    UUID,
  "case_id"                  UUID,
  "evidence_id"              UUID,
  "queue_name"               VARCHAR(80),

  "assigned_owner_user_id"   UUID,
  "assigned_by_user_id"      UUID,
  "assigned_at_utc"          TIMESTAMPTZ(6),

  "escalation_level"         INTEGER                           NOT NULL DEFAULT 0,
  "retry_count"              INTEGER                           NOT NULL DEFAULT 0,
  "next_retry_at_utc"        TIMESTAMPTZ(6),
  "last_attempt_at_utc"      TIMESTAMPTZ(6),
  "last_failure_code"        VARCHAR(80),

  "mitigation_summary"       VARCHAR(400),
  "resolution_summary"       VARCHAR(400),

  "due_at_utc"               TIMESTAMPTZ(6),
  "resolved_at_utc"          TIMESTAMPTZ(6),

  "metadata_json"            JSONB,

  "created_at"               TIMESTAMPTZ(6)                    NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6)                    NOT NULL DEFAULT now(),

  CONSTRAINT "operational_workflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_workflows_team_id_workflow_key_key"
    UNIQUE ("team_id", "workflow_key")
);

CREATE INDEX IF NOT EXISTS "operational_workflows_team_id_status_idx"
  ON "operational_workflows" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "operational_workflows_team_id_workflow_type_idx"
  ON "operational_workflows" ("team_id", "workflow_type");
CREATE INDEX IF NOT EXISTS "operational_workflows_severity_status_idx"
  ON "operational_workflows" ("severity", "status");
CREATE INDEX IF NOT EXISTS "operational_workflows_assigned_owner_user_id_status_idx"
  ON "operational_workflows" ("assigned_owner_user_id", "status");
CREATE INDEX IF NOT EXISTS "operational_workflows_due_at_utc_idx"
  ON "operational_workflows" ("due_at_utc");
CREATE INDEX IF NOT EXISTS "operational_workflows_source_incident_id_idx"
  ON "operational_workflows" ("source_incident_id");
CREATE INDEX IF NOT EXISTS "operational_workflows_source_correlation_id_idx"
  ON "operational_workflows" ("source_correlation_id");
CREATE INDEX IF NOT EXISTS "operational_workflows_case_id_idx"
  ON "operational_workflows" ("case_id");
CREATE INDEX IF NOT EXISTS "operational_workflows_evidence_id_idx"
  ON "operational_workflows" ("evidence_id");
CREATE INDEX IF NOT EXISTS "operational_workflows_queue_name_idx"
  ON "operational_workflows" ("queue_name");

-- -----------------------------------------------------------------------------
-- 3. operational_workflow_events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_workflow_events" (
  "id"             UUID                                NOT NULL DEFAULT gen_random_uuid(),
  "workflow_id"    UUID                                NOT NULL,
  "team_id"        UUID                                NOT NULL,
  "event_type"     "OperationalWorkflowEventType"      NOT NULL,
  "actor_user_id"  UUID,
  "from_status"    "OperationalWorkflowStatus",
  "to_status"      "OperationalWorkflowStatus",
  "summary"        VARCHAR(400)                        NOT NULL,
  "metadata_json"  JSONB,
  "occurred_at_utc" TIMESTAMPTZ(6)                     NOT NULL DEFAULT now(),

  CONSTRAINT "operational_workflow_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_workflow_events_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "operational_workflows"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "operational_workflow_events_workflow_id_occurred_at_utc_idx"
  ON "operational_workflow_events" ("workflow_id", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_workflow_events_team_id_occurred_at_utc_idx"
  ON "operational_workflow_events" ("team_id", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_workflow_events_event_type_idx"
  ON "operational_workflow_events" ("event_type");

-- -----------------------------------------------------------------------------
-- 4. operational_workflow_actions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_workflow_actions" (
  "id"                  UUID                              NOT NULL DEFAULT gen_random_uuid(),
  "workflow_id"         UUID                              NOT NULL,
  "team_id"             UUID                              NOT NULL,
  "action_type"         "OperationalWorkflowActionType"   NOT NULL,
  "permission_required" VARCHAR(80)                       NOT NULL,
  "required_roles"      JSONB                             NOT NULL,
  "safe_action_label"   VARCHAR(80)                       NOT NULL,
  "route"               VARCHAR(400),
  "created_at"          TIMESTAMPTZ(6)                    NOT NULL DEFAULT now(),

  CONSTRAINT "operational_workflow_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_workflow_actions_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "operational_workflows"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "operational_workflow_actions_workflow_id_idx"
  ON "operational_workflow_actions" ("workflow_id");
CREATE INDEX IF NOT EXISTS "operational_workflow_actions_team_id_action_type_idx"
  ON "operational_workflow_actions" ("team_id", "action_type");

-- -----------------------------------------------------------------------------
-- 5. operational_causality_links
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_causality_links" (
  "id"                       UUID                              NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID                              NOT NULL,

  "source_event_id"          UUID,
  "target_event_id"          UUID,
  "source_incident_id"       UUID,
  "target_incident_id"       UUID,
  "source_workflow_id"       UUID,
  "target_workflow_id"       UUID,
  "source_correlation_id"    UUID,
  "target_correlation_id"    UUID,

  "relation_type"            "OperationalCausalityRelation"    NOT NULL,
  "confidence"               "OperationalCausalityConfidence"  NOT NULL DEFAULT 'INFERRED_HIGH',
  "reason_code"              VARCHAR(80)                       NOT NULL,
  "explanation"              VARCHAR(400)                      NOT NULL,

  "created_at"               TIMESTAMPTZ(6)                    NOT NULL DEFAULT now(),

  CONSTRAINT "operational_causality_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "operational_causality_links_team_id_idx"
  ON "operational_causality_links" ("team_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_source_incident_id_idx"
  ON "operational_causality_links" ("source_incident_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_target_incident_id_idx"
  ON "operational_causality_links" ("target_incident_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_source_workflow_id_idx"
  ON "operational_causality_links" ("source_workflow_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_target_workflow_id_idx"
  ON "operational_causality_links" ("target_workflow_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_source_event_id_idx"
  ON "operational_causality_links" ("source_event_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_target_event_id_idx"
  ON "operational_causality_links" ("target_event_id");
CREATE INDEX IF NOT EXISTS "operational_causality_links_relation_type_idx"
  ON "operational_causality_links" ("relation_type");

-- -----------------------------------------------------------------------------
-- 6. operational_causality_chains
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_causality_chains" (
  "id"                       UUID                                  NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID                                  NOT NULL,
  "chain_key"                VARCHAR(200)                          NOT NULL,
  "title"                    VARCHAR(180)                          NOT NULL,
  "summary"                  VARCHAR(400)                          NOT NULL,
  "root_cause_type"          "OperationalCausalityRootCauseType"   NOT NULL,
  "severity"                 "OperationalWorkflowSeverity"         NOT NULL DEFAULT 'MEDIUM',
  "status"                   "OperationalCausalityChainStatus"     NOT NULL DEFAULT 'ACTIVE',

  "linked_incident_ids"      JSONB,
  "linked_workflow_ids"      JSONB,
  "linked_correlation_ids"   JSONB,
  "linked_case_ids"          JSONB,
  "linked_evidence_ids"      JSONB,

  "start_at_utc"             TIMESTAMPTZ(6)                        NOT NULL DEFAULT now(),
  "last_seen_at_utc"         TIMESTAMPTZ(6)                        NOT NULL DEFAULT now(),
  "resolved_at_utc"          TIMESTAMPTZ(6),

  "created_at"               TIMESTAMPTZ(6)                        NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6)                        NOT NULL DEFAULT now(),

  CONSTRAINT "operational_causality_chains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_causality_chains_team_id_chain_key_key"
    UNIQUE ("team_id", "chain_key")
);

CREATE INDEX IF NOT EXISTS "operational_causality_chains_team_id_status_idx"
  ON "operational_causality_chains" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "operational_causality_chains_team_id_last_seen_at_utc_idx"
  ON "operational_causality_chains" ("team_id", "last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_causality_chains_root_cause_type_idx"
  ON "operational_causality_chains" ("root_cause_type");
CREATE INDEX IF NOT EXISTS "operational_causality_chains_severity_idx"
  ON "operational_causality_chains" ("severity");
