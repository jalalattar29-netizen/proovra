-- PHASE R8.1.3 — Durable MFA pending challenge store + enum.
--
-- Replaces the R8.1.2 in-process JTI deny-list with a durable row
-- so replay protection survives serverless cold starts and multi-
-- region replicas. The signed token (MFA_PENDING_TTL_SECONDS = 5
-- min) continues to carry the JTI in its `sid` claim; the verify
-- endpoint atomically flips `consumed_at` in a single UPDATE.
--
-- Migration is APPEND-ONLY:
--   - New enum  mfa_challenge_purpose
--   - New table mfa_pending_challenges
--   - No existing table modified, renamed, or dropped.
-- Safe to apply against a populated production database.

-- =============================================================================
-- Enum
-- =============================================================================

CREATE TYPE "mfa_challenge_purpose" AS ENUM ('LOGIN', 'STEP_UP');

-- =============================================================================
-- mfa_pending_challenges — durable replay protection for login MFA.
-- =============================================================================

CREATE TABLE "mfa_pending_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jti" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "mfa_challenge_purpose" NOT NULL DEFAULT 'LOGIN',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "mfa_pending_challenges_pkey" PRIMARY KEY ("id")
);

-- The JTI must be globally unique — two challenges may not collide.
CREATE UNIQUE INDEX "mfa_pending_challenges_jti_key"
    ON "mfa_pending_challenges" ("jti");

-- Per-user lookups for status surfaces + opportunistic GC by expiry.
CREATE INDEX "mfa_pending_challenges_user_id_expires_at_idx"
    ON "mfa_pending_challenges" ("user_id", "expires_at");
CREATE INDEX "mfa_pending_challenges_expires_at_idx"
    ON "mfa_pending_challenges" ("expires_at");

-- FK with ON DELETE CASCADE — when a user is hard-deleted, their
-- in-flight pending challenges go with them.
ALTER TABLE "mfa_pending_challenges"
    ADD CONSTRAINT "mfa_pending_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
