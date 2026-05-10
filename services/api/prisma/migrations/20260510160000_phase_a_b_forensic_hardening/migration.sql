-- Phase A + Phase B forensic / legal hardening migration.
--
-- Purpose: add the new custody event types and the analytics-only
-- last-public-verify-view timestamp introduced by the forensic-hardening
-- pass. All changes are additive; no existing rows are modified, no
-- existing values are renamed or removed.
--
-- Rollback risk: low. To reverse:
--   ALTER TABLE evidence DROP COLUMN last_public_verify_view_at_utc;
--   DROP INDEX evidence_last_public_verify_view_at_utc_idx;
--   -- Cannot DROP enum values once written; in practice they are append-only.
--
-- Production deploy: pnpm --filter proovra-api prisma:migrate
--
-- Notes for the four new enum values:
--   * UPLOAD_AUTHORIZED — truthful replacement for UPLOAD_STARTED at intake.
--   * REPORT_IDENTITY_CONTEXT_RECORDED — distinguishes the worker-time
--     identity snapshot from the intake-time IDENTITY_SNAPSHOT_RECORDED so
--     reviewers do not see two identical-looking events.
--   * OTS_ATTEMPT_ERROR — written when an OTS attempt was made but threw
--     before a status was available (previously swallowed in logs).
--   * STORAGE_PROTECTION_UNAVAILABLE — replaces EVIDENCE_LOCKED when retention
--     was attempted but Object Lock is disabled / did not actually apply.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'UPLOAD_AUTHORIZED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'REPORT_IDENTITY_CONTEXT_RECORDED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'OTS_ATTEMPT_ERROR';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'STORAGE_PROTECTION_UNAVAILABLE';

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "last_public_verify_view_at_utc" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "evidence_last_public_verify_view_at_utc_idx"
  ON "evidence" ("last_public_verify_view_at_utc");
