-- CUSTODY: REDACTION AND REVIEW DECISIONS (2026-09-29, ET-CUS-12).
-- Additive only: two enum values.
--
-- Approving, publishing and rendering redacted versions, and review workflow
-- decisions, lived only in unhashed, mutable side tables (redaction_activity,
-- evidence_reviewer_audit_events); the record's custody chain never showed that
-- a redacted rendering was released or how its review ended.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'REDACTION_RECORDED';
ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'REVIEW_DECISION_RECORDED';
