-- PHASE R8.1 — Real MFA Activation
--
-- Creates the canonical MfaFactor + MfaRecoveryCode tables that
-- back the R8.1 cryptographic primitives (TOTP, recovery codes,
-- AES-256-GCM secret storage). See docs/security/R8_1_REAL_MFA.md
-- for the schema rationale + security contract.
--
-- Migration is APPEND-ONLY: no existing tables modified, no existing
-- columns renamed or dropped. The migration is safe to apply
-- against a populated production database — it adds infrastructure
-- without touching any existing row.

-- =============================================================================
-- Enums
-- =============================================================================

CREATE TYPE "MfaFactorStatus" AS ENUM ('ENROLLING', 'ACTIVE', 'REVOKED');
CREATE TYPE "MfaFactorKind" AS ENUM ('TOTP');

-- =============================================================================
-- mfa_factors — per-user enrolled authenticator
-- =============================================================================

CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" "MfaFactorKind" NOT NULL DEFAULT 'TOTP',
    "status" "MfaFactorStatus" NOT NULL DEFAULT 'ENROLLING',
    "label" VARCHAR(60) NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_auth_tag" BYTEA NOT NULL,
    "secret_kek_id" VARCHAR(64) NOT NULL,
    "algorithm" VARCHAR(16) NOT NULL DEFAULT 'SHA1',
    "digits" INTEGER NOT NULL DEFAULT 6,
    "period_seconds" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolled_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(120),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mfa_factors_user_id_status_idx"
    ON "mfa_factors"("user_id", "status");
CREATE INDEX "mfa_factors_status_idx" ON "mfa_factors"("status");

ALTER TABLE "mfa_factors"
    ADD CONSTRAINT "mfa_factors_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- mfa_recovery_codes — bounded single-use recovery codes
-- =============================================================================

CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "code_lookup_hash" VARCHAR(64) NOT NULL,
    "code_verifier" BYTEA NOT NULL,
    "code_verifier_salt" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),
    "used_from_ip" VARCHAR(64),
    "batch_invalidated_at" TIMESTAMPTZ(6),
    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- Deterministic SHA-256 lookup hash. UNIQUE so a stolen lookup
-- hash cannot match more than one row.
CREATE UNIQUE INDEX "mfa_recovery_codes_code_lookup_hash_key"
    ON "mfa_recovery_codes"("code_lookup_hash");
CREATE INDEX "mfa_recovery_codes_user_id_batch_id_idx"
    ON "mfa_recovery_codes"("user_id", "batch_id");
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx"
    ON "mfa_recovery_codes"("user_id", "used_at");

ALTER TABLE "mfa_recovery_codes"
    ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
