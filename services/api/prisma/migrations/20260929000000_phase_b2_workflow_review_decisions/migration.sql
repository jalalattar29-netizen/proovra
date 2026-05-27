-- =============================================================================
-- Phase B.2 — Multi-stage review governance (additive).
--
-- This migration is PURELY ADDITIVE:
--   - 3 new enums: workflow_review_stage, workflow_review_decision_kind,
--     workflow_review_reason_code
--   - 1 new table: workflow_review_decisions
--
-- No columns are added or modified on existing tables. No enums are
-- mutated. No data is migrated. Existing review workflows continue to
-- behave exactly as before; the multi-stage review state machine is
-- DERIVED at read-time from rows in the new table.
--
-- Acceptance:
--   - Existing reviewer-ops tests pass unchanged.
--   - New endpoints fail closed if the table is missing.
--   - The unique (workflow_id, stage) index prevents duplicate
--     decisions per stage; resubmissions must roll forward to a new
--     stage (FIRST → SECOND → ADJUDICATION).
--
-- Subsequent phases (not in this migration):
--   - Optional `requires_second_review` column on workflows table.
--     Phase B.2 derives the requirement at read-time from existing
--     state (escalated / legal-hold / redaction-required); a manual
--     override column is a future deliverable.
-- =============================================================================

CREATE TYPE "workflow_review_stage" AS ENUM (
  'FIRST',
  'SECOND',
  'ADJUDICATION'
);

CREATE TYPE "workflow_review_decision_kind" AS ENUM (
  'APPROVE',
  'REJECT',
  'REQUEST_INFO',
  'UPHOLD_FIRST',
  'UPHOLD_SECOND',
  'NEEDS_MORE_INFO',
  'UNRESOLVED'
);

CREATE TYPE "workflow_review_reason_code" AS ENUM (
  'EVIDENCE_INCOMPLETE',
  'REPORT_FAILED',
  'INTEGRITY_CONCERN',
  'CUSTODY_CONCERN',
  'MISSING_CONTEXT',
  'LEGAL_HOLD_ISSUE',
  'REDACTION_REQUIRED',
  'REVIEWER_DISAGREEMENT',
  'OTHER'
);

CREATE TABLE "workflow_review_decisions" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "workflow_id"      UUID         NOT NULL,
  "team_id"          UUID         NOT NULL,
  "stage"            "workflow_review_stage"        NOT NULL,
  "reviewer_user_id" UUID         NOT NULL,
  "decision"         "workflow_review_decision_kind" NOT NULL,
  "reason_code"      "workflow_review_reason_code",
  "rationale"        VARCHAR(4000) NOT NULL,
  "decided_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workflow_review_decisions_pkey" PRIMARY KEY ("id")
);

-- One decision row per (workflow, stage). Resubmissions are rejected
-- at the API layer; the unique constraint is the database-level
-- enforcement.
CREATE UNIQUE INDEX "workflow_review_decisions_workflow_id_stage_key"
  ON "workflow_review_decisions"("workflow_id", "stage");

CREATE INDEX "workflow_review_decisions_workflow_id_decided_at_idx"
  ON "workflow_review_decisions"("workflow_id", "decided_at" DESC);

CREATE INDEX "workflow_review_decisions_team_id_stage_idx"
  ON "workflow_review_decisions"("team_id", "stage");

CREATE INDEX "workflow_review_decisions_reviewer_user_id_idx"
  ON "workflow_review_decisions"("reviewer_user_id");

-- FK to the workflow; on workflow deletion the decision lineage
-- cascades away (workflow no longer exists, decision rows are moot).
ALTER TABLE "workflow_review_decisions"
  ADD CONSTRAINT "workflow_review_decisions_workflow_id_fkey"
  FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- FK to the reviewer. Restrict-on-delete preserves the audit trail —
-- you cannot delete a User who has made review decisions without
-- explicitly transferring or anonymising the decision lineage first.
ALTER TABLE "workflow_review_decisions"
  ADD CONSTRAINT "workflow_review_decisions_reviewer_user_id_fkey"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
