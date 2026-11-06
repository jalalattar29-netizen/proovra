-- =============================================================================
-- 2026-11-04 - PRO-034 (AUTH-28): Google and Apple sign-ins bound to an attempt.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. A new table the API writes and reads;
-- no existing object is touched. Each row is either a nonce the API issued for one
-- sign-in or link attempt (purpose ISSUED, consumed once by the id_token that
-- carries it) or the single use of a nonce-less id_token accepted from an older
-- native build (purpose TOKEN_USE, keyed by the token's hash). Holds hashes only,
-- never a nonce, a token or a cookie value. Rows past expiry are pruned by the API.
--
-- Apply BEFORE the API image (its Prisma client maps the table).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "social_sign_in_nonces" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "nonce_hash" VARCHAR(64) NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "purpose" VARCHAR(16) NOT NULL,
  "binding_hash" VARCHAR(64),
  "created_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at_utc" TIMESTAMPTZ(6),
  CONSTRAINT "social_sign_in_nonces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_sign_in_nonces_provider_check" CHECK ("provider" IN ('GOOGLE', 'APPLE')),
  CONSTRAINT "social_sign_in_nonces_purpose_check" CHECK ("purpose" IN ('ISSUED', 'TOKEN_USE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "social_sign_in_nonces_nonce_hash_key"
  ON "social_sign_in_nonces" ("nonce_hash");

CREATE INDEX IF NOT EXISTS "social_sign_in_nonces_expires_at_utc_idx"
  ON "social_sign_in_nonces" ("expires_at_utc");