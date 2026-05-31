-- Phase R7 Redaction Schema Fix — HARDENED for partial-state safety.
-- Aligns RedactionVersion / RedactionRegion / RedactionDetection /
-- RedactionDecision / RedactionApproval / RedactionDerivative /
-- RedactionPolicyVersion / RedactionPolicyAssignment / RedactionPolicyAudit
-- with the actual fields services/api/src/services/redaction/*.ts read + write.
--
-- Hardening rules applied:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard
--   * DROP NOT NULL → DO block guarded by pg_tables + information_schema.columns
--   * SET DEFAULT → DO block guarded by pg_tables + information_schema.columns
--   * CREATE INDEX → existing column-existence guards extended with pg_tables check
--
-- All changes are additive. No DROP COLUMN, no destructive rename.

BEGIN;

-- ---------------------------------------------------------------------------
-- Additive columns
-- ---------------------------------------------------------------------------

-- RedactionVersion: per-version changelog rationale
ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- RedactionRegion: per-region rationale
ALTER TABLE IF EXISTS "redaction_regions"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- RedactionDetection: bounded confidence band (LOW/MEDIUM/HIGH)
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "confidence_band" VARCHAR(20);

-- RedactionDecision: links back to originating detection
ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "detection_id" UUID;

-- RedactionDerivative: render-engine tracking + last-error preview
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "last_error_preview" VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "render_engine"      VARCHAR(80);

-- RedactionPolicyVersion: Phase 3A Elite policy version state machine lifecycle timestamps
ALTER TABLE IF EXISTS "redaction_policy_versions"
  ADD COLUMN IF NOT EXISTS "submitted_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "superseded_at_utc" TIMESTAMPTZ(6);

-- RedactionPolicyAssignment: assigned_at_utc
ALTER TABLE IF EXISTS "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "assigned_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- RedactionPolicyAudit: policy_version_id (audit→version link) + occurred_at_utc
ALTER TABLE IF EXISTS "redaction_policy_audits"
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID,
  ADD COLUMN IF NOT EXISTS "occurred_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- RedactionDecision: decision_state (bulk-decision audit)
ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "decision_state" VARCHAR(20);

-- RedactionDetection: raw_confidence (provider-returned raw confidence)
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "raw_confidence" DOUBLE PRECISION;

-- RedactionRegion: source_detection_id (audit trail back to detection)
ALTER TABLE IF EXISTS "redaction_regions"
  ADD COLUMN IF NOT EXISTS "source_detection_id" UUID;

-- RedactionPolicyAssignment: rationale
ALTER TABLE IF EXISTS "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- Additional bulk-decision + detection-workspace + region-source fields
ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "modified_region_geometry" JSONB;

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "preview_label" VARCHAR(200);

ALTER TABLE IF EXISTS "redaction_regions"
  ADD COLUMN IF NOT EXISTS "source_provider"     VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

-- ---------------------------------------------------------------------------
-- ALTER COLUMN operations (DROP NOT NULL / SET DEFAULT) — each guarded.
-- ---------------------------------------------------------------------------

-- redaction_approvals.approved_by_user_id → nullable; approved_at_utc default NOW()
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_approvals')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_approvals' AND column_name='approved_by_user_id'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_approvals" ALTER COLUMN "approved_by_user_id" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_approvals')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_approvals' AND column_name='approved_at_utc'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_approvals" ALTER COLUMN "approved_at_utc" SET DEFAULT NOW()';
  END IF;
END $$;

-- redaction_versions.artifact_kind + created_by_user_id → nullable
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_versions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_versions' AND column_name='artifact_kind'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_versions" ALTER COLUMN "artifact_kind" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_versions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_versions' AND column_name='created_by_user_id'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_versions" ALTER COLUMN "created_by_user_id" DROP NOT NULL';
  END IF;
END $$;

-- redaction_decisions.region_id → nullable (Phase 3A canonical actors moved)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_decisions')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_decisions' AND column_name='region_id'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_decisions" ALTER COLUMN "region_id" DROP NOT NULL';
  END IF;
END $$;

-- redaction_detections.detection_kind + provider → nullable
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_detections')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_detections' AND column_name='detection_kind'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_detections" ALTER COLUMN "detection_kind" DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_detections')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_detections' AND column_name='provider'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_detections" ALTER COLUMN "provider" DROP NOT NULL';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes — per-index pg_tables + every-column guard.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- redaction_policy_assignments_version_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_policy_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policy_assignments' AND column_name='version_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_assignments_version_id_idx" ON "redaction_policy_assignments" ("version_id")';
  END IF;

  -- redaction_policy_audits_policy_version_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='redaction_policy_audits')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policy_audits' AND column_name='policy_version_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_audits_policy_version_id_idx" ON "redaction_policy_audits" ("policy_version_id")';
  END IF;
END $$;

COMMIT;
