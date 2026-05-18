-- Phase 13 — Enterprise review operations platform
--
-- Forward-only additive migration:
--   * Adds new enum values to EvidenceReviewWorkflowStatus
--     (QUEUED, ASSIGNED, RESPONSE_RECEIVED, REJECTED_INSUFFICIENT, REOPENED).
--   * Adds new enum values to EvidenceReviewWorkflowEventType
--     (REASSIGNED, CLAIMED, STAGE_CHANGED, APPROVED_INTERNAL,
--      REJECTED_INSUFFICIENT, NEEDS_MORE_INFO, RESPONSE_RECEIVED,
--      REOPENED, SLA_UPDATED, SLA_BREACHED, BULK_ACTION,
--      DECISION_LOGGED).
--   * Adds new enum EvidenceReviewSlaStatus.
--   * Adds SLA / escalation / reopen columns to evidence_review_workflows.
--   * No existing rows mutated; existing enum values preserved exactly.
--
-- Rollback risk: low for new columns + types. Postgres does not allow
-- removing enum VALUES easily; the workflow rows can fall back to the
-- legacy status set without code changes if those columns are dropped:
--   ALTER TABLE evidence_review_workflows
--     DROP COLUMN ... ;
--   -- Enum values cannot be removed; new rows simply will not appear.

-- 1. New enum values ------------------------------------------------------

ALTER TYPE "EvidenceReviewWorkflowStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "EvidenceReviewWorkflowStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "EvidenceReviewWorkflowStatus" ADD VALUE IF NOT EXISTS 'RESPONSE_RECEIVED';
ALTER TYPE "EvidenceReviewWorkflowStatus" ADD VALUE IF NOT EXISTS 'REJECTED_INSUFFICIENT';
ALTER TYPE "EvidenceReviewWorkflowStatus" ADD VALUE IF NOT EXISTS 'REOPENED';

ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'REASSIGNED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'CLAIMED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'STAGE_CHANGED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'APPROVED_INTERNAL';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'REJECTED_INSUFFICIENT';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'NEEDS_MORE_INFO';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'RESPONSE_RECEIVED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'REOPENED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'SLA_UPDATED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'SLA_BREACHED';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'BULK_ACTION';
ALTER TYPE "EvidenceReviewWorkflowEventType" ADD VALUE IF NOT EXISTS 'DECISION_LOGGED';

-- 2. New EvidenceReviewSlaStatus enum -------------------------------------

DO $$ BEGIN
  CREATE TYPE "EvidenceReviewSlaStatus" AS ENUM (
    'ON_TRACK',
    'DUE_SOON',
    'OVERDUE',
    'BREACHED',
    'PAUSED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. EvidenceReviewWorkflow column additions ------------------------------

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "assigned_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reassigned_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "first_response_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "escalation_due_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "sla_status" "EvidenceReviewSlaStatus",
  ADD COLUMN IF NOT EXISTS "sla_paused_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "escalation_level" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "escalated_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "escalated_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "escalation_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "rejection_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "reopen_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reopened_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reopened_by_user_id" UUID;

DO $$ BEGIN
  ALTER TABLE "evidence_review_workflows"
    ADD CONSTRAINT "evidence_review_workflows_escalated_by_fkey"
      FOREIGN KEY ("escalated_by_user_id") REFERENCES "users" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "evidence_review_workflows"
    ADD CONSTRAINT "evidence_review_workflows_reopened_by_fkey"
      FOREIGN KEY ("reopened_by_user_id") REFERENCES "users" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 4. Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "evidence_review_workflows_sla_status_due_at_idx"
  ON "evidence_review_workflows" ("sla_status", "due_at");
CREATE INDEX IF NOT EXISTS "evidence_review_workflows_escalation_level_status_idx"
  ON "evidence_review_workflows" ("escalation_level", "status");
