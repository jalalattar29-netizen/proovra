-- Phase 2 Drift Repair — Domain 3: Redaction
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- Phase 2 four-stream inventory + synthesis (Stream C: Redaction). Master
-- Drift Matrix rows 27-45 (19 ADDITIVE_SAFE items) + row 47 (redaction
-- workspace activity / 1 ADDITIVE_SAFE item). Row 46 (RedactionPolicyAudit
-- table-name drift between Prisma plural `redaction_policy_audits` and the
-- production singular `redaction_policy_audit`) is REQUIRES_MANUAL_DECISION
-- and deliberately excluded from this migration.
--
-- ============================================================================
-- TABLES REPAIRED (7) — 20 new columns total
-- ============================================================================
--   * redaction_versions          (+4 columns: authored_by_user_id,
--                                              superseded_at_utc,
--                                              submitted_at_utc,
--                                              approved_at_utc)
--   * redaction_detections        (+5 columns: kind, suggested_region_kind,
--                                              suggested_region_geometry,
--                                              suggested_method, decision_state)
--   * redaction_decisions         (+1 column:  version_id)
--   * redaction_approvals         (+2 columns: approver_user_id, decided_at_utc)
--   * redaction_derivatives       (+4 columns: storage_bucket, render_started_at,
--                                              rendered_at_utc, failure_reason)
--   * redaction_activities        (+2 columns: version_id, occurred_at_utc)
--   * redaction_policy_versions   (+1 column:  reviewed_by_user_id)
--
-- ============================================================================
-- HARD RULES (Phase 2 non-negotiables)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP / RENAME / DELETE / TRUNCATE / UPDATE on existing
--   rows. No SET NOT NULL or DROP NOT NULL on pre-existing columns.
-- * IDEMPOTENT. Every column add is `ADD COLUMN IF NOT EXISTS`.
-- * NULLABLE-FIRST. The single NOT-NULL-DEFAULT addition (occurred_at_utc)
--   reflects the Prisma `@default(now())` declaration so the ADD COLUMN
--   itself populates existing rows.
--
-- ============================================================================
-- TABLE 1 — redaction_versions (4 columns)
-- ============================================================================
-- Prisma model: RedactionVersion (authoredByUserId, supersededAtUtc,
--                                 submittedAtUtc, approvedAtUtc).
-- Service callsite: services/api/src/services/redaction/redaction-version.service.ts.
-- All four timestamps + author are nullable: a version starts as a draft
-- without submission/approval/supersession, and the author is optional
-- for system-generated versions.

ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;

ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "superseded_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "submitted_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "approved_at_utc" TIMESTAMPTZ(6);

-- ============================================================================
-- TABLE 2 — redaction_detections (5 columns)
-- ============================================================================
-- Prisma model: RedactionDetection (kind, suggestedRegionKind,
--                                   suggestedRegionGeometry,
--                                   suggestedMethod, decisionState).
-- Service callsite: services/api/src/services/redaction/redaction-detection.service.ts.
-- All five are detection-payload metadata produced by provider adapters
-- (AWS Rekognition / Azure DI / Deepgram). Nullable because legacy
-- detections never carried these fields.

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(40);

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_region_kind" VARCHAR(40);

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_region_geometry" JSONB;

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_method" VARCHAR(40);

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "decision_state" VARCHAR(20);

-- ============================================================================
-- TABLE 3 — redaction_decisions (1 column)
-- ============================================================================
-- Prisma model: RedactionDecision (versionId).
-- Service callsite: services/api/src/services/redaction/redaction-decision.service.ts.
-- Nullable: a decision can predate the version-chain refactor (legacy rows).

ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "version_id" UUID;

-- ============================================================================
-- TABLE 4 — redaction_approvals (2 columns)
-- ============================================================================
-- Prisma model: RedactionApproval (approverUserId, decidedAtUtc).
-- Service callsite: services/api/src/services/redaction/redaction-approval.service.ts.
-- Both nullable: an approval row may be created in PENDING state before a
-- reviewer is assigned or before a decision is rendered.

ALTER TABLE IF EXISTS "redaction_approvals"
  ADD COLUMN IF NOT EXISTS "approver_user_id" UUID;

ALTER TABLE IF EXISTS "redaction_approvals"
  ADD COLUMN IF NOT EXISTS "decided_at_utc" TIMESTAMPTZ(6);

-- ============================================================================
-- TABLE 5 — redaction_derivatives (4 columns)
-- ============================================================================
-- Prisma model: RedactionDerivative (storageBucket, renderStartedAt,
--                                    renderedAtUtc, failureReason).
-- Service callsite: services/api/src/services/redaction/render-engine.service.ts.
-- `storage_bucket` carries the S3 bucket (nullable for legacy single-bucket
-- deployments). The render timestamps + failure_reason are populated by the
-- async render worker — all nullable until the job runs.

ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "storage_bucket" VARCHAR(255);

ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "render_started_at" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "rendered_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "failure_reason" VARCHAR(600);

-- ============================================================================
-- TABLE 6 — redaction_activities (2 columns)
-- ============================================================================
-- Prisma model: RedactionActivity (versionId, occurredAtUtc @default(now())).
-- Service callsite: services/api/src/services/redaction/redaction-activity.service.ts.
-- `version_id` nullable for activities not tied to a specific version
-- (project-level events). `occurred_at_utc` is the canonical event time;
-- Prisma `@default(now())` → NOT NULL DEFAULT NOW() atomically backfills
-- existing rows during the ADD COLUMN.

ALTER TABLE IF EXISTS "redaction_activities"
  ADD COLUMN IF NOT EXISTS "version_id" UUID;

ALTER TABLE IF EXISTS "redaction_activities"
  ADD COLUMN IF NOT EXISTS "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 7 — redaction_policy_versions (1 column)
-- ============================================================================
-- Prisma model: RedactionPolicyVersion (reviewedByUserId).
-- Service callsite: services/api/src/services/redaction/redaction-policy-store.service.ts.
-- Nullable: a policy version starts as unreviewed; reviewer is recorded
-- only after explicit approval.

ALTER TABLE IF EXISTS "redaction_policy_versions"
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" UUID;

-- ============================================================================
-- DEFERRED — RedactionPolicyAudit table-name drift (REQUIRES_MANUAL_DECISION)
-- ============================================================================
-- Prisma model maps to plural `redaction_policy_audits`; production has
-- singular `redaction_policy_audit` from
-- services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video
-- /migration.sql:117. Per Phase 2 non-negotiables a RENAME is forbidden;
-- the resolution (dual-table + dual-writer + migrate, or update Prisma
-- `@@map`) requires an explicit architecture decision and is therefore
-- excluded from this migration batch.
