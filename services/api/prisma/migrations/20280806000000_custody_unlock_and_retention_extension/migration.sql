-- CUSTODY: UNLOCK AND RETENTION EXTENSION (2026-09-29, ET-CUS-08, ET-CUS-10).
-- Additive only: two enum values.
--
-- Unlocking a record wrote no custody event, so the timeline kept saying
-- "Evidence record locked" after the lock was removed. A policy's retention
-- auto-extension changed retention_until_utc without a custody event.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EVIDENCE_UNLOCKED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'RETENTION_AUTO_EXTENDED';
