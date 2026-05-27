-- Phase A0 — Integrity hard-gate.
--
-- Adds:
--   * EvidenceStatus.FAILED_HASH_MISMATCH — terminal state set by the
--     worker (and any future reconciler) when the recomputed SHA-256
--     of the stored bytes does not match `Evidence.fileSha256`.
--   * CustodyEventType.INTEGRITY_REJECTED_HASH_MISMATCH — the
--     hash-linked custody event written immediately before the
--     transition. Payload carries `expectedSha256`, `computedSha256`,
--     `source` and `detectedAtUtc`.
--
-- Both additions are pure ENUM additions and are SAFE per
-- `migration-risk-scan.mjs`. They do not rewrite any existing rows;
-- historic Evidence remains in its current status. Phase A0 part 8
-- ships a read-only diagnostic script that an operator can run to
-- identify pre-existing mismatches without mutating evidence.
--
-- The two ALTER TYPE statements run independently — PostgreSQL allows
-- the new value to be referenced immediately in the same transaction
-- as of v12+.

ALTER TYPE "EvidenceStatus" ADD VALUE IF NOT EXISTS 'FAILED_HASH_MISMATCH';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'INTEGRITY_REJECTED_HASH_MISMATCH';
