-- EVIDENCE OTS TRUTH COLUMNS (2026-10-12). Additive only: eleven nullable
-- columns and three CHECK constraints. Nothing is renamed, dropped, rewritten
-- or backfilled.
--
-- WHY. A proof whose Bitcoin attestation was read offline (`ots info`,
-- ots_anchor_check = PROOF_STRUCTURE) had the worker's recording time written
-- into ots_anchored_at_utc, and every surface printed it as "OTS anchored at".
-- That time is when PROOVRA recorded the proof. A Bitcoin anchor time exists
-- only when an independent chain check verified the attestation — and that
-- check, its outcome and its evidence had nowhere to live.
--
--   ots_attestation_recorded_at_utc   when PROOVRA recorded the attestation-
--                                     bearing proof (never an anchor time)
--   ots_attestation_block_height      the block height the proof REPORTS
--                                     (read from its bytes; unverified)
--   ots_chain_verification_status     the latest independent chain check:
--                                     NOT_CONFIGURED | UNAVAILABLE |
--                                     INSUFFICIENT_CONFIRMATIONS | FAILED | VERIFIED
--   ots_chain_checked_at_utc          when that check ran
--   ots_chain_verified_at_utc         when it verified (VERIFIED only)
--   ots_chain_block_height/hash/time  the block it verified against
--   ots_chain_confirmations           confirmations when it verified
--   ots_chain_verifier                verifier method and version
--   ots_chain_failure_code            bounded code when the check FAILED
--
-- COMPATIBILITY. ots_anchored_at_utc keeps being written (the completeness
-- marker every reader of the previous release requires), so a rollback of the
-- application leaves a coherent row. The canonical projection
-- (packages/shared/src/ots-truth.ts) reads it as the proof-recorded time for
-- every anchor that is not chain-verified; rows written before this migration
-- need no backfill.
--
-- INVARIANTS (NOT VALID: enforced for every row written or updated from now
-- on; existing rows are not scanned):
--   * ots_anchor_check = 'BITCOIN_VERIFIED' requires the complete chain
--     evidence. The deployed worker had no Bitcoin node, so no production row
--     is expected to hold BITCOIN_VERIFIED. READINESS (run before deploy; the
--     expected result is 0 — a non-zero count must be resolved with the owner
--     first, because an update of such a row would be refused):
--       SELECT count(*) FROM evidence WHERE ots_anchor_check = 'BITCOIN_VERIFIED';
--   * a VERIFIED chain status requires the same evidence;
--   * the status column holds only the bounded vocabulary.
--
-- ROLLBACK. The previous application release never reads or writes these
-- columns and never writes BITCOIN_VERIFIED without a Bitcoin node, so it runs
-- unchanged against the migrated schema. Do not drop the columns on rollback.

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "ots_attestation_recorded_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ots_attestation_block_height" INTEGER,
  ADD COLUMN IF NOT EXISTS "ots_chain_verification_status" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "ots_chain_checked_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ots_chain_verified_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ots_chain_block_height" INTEGER,
  ADD COLUMN IF NOT EXISTS "ots_chain_block_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "ots_chain_block_time_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ots_chain_confirmations" INTEGER,
  ADD COLUMN IF NOT EXISTS "ots_chain_verifier" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "ots_chain_failure_code" VARCHAR(64);

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_ots_chain_status_vocabulary"
  CHECK (
    "ots_chain_verification_status" IS NULL
    OR "ots_chain_verification_status" IN ('NOT_CONFIGURED', 'UNAVAILABLE', 'INSUFFICIENT_CONFIRMATIONS', 'FAILED', 'VERIFIED')
  ) NOT VALID;

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_ots_chain_verified_requires_evidence"
  CHECK (
    "ots_chain_verification_status" IS DISTINCT FROM 'VERIFIED'
    OR (
      "ots_chain_verified_at_utc" IS NOT NULL
      AND "ots_chain_block_height" IS NOT NULL
      AND "ots_chain_block_hash" ~ '^[0-9a-f]{64}$'
      AND "ots_chain_block_time_utc" IS NOT NULL
      AND "ots_chain_confirmations" > 0
      AND "ots_chain_verifier" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_ots_bitcoin_verified_requires_chain_evidence"
  CHECK (
    "ots_anchor_check" IS DISTINCT FROM 'BITCOIN_VERIFIED'
    OR "ots_chain_verification_status" = 'VERIFIED'
  ) NOT VALID;
