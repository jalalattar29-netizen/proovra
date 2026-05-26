-- =============================================================================
-- Phase E3 — Operational Automation Foundation
--
-- Adds two tables for bounded automation:
--
--   * automation_rules  — team-scoped allowlisted trigger + action rules.
--   * automation_runs   — per-execution audit row with idempotency key.
--
-- Hard rules (also enforced by the service layer):
--   - Trigger types restricted to the E3 allowlist (CHECK constraint).
--   - Action types restricted to the E3 allowlist (CHECK constraint).
--   - Status of automation_runs is a bounded set (CHECK constraint).
--   - Team-scoped: every row carries team_id with CASCADE on team delete.
--   - Idempotency: unique partial index on (team_id, rule_id, idempotency_key)
--     prevents duplicate runs for the same trigger+target.
--
-- Trigger DISPATCHER + worker execution are intentionally NOT in this
-- migration. E3 ships the schema + service + API + UI foundation; actual
-- runtime execution wiring is deferred to E3.1 (registered as DEF-021).
-- =============================================================================

CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger_type" VARCHAR(60) NOT NULL,
    "condition_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "action_type" VARCHAR(60) NOT NULL,
    "action_config_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- Enforce the E3 allowlist for trigger and action types at the database
-- layer. Adding a new type requires a coordinated migration + service
-- update — the safety belt is intentional.
ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_trigger_type_allowlist"
  CHECK ("trigger_type" IN (
    'EVIDENCE_CREATED',
    'EVIDENCE_FINALIZED',
    'EVIDENCE_REPORTED',
    'PACKAGE_READY',
    'REVIEW_ASSIGNED',
    'REVIEW_OVERDUE',
    'SLA_DUE_SOON',
    'ESCALATION_CREATED',
    'LEGAL_HOLD_CREATED',
    'RETENTION_CANDIDATE_FOUND',
    'EXTERNAL_ACCESS_EXPIRING'
  ));

ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_action_type_allowlist"
  CHECK ("action_type" IN (
    'NOTIFY_USER',
    'NOTIFY_ROLE',
    'CREATE_REVIEW_TASK',
    'CREATE_ESCALATION',
    'ASSIGN_REVIEWER',
    'APPLY_LABEL',
    'ADD_OPERATIONAL_COMMENT'
  ));

CREATE INDEX "automation_rules_team_idx" ON "automation_rules"("team_id");
CREATE INDEX "automation_rules_team_enabled_idx"
  ON "automation_rules"("team_id", "enabled");
CREATE INDEX "automation_rules_team_trigger_idx"
  ON "automation_rules"("team_id", "trigger_type");

ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_team_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_created_by_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_updated_by_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- automation_runs
-- =============================================================================

CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "trigger_type" VARCHAR(60) NOT NULL,
    "target_type" VARCHAR(60) NOT NULL,
    "target_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(400),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "automation_runs"
  ADD CONSTRAINT "automation_runs_status_allowlist"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'));

-- Idempotency: at most one run per (team, rule, idempotency_key). The
-- service computes the idempotency key deterministically from the
-- trigger + target so duplicate trigger events do not duplicate actions.
CREATE UNIQUE INDEX "automation_runs_team_rule_idempotency_uniq"
  ON "automation_runs"("team_id", "rule_id", "idempotency_key");

CREATE INDEX "automation_runs_team_created_idx"
  ON "automation_runs"("team_id", "created_at" DESC);
CREATE INDEX "automation_runs_team_rule_created_idx"
  ON "automation_runs"("team_id", "rule_id", "created_at" DESC);
CREATE INDEX "automation_runs_team_status_idx"
  ON "automation_runs"("team_id", "status");

ALTER TABLE "automation_runs"
  ADD CONSTRAINT "automation_runs_team_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_runs"
  ADD CONSTRAINT "automation_runs_rule_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
