-- THREE PRODUCT DECISIONS (owner decisions 2026-10-14). EXPAND ONLY.
--
--   1. FREE includes three complete evidence records. No schema: coverage is
--      the existing per-record earned fact (output_earned_basis =
--      'FREE_ALLOWANCE'), written by finalization and by the bounded backfill
--      (`free-outputs-backfill`). Nothing here rewrites a record.
--   2. One permanent canonical verification identity per record
--      (evidence.verification_ref), never reassigned, plus a truthful
--      withdrawal state for the canonical page.
--   3. Trash -> Retention Archive -> Purge: a RETENTION_ARCHIVED lifecycle
--      value, the storage-derived barrier cache, and the durable archive
--      restore request.
--
-- SAFE BEFORE THE NEW CODE: every column is nullable or carries a constant
-- default (catalogue-only in PostgreSQL 11+, no table rewrite); previous images
-- neither read nor write any of it. The new enum values are added but no row
-- carries them until the new code writes them. ROLLBACK is code-first: the
-- columns, values and table stay.

-- ---------------------------------------------------------------------------
-- 2. Canonical verification identity
-- ---------------------------------------------------------------------------
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "verification_ref" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "verification_ref_issued_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verification_access_state" VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN IF NOT EXISTS "verification_access_changed_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verification_access_changed_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "verification_access_reason" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_verification_ref_key" ON "evidence"("verification_ref");

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_verification_ref_shape_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_verification_ref_shape_check"
  CHECK ("verification_ref" IS NULL OR "verification_ref" ~ '^pvr_[A-Za-z0-9_-]{27}$');

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_verification_access_state_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_verification_access_state_check"
  CHECK ("verification_access_state" IN ('AVAILABLE', 'WITHDRAWN', 'SUSPENDED'));

-- A reference that has been issued is printed in immutable reports: it may
-- never change or be cleared, including on the purge tombstone.
CREATE OR REPLACE FUNCTION "evidence_verification_ref_set_once"() RETURNS trigger AS $fn$
BEGIN
  IF OLD."verification_ref" IS NOT NULL
     AND (NEW."verification_ref" IS NULL OR NEW."verification_ref" <> OLD."verification_ref") THEN
    RAISE EXCEPTION 'evidence.verification_ref is permanent once issued'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "evidence_verification_ref_set_once" ON "evidence";
CREATE TRIGGER "evidence_verification_ref_set_once"
  BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "evidence_verification_ref_set_once"();

-- ---------------------------------------------------------------------------
-- 3. Retention archive
-- ---------------------------------------------------------------------------
ALTER TYPE "EvidenceLifecycleState" ADD VALUE IF NOT EXISTS 'RETENTION_ARCHIVED';

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "retention_archived_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "latest_required_retain_until_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "purge_eligible_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "retention_barrier_state" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "retention_barrier_evaluated_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_retention_barrier_state_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_retention_barrier_state_check"
  CHECK ("retention_barrier_state" IS NULL OR "retention_barrier_state" IN (
    'CLEAR', 'OBJECT_RETENTION', 'APP_RETENTION', 'LEGAL_HOLD', 'EVIDENCE_LOCKED',
    'METADATA_MISSING', 'METADATA_INCONSISTENT', 'STORAGE_UNAVAILABLE'));

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'ARCHIVE_RESTORE_REQUESTED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'ARCHIVE_RESTORE_STARTED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'ARCHIVE_RESTORE_VERIFIED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'ARCHIVE_RESTORE_COMPLETED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'ARCHIVE_RESTORE_FAILED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'VERIFICATION_REFERENCE_ISSUED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'VERIFICATION_ACCESS_WITHDRAWN';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'VERIFICATION_ACCESS_REINSTATED';

CREATE TABLE "evidence_archive_restore_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "requested_by_user_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'REQUESTED',
  "failure_code" VARCHAR(64),
  "verified_objects" JSONB NOT NULL DEFAULT '[]',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "requested_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at_utc" TIMESTAMPTZ(6),
  "lease_until_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "failed_at_utc" TIMESTAMPTZ(6),
  CONSTRAINT "evidence_archive_restore_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_archive_restore_requests_status_check"
    CHECK ("status" IN ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "evidence_archive_restore_requests_failed_has_code_check"
    CHECK ("status" <> 'FAILED' OR "failure_code" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_archive_restore_requests_idempotency_key_key"
  ON "evidence_archive_restore_requests"("idempotency_key");
CREATE INDEX IF NOT EXISTS "evidence_archive_restore_requests_evidence_id_requested_at__idx"
  ON "evidence_archive_restore_requests"("evidence_id", "requested_at_utc");
CREATE INDEX IF NOT EXISTS "evidence_archive_restore_requests_status_requested_at_utc_idx"
  ON "evidence_archive_restore_requests"("status", "requested_at_utc");
-- Concurrent restore clicks deduplicate at the database: one OPEN request per record.
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_archive_restore_requests_one_open_per_evidence"
  ON "evidence_archive_restore_requests"("evidence_id")
  WHERE "status" IN ('REQUESTED', 'RUNNING');

ALTER TABLE "evidence_archive_restore_requests" DROP CONSTRAINT IF EXISTS "evidence_archive_restore_requests_evidence_id_fkey";
ALTER TABLE "evidence_archive_restore_requests"
  ADD CONSTRAINT "evidence_archive_restore_requests_evidence_id_fkey"
  FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
