-- =============================================================================
-- EVIDENCE INTEGRITY CHECKS (2026-09-30, ET-SM-07). EXPAND.
--
-- Integrity rechecking is a core commitment for EVERY signed record, not a
-- by-product of report generation. Until now the stored bytes were re-hashed
-- only inside the report pipeline, which is commercially gated: a record that
-- never received a report was never re-verified, and storage drift on it was
-- invisible.
--
-- 1. evidence_integrity_checks — append-only history of every recheck: which
--    record, the exact stored object versions that were read, the digest that
--    was computed, when, the outcome (VERIFIED / FAILED / UNAVAILABLE), a
--    bounded failure code, what triggered it, the checker version and a
--    job/run correlation id.
--
-- 2. Six nullable columns on evidence carrying the LATEST state, so the
--    scheduled sweep can page through due records by index and every reader
--    (Public Verify, byte release) can answer "is this currently verified?"
--    without scanning history:
--      integrity_verified_at_utc           last time the bytes matched
--      integrity_checked_at_utc            last attempt, whatever its outcome
--      integrity_check_outcome             that attempt's outcome
--      integrity_check_failure_code        and its bounded failure code
--      integrity_recheck_requested_at_utc  an on-demand recheck is wanted
--      integrity_recheck_claimed_at_utc    lease: one checker per record
--
-- NULL = never checked: the state is UNKNOWN (never presented as verified)
-- until the sweep reaches the record. No backfill.
--
-- Additive only. Plain CREATE TABLE (not IF NOT EXISTS, which would silently
-- skip the whole block over a table of another shape). The indexes on
-- evidence name only columns this migration adds, and are created inside
-- guarded DO blocks all the same.
-- =============================================================================

CREATE TABLE "evidence_integrity_checks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "storage_version_id" VARCHAR(1024),
  "checked_objects" JSONB NOT NULL DEFAULT '[]',
  "expected_digest" VARCHAR(64),
  "checked_digest" VARCHAR(64),
  "checked_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome" VARCHAR(16) NOT NULL,
  "failure_code" VARCHAR(48),
  "trigger" VARCHAR(32) NOT NULL,
  "checker_version" VARCHAR(48) NOT NULL,
  "correlation_id" VARCHAR(128),
  CONSTRAINT "evidence_integrity_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_integrity_checks_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "evidence_integrity_checks_evidence_id_checked_at_utc_idx"
  ON "evidence_integrity_checks" ("evidence_id", "checked_at_utc");

CREATE INDEX "evidence_integrity_checks_team_id_checked_at_utc_idx"
  ON "evidence_integrity_checks" ("team_id", "checked_at_utc");

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_verified_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_checked_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_check_outcome" VARCHAR(16);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_check_failure_code" VARCHAR(48);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_recheck_requested_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_recheck_claimed_at_utc" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'integrity_checked_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_integrity_checked_at_utc_idx" ON "evidence" ("integrity_checked_at_utc")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evidence' AND column_name = 'integrity_recheck_requested_at_utc'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_integrity_recheck_requested_at_utc_idx" ON "evidence" ("integrity_recheck_requested_at_utc")';
  END IF;
END $$;
