-- Phase R7 Redaction Schema Fix
-- Aligns RedactionVersion / RedactionRegion / RedactionDetection /
-- RedactionDecision / RedactionApproval / RedactionDerivative /
-- RedactionPolicyVersion / RedactionPolicyAssignment / RedactionPolicyAudit
-- with the actual fields services/api/src/services/redaction/*.ts read + write.
--
-- Phase 3A / 3A Elite capabilities preserved:
--   * Policy engine (RedactionPolicy + version chain)
--   * Video detection (RedactionDetection unchanged where required)
--   * Approval workflow (RedactionApproval — approverUserId becomes canonical actor)
--   * Versions (RedactionVersion + RedactionPolicyVersion lifecycle timestamps)
--   * Audit trail (RedactionActivity + RedactionPolicyAudit + policyVersion link)
--   * Verification manifests (policy-verification-manifest + redaction-verification-manifest)
--   * Report/package integration (downstream consumers unaffected — additive only)
--
-- All changes are additive; no DROP COLUMN, no destructive rename. The two
-- Prisma field renames (publishedAt → publishedAtUtc on RedactionPolicyVersion,
-- versionId → policyVersionId / revokedAt → revokedAtUtc on
-- RedactionPolicyAssignment) preserve the DB column name via Prisma @map, so
-- no SQL data migration is required for those — Prisma client regen is enough.

BEGIN;

-- ---------------------------------------------------------------------------
-- RedactionVersion: per-version changelog rationale
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_versions"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- ---------------------------------------------------------------------------
-- RedactionRegion: per-region rationale
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_regions"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- ---------------------------------------------------------------------------
-- RedactionDetection: bounded confidence band (LOW/MEDIUM/HIGH)
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_detections"
  ADD COLUMN IF NOT EXISTS "confidence_band" VARCHAR(20);

-- ---------------------------------------------------------------------------
-- RedactionDecision: links back to originating detection (Phase 3A bulk-decision audit)
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "detection_id" UUID;

-- ---------------------------------------------------------------------------
-- RedactionApproval: relax approved_by_user_id to nullable (services use
-- approver_user_id as canonical actor) + default-NOW on approved_at_utc.
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_approvals"
  ALTER COLUMN "approved_by_user_id" DROP NOT NULL;

ALTER TABLE "redaction_approvals"
  ALTER COLUMN "approved_at_utc" SET DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- RedactionDerivative: render-engine tracking + last-error preview for
-- verification manifests.
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "last_error_preview" VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "render_engine"      VARCHAR(80);

-- ---------------------------------------------------------------------------
-- RedactionPolicyVersion: Phase 3A Elite policy version state machine
-- lifecycle timestamps (submitted / approved / superseded). published_at was
-- renamed in Prisma only — DB column preserved, no SQL change required.
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_policy_versions"
  ADD COLUMN IF NOT EXISTS "submitted_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "superseded_at_utc" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- RedactionPolicyAssignment: assigned_at_utc + policy_version FK index.
-- versionId → policyVersionId is a Prisma-side field rename only (DB column
-- "version_id" preserved). revokedAt → revokedAtUtc same — DB column
-- "revoked_at" preserved. The new index supports the policyVersion relation.
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "assigned_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policy_assignments'
       AND column_name='version_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_assignments_version_id_idx" ON "redaction_policy_assignments" ("version_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RedactionPolicyAudit: policy_version_id (links audit to specific version)
-- + occurred_at_utc (explicit event timestamp distinct from row insert time).
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_policy_audits"
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID,
  ADD COLUMN IF NOT EXISTS "occurred_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='redaction_policy_audits'
       AND column_name='policy_version_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_audits_policy_version_id_idx" ON "redaction_policy_audits" ("policy_version_id")';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RedactionDecision: decision_state column (bulk-decision pipeline writes this
-- alongside row state).
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "decision_state" VARCHAR(20);

-- ---------------------------------------------------------------------------
-- RedactionDetection: raw_confidence column (raw provider confidence as
-- returned by detection adapter, distinct from derived `confidence`).
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_detections"
  ADD COLUMN IF NOT EXISTS "raw_confidence" DOUBLE PRECISION;

-- ---------------------------------------------------------------------------
-- RedactionRegion: source_detection_id (audit trail back to detection)
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_regions"
  ADD COLUMN IF NOT EXISTS "source_detection_id" UUID;

-- ---------------------------------------------------------------------------
-- RedactionPolicyAssignment: rationale (service records assignment rationale)
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "rationale" VARCHAR(800);

-- ---------------------------------------------------------------------------
-- RedactionVersion: relax artifact_kind + created_by_user_id to nullable
-- (services use authoredByUserId as canonical actor + version inherits
-- artifactKind from parent project).
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_versions"
  ALTER COLUMN "artifact_kind" DROP NOT NULL;

ALTER TABLE "redaction_versions"
  ALTER COLUMN "created_by_user_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Additional bulk-decision + detection-workspace + region-source fields
-- (second pass after initial typecheck surfaced more service write sites).
-- ---------------------------------------------------------------------------

ALTER TABLE "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "modified_region_geometry" JSONB;

ALTER TABLE "redaction_detections"
  ADD COLUMN IF NOT EXISTS "preview_label" VARCHAR(200);

ALTER TABLE "redaction_regions"
  ADD COLUMN IF NOT EXISTS "source_provider" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

-- Relax constraints that the service no longer satisfies — services flow data
-- without these legacy required fields (Phase 3A canonical actors moved to
-- authoredByUserId / R7 `kind` field). Existing rows remain valid.
ALTER TABLE "redaction_decisions"
  ALTER COLUMN "region_id" DROP NOT NULL;

ALTER TABLE "redaction_detections"
  ALTER COLUMN "detection_kind" DROP NOT NULL,
  ALTER COLUMN "provider" DROP NOT NULL;

COMMIT;
