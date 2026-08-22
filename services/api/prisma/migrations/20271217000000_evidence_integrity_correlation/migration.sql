-- ATTENTION ARCHITECTURE CLOSURE PASS (2026-08-22) — integrity correlation.
--
-- WHAT THIS IS FOR
-- ----------------
-- The correlation architecture (evidence-integrity-correlation.ts) accepts a
-- POSITIVE correlator and refuses to group on resemblance. Until now nothing
-- produced one, so `deriveParentCorrelation` always returned null.
--
-- This column is the one genuine producer the current pipelines support: a
-- DELIBERATE MULTI-RECORD EXECUTION. When an operator runs a repair or a bulk
-- re-anchor across many records, that run is a single decision with a single
-- identity, and failures inside it really do share a cause.
--
-- WHAT IT IS NOT
-- --------------
-- It is NOT a per-record identifier. Ordinary TSA and OTS work is one BullMQ
-- job per Evidence — `processOtsUpgrade` decodes exactly one `commandId` — so
-- normal production failures are independent and this column stays NULL for
-- them. That is the correct outcome, not a gap: a timestamp taken in the same
-- minute is not a shared cause, and neither is a shared provider, workspace,
-- filename or failure reason.
--
-- NULLABLE ON PURPOSE
-- -------------------
-- A nullable column is preferable to fake certainty. There is deliberately NO
-- BACKFILL: historical failures have no recorded execution, and inventing one
-- from timestamps or reasons would manufacture exactly the grouping the
-- retracted TSA finding was retracted for.
--
-- Purely additive. No table is created, no column changes type, no constraint
-- is added, and no existing row is rewritten.
ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "integrity_correlation_id" VARCHAR(80);

COMMENT ON COLUMN "evidence"."integrity_correlation_id" IS
  'Identity of the deliberate multi-record execution that last touched this record''s integrity proofs. NULL for ordinary per-record work, which is independent by construction. Never derived from failure reason, provider, workspace, filename or time.';

-- A partial index: the column is NULL for almost every row, and the only
-- query that reads it groups the non-null ones.
CREATE INDEX IF NOT EXISTS "evidence_integrity_correlation_id_idx"
  ON "evidence" ("integrity_correlation_id")
  WHERE "integrity_correlation_id" IS NOT NULL;
