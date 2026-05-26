-- PHASE R8.1.4 — Lost-factor recovery request + approval ledger.
--
-- An auditable, bounded workflow that lets an org admin reset a
-- user's MFA when they've lost every factor AND every recovery code.
-- The workflow is INTENTIONALLY NOT a bypass: an approved request
-- only forces the user into the enrollment-required state on next
-- login; it never issues a session, never returns a code an admin
-- can use as a factor, and never removes the audit trail.
--
-- Migration is APPEND-ONLY:
--   - New enum mfa_recovery_request_status
--   - New tables mfa_recovery_requests + mfa_recovery_request_approvals
--   - No existing table modified, renamed, or dropped.

-- =============================================================================
-- Enum
-- =============================================================================

CREATE TYPE "mfa_recovery_request_status" AS ENUM (
    'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'COMPLETED'
);

-- =============================================================================
-- mfa_recovery_requests
-- =============================================================================

CREATE TABLE "mfa_recovery_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "status" "mfa_recovery_request_status" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(400) NOT NULL,
    "required_approvals" INTEGER NOT NULL DEFAULT 1,
    "approval_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_reason" VARCHAR(400),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_at_utc" TIMESTAMPTZ(6),
    "rejected_at_utc" TIMESTAMPTZ(6),
    "completed_at_utc" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "mfa_recovery_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mfa_recovery_requests_user_id_status_idx"
    ON "mfa_recovery_requests" ("user_id", "status");
CREATE INDEX "mfa_recovery_requests_team_id_status_idx"
    ON "mfa_recovery_requests" ("team_id", "status");
CREATE INDEX "mfa_recovery_requests_expires_at_idx"
    ON "mfa_recovery_requests" ("expires_at");

ALTER TABLE "mfa_recovery_requests"
    ADD CONSTRAINT "mfa_recovery_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mfa_recovery_requests"
    ADD CONSTRAINT "mfa_recovery_requests_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- mfa_recovery_request_approvals  (append-only approval ledger)
-- =============================================================================

CREATE TABLE "mfa_recovery_request_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mfa_recovery_request_approvals_pkey" PRIMARY KEY ("id")
);

-- One admin may approve a given request at most once.
CREATE UNIQUE INDEX "mfa_recovery_request_approvals_request_id_approver_user_id_key"
    ON "mfa_recovery_request_approvals" ("request_id", "approver_user_id");
CREATE INDEX "mfa_recovery_request_approvals_approver_user_id_idx"
    ON "mfa_recovery_request_approvals" ("approver_user_id");

ALTER TABLE "mfa_recovery_request_approvals"
    ADD CONSTRAINT "mfa_recovery_request_approvals_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "mfa_recovery_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mfa_recovery_request_approvals"
    ADD CONSTRAINT "mfa_recovery_request_approvals_approver_user_id_fkey"
    FOREIGN KEY ("approver_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
