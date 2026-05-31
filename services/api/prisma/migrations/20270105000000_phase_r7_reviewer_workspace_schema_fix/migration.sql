-- Phase R7 Reviewer-Workspace Schema Fix
-- Aligns CodingSchema / CodingField / CodingValue / ReviewerDisagreement /
-- QcSample Prisma models with the actual fields services/api/src/services/
-- reviewer-workspace/*.ts read + write.
--
-- Phase 2A reviewer capabilities preserved:
--   * Coding schemas (CodingSchema lifecycle + admin status/label/category)
--   * Coding fields (CodingField options + helpText + orderIndex)
--   * Reviewer queues (reviewer-workspace.service projections unaffected)
--   * QC (QcSample state + qcReviewerUserId for SAMPLED → ASSIGNED → COMPLETED)
--   * Disagreements (originalDecisionId + challenger/secondReviewer/supervisor user trail)
--   * Side-by-side workflow (coding-value rationale supports inline disagree)
--   * Hotkeys / keyboard-first workflow (no schema impact)
--   * Approval workflow (no schema impact — RedactionApproval already fixed in redaction cluster)
--   * Reviewer metrics (filedAtUtc on ReviewerDisagreement preserves time-series ordering)
--   * Annotation workspace integration (no schema impact in this cluster)
--
-- All changes are additive. No DROP COLUMN, no destructive rename, no NOT NULL
-- promotion. All new columns are nullable or have defaults so existing rows survive.

BEGIN;

-- ---------------------------------------------------------------------------
-- CodingSchema: status / label / category — admin-surface user-facing fields
-- ---------------------------------------------------------------------------

ALTER TABLE "coding_schemas"
  ADD COLUMN IF NOT EXISTS "status"   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "label"    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "category" VARCHAR(80);

-- ---------------------------------------------------------------------------
-- CodingField: options (Json) / helpText / orderIndex — Phase 2A coding-field surface
-- ---------------------------------------------------------------------------

ALTER TABLE "coding_fields"
  ADD COLUMN IF NOT EXISTS "options"     JSONB,
  ADD COLUMN IF NOT EXISTS "help_text"   VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "order_index" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- CodingValue: authorUserId / rationale — single-workspace inline-disagree
-- audit trail.
-- ---------------------------------------------------------------------------

ALTER TABLE "coding_values"
  ADD COLUMN IF NOT EXISTS "author_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "rationale"      VARCHAR(800);

-- ---------------------------------------------------------------------------
-- ReviewerDisagreement: originalDecisionId / challenger/secondReviewer/supervisor
-- user IDs + explicit filedAtUtc timestamp.
-- ---------------------------------------------------------------------------

ALTER TABLE "reviewer_disagreements"
  ADD COLUMN IF NOT EXISTS "original_decision_id"     UUID,
  ADD COLUMN IF NOT EXISTS "challenger_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "second_reviewer_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "supervisor_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "filed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- QcSample: state (SAMPLED → ASSIGNED → COMPLETED) + qcReviewerUserId.
-- ---------------------------------------------------------------------------

ALTER TABLE "qc_samples"
  ADD COLUMN IF NOT EXISTS "state"               VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "qc_reviewer_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "failure_reason"      VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "rationale"           VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "rendered_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "assigned_at_utc"     TIMESTAMPTZ(6);

-- CodingSchema lifecycle timestamps + createdByUserId audit column.
ALTER TABLE "coding_schemas"
  ADD COLUMN IF NOT EXISTS "published_at"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "archived_at"         TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_by_user_id"  UUID;

-- ReviewerDisagreement challenger rationale.
ALTER TABLE "reviewer_disagreements"
  ADD COLUMN IF NOT EXISTS "challenger_rationale" VARCHAR(800);

-- Relax filedByUserId + reason to nullable on ReviewerDisagreement.
-- DROP NOT NULL is always safe (never rejects rows). Services now write
-- challengerUserId + challengerRationale as canonical. Projections coalesce
-- filedByUserId ?? challengerUserId and reason ?? challengerRationale, so
-- reports/manifests stay safe (always emit non-null when at least one is set).
ALTER TABLE "reviewer_disagreements"
  ALTER COLUMN "filed_by_user_id" DROP NOT NULL;

ALTER TABLE "reviewer_disagreements"
  ALTER COLUMN "reason" DROP NOT NULL;

COMMIT;
