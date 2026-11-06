-- =============================================================================
-- 2026-11-04 — REPORT-014: a package seal's byte check, remembered.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table, written only with definitive
-- outcomes (VERIFIED / FAILED / UNBOUND) of the immutable part of the public
-- seal check, keyed by the seal identity. The first anonymous view of a package
-- read and inflated it in every API process after every restart; now one
-- process does it once. Key revocation is never stored (read live). An older
-- image ignores the table. Rollback: drop it (the next view re-reads the bytes).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "package_seal_byte_checks" (
  "identity_sha256" VARCHAR(64) NOT NULL,
  "package_id" UUID NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "checked_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "package_seal_byte_checks_pkey" PRIMARY KEY ("identity_sha256"),
  CONSTRAINT "package_seal_byte_checks_outcome_check" CHECK ("outcome" IN ('VERIFIED', 'FAILED', 'UNBOUND'))
);

CREATE INDEX IF NOT EXISTS "package_seal_byte_checks_package_id_idx" ON "package_seal_byte_checks" ("package_id");