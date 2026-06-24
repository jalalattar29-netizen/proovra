-- EV1: enterprise email verification.
--
-- Creates the email_verification_tokens table (single-use, hashed,
-- expiring tokens) and backfills existing users so the verify gate
-- does not lock anyone out at deploy.
--
-- Safety notes:
--   * The new table is empty; no INSERT cost.
--   * The backfill UPDATE only touches rows where email_verified_at
--     IS NULL. On a fresh install (empty users) it is a no-op. On an
--     existing install it sets every legacy account to "verified" at
--     the migration timestamp — these accounts pre-date this feature
--     and were already trusted by the prior system. New EMAIL
--     registrations land with email_verified_at = NULL and must
--     verify before login is granted.
--   * CREATE INDEX statements use IF NOT EXISTS so re-running on a
--     drifted DB does not fail.

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"     UUID NOT NULL,
    "token_hash"  VARCHAR(64) NOT NULL,
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,
    "used_at"     TIMESTAMPTZ(6),
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'email_verification_tokens_user_id_fkey'
          AND table_name = 'email_verification_tokens'
    ) THEN
        ALTER TABLE "email_verification_tokens"
            ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_id_created_at_idx"
    ON "email_verification_tokens" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "email_verification_tokens_token_hash_idx"
    ON "email_verification_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "email_verification_tokens_expires_at_idx"
    ON "email_verification_tokens" ("expires_at");

-- Backfill: legacy accounts predate this gate. Trust them and avoid
-- a lock-out. New email registrations stay NULL until the user
-- clicks the verification link.
UPDATE "users"
SET    "email_verified_at" = CURRENT_TIMESTAMP
WHERE  "email_verified_at" IS NULL;
