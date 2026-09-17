-- =============================================================================
-- UC-1 — first-party extension OAuth authorization codes (Authorization Code +
-- PKCE S256).
--
-- EXPAND / SAFE_TO_APPLY_NOW. One new table; nothing existing is altered. The
-- code itself is never stored (only its SHA-256); single-use via used_at_utc,
-- short-lived, bound to the client, the redirect URI and the PKCE challenge.
-- The token endpoint mints an ordinary short-lived AUTH_JWT the canonical
-- requireAuth already accepts, so this is not a second auth system.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "extension_auth_codes" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "code_hash"      VARCHAR(64) NOT NULL,
  "user_id"        UUID NOT NULL,
  "client_id"      VARCHAR(64) NOT NULL,
  "redirect_uri"   VARCHAR(512) NOT NULL,
  "code_challenge" VARCHAR(128) NOT NULL,
  "scope"          VARCHAR(120) NOT NULL DEFAULT 'capture.direct',
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "used_at_utc"    TIMESTAMPTZ(6),
  "created_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "extension_auth_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "extension_auth_codes_code_hash_key"
  ON "extension_auth_codes" ("code_hash");
CREATE INDEX IF NOT EXISTS "extension_auth_codes_expires_at_utc_idx"
  ON "extension_auth_codes" ("expires_at_utc");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'extension_auth_codes_user_id_fkey'
  ) THEN
    ALTER TABLE "extension_auth_codes"
      ADD CONSTRAINT "extension_auth_codes_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
