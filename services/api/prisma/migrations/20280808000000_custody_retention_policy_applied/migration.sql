-- CUSTODY: RETENTION POLICY APPLIED (2026-09-29, ET-CUS-13). Additive only:
-- one enum value.
--
-- Applying a retention policy was recorded as a SECOND EVIDENCE_CREATED event
-- (with a payload tag), so every timeline showed the record being created
-- twice. Existing rows are left as they are (append-only); new applications
-- are recorded under their own type.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'RETENTION_POLICY_APPLIED';
