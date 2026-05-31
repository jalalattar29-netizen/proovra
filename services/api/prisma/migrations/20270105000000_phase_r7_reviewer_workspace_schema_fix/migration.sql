-- Phase R7 Reviewer-Workspace Schema Fix — HARDENED for partial-state safety.
-- Aligns CodingSchema / CodingField / CodingValue / ReviewerDisagreement /
-- QcSample Prisma models with the actual fields services/api/src/services/
-- reviewer-workspace/*.ts read + write.
--
-- Hardening rules applied:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard
--   * DROP NOT NULL → DO block guarded by pg_tables + information_schema.columns
--
-- All changes are additive. No DROP COLUMN, no destructive rename.

BEGIN;

-- CodingSchema: status / label / category — admin-surface user-facing fields
ALTER TABLE IF EXISTS "coding_schemas"
  ADD COLUMN IF NOT EXISTS "status"   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "label"    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "category" VARCHAR(80);

-- CodingField: options (Json) / helpText / orderIndex
ALTER TABLE IF EXISTS "coding_fields"
  ADD COLUMN IF NOT EXISTS "options"     JSONB,
  ADD COLUMN IF NOT EXISTS "help_text"   VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "order_index" INTEGER NOT NULL DEFAULT 0;

-- CodingValue: authorUserId / rationale — inline-disagree audit trail
ALTER TABLE IF EXISTS "coding_values"
  ADD COLUMN IF NOT EXISTS "author_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "rationale"      VARCHAR(800);

-- ReviewerDisagreement: originalDecisionId / actor IDs + filed_at_utc
ALTER TABLE IF EXISTS "reviewer_disagreements"
  ADD COLUMN IF NOT EXISTS "original_decision_id"     UUID,
  ADD COLUMN IF NOT EXISTS "challenger_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "second_reviewer_user_id"  UUID,
  ADD COLUMN IF NOT EXISTS "supervisor_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "filed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- QcSample: state (SAMPLED → ASSIGNED → COMPLETED) + qcReviewerUserId
ALTER TABLE IF EXISTS "qc_samples"
  ADD COLUMN IF NOT EXISTS "state"               VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "qc_reviewer_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "failure_reason"      VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "rationale"           VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "rendered_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "assigned_at_utc"     TIMESTAMPTZ(6);

-- CodingSchema lifecycle timestamps + createdByUserId audit column
ALTER TABLE IF EXISTS "coding_schemas"
  ADD COLUMN IF NOT EXISTS "published_at"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "archived_at"         TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_by_user_id"  UUID;

-- ReviewerDisagreement challenger rationale
ALTER TABLE IF EXISTS "reviewer_disagreements"
  ADD COLUMN IF NOT EXISTS "challenger_rationale" VARCHAR(800);

-- Relax filed_by_user_id + reason to nullable on reviewer_disagreements
-- (services now write challenger_user_id + challenger_rationale as canonical;
-- projections coalesce).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='reviewer_disagreements')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reviewer_disagreements' AND column_name='filed_by_user_id'
  ) THEN
    EXECUTE 'ALTER TABLE "reviewer_disagreements" ALTER COLUMN "filed_by_user_id" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='reviewer_disagreements')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reviewer_disagreements' AND column_name='reason'
  ) THEN
    EXECUTE 'ALTER TABLE "reviewer_disagreements" ALTER COLUMN "reason" DROP NOT NULL';
  END IF;
END $$;

COMMIT;
