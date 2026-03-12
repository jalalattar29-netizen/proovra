-- 1) Add EMAIL to AuthProvider enum (PostgreSQL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'AuthProvider' AND e.enumlabel = 'EMAIL'
  ) THEN
    ALTER TYPE "AuthProvider" ADD VALUE 'EMAIL';
  END IF;
END$$;

-- 2) Add password_hash column to users
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "password_hash" TEXT;

-- 3) Create password_reset_tokens table
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "expires_at" timestamptz(6) NOT NULL,
  "used_at" timestamptz(6),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE
);

-- 4) Indexes
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_created_at_idx"
  ON "password_reset_tokens" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_idx"
  ON "password_reset_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_at_idx"
  ON "password_reset_tokens" ("expires_at");
