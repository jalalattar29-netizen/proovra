-- PHASE R8.1.5 — Recovery email preflight + status hardening +
-- per-org MFA enforcement fail-mode.
--
-- Migration is APPEND-ONLY for new columns / enum values + a
-- one-time backfill that maps the legacy `PENDING` state to its
-- R8.1.5 renamed equivalent `PENDING_ADMIN_REVIEW`.
--
-- The legacy `PENDING` enum value is RETAINED in the type so old
-- rows survive the rename without a destructive ALTER. The Prisma
-- schema only references the new values; any future row written
-- by the application uses the new values exclusively.

-- =============================================================================
-- Enum additions — new states for the email preflight + self-cancel flow.
-- =============================================================================

ALTER TYPE "mfa_recovery_request_status" ADD VALUE IF NOT EXISTS 'EMAIL_VERIFICATION_PENDING';
ALTER TYPE "mfa_recovery_request_status" ADD VALUE IF NOT EXISTS 'PENDING_ADMIN_REVIEW';
ALTER TYPE "mfa_recovery_request_status" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- =============================================================================
-- mfa_recovery_requests — email preflight columns + cancel timestamp.
-- =============================================================================

ALTER TABLE "mfa_recovery_requests"
    ADD COLUMN IF NOT EXISTS "email_verification_token_hash" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "email_verification_expires_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "email_resend_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "email_resend_blocked_until" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "cancelled_at_utc" TIMESTAMPTZ(6);

-- Default for new rows shifts to EMAIL_VERIFICATION_PENDING. Existing
-- rows are unaffected (DEFAULT only applies to new INSERTs without
-- an explicit value).
ALTER TABLE "mfa_recovery_requests"
    ALTER COLUMN "status" SET DEFAULT 'EMAIL_VERIFICATION_PENDING';

-- One-time backfill: legacy PENDING rows are mapped to
-- PENDING_ADMIN_REVIEW so admins continue to see them. We do NOT
-- back-fill an email verification token — these rows pre-date the
-- preflight contract and are treated as already verified.
UPDATE "mfa_recovery_requests"
    SET "status" = 'PENDING_ADMIN_REVIEW'
    WHERE "status" = 'PENDING';

-- =============================================================================
-- organization_security_policies — per-org MFA fail-mode override.
-- =============================================================================

ALTER TABLE "organization_security_policies"
    ADD COLUMN IF NOT EXISTS "mfa_enforcement_fail_mode" VARCHAR(16);
