-- CUSTODY: EVIDENCE OWNERSHIP TRANSFERRED (members audit LIFE-17, 2026-10-26).
-- Additive only: one enum value.
--
-- Removing a workspace member who owned records moves those records to the
-- member chosen to take them over. The owner column changed with no custody
-- event, so a record's chain could not explain why its owner differs from the
-- person who created it. The removal now appends EVIDENCE_OWNERSHIP_TRANSFERRED
-- (from, to, reason) to each moved record's chain, in the removal transaction.
--
-- Its own migration, deliberately: a value added by ALTER TYPE cannot be used
-- in the transaction that adds it.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EVIDENCE_OWNERSHIP_TRANSFERRED';
