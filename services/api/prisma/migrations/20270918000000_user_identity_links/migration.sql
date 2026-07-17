-- Lifecycle Phase 3 (2026-07-17) — linked login methods.
--
-- ADDITIVE ONLY: CREATE TABLE IF NOT EXISTS + guarded index/FK creation +
-- an idempotent, deterministic backfill INSERT ... SELECT. No destructive
-- or legacy-column-mutating statements. Safe to re-run.
--
-- Backfill provenance: (provider, provider_user_id) on users was verified
-- by the provider at every past login (unique composite on users), so the
-- backfill is deterministic trusted data — NOT email-based inference. GUEST
-- rows are skipped (bootstrap state, not a durable login method). EMAIL
-- (password) accounts are represented by users.password_hash, not a link
-- row, so no link is backfilled for them either.

-- ---------------------------------------------------------------------------
-- 1. user_identity_links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user_identity_links" (
  "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                 UUID NOT NULL,
  "provider"                "AuthProvider" NOT NULL,
  "provider_subject_id"     VARCHAR(128) NOT NULL,
  "normalized_email"        VARCHAR(320),
  "provider_email_verified" BOOLEAN NOT NULL DEFAULT FALSE,
  "status"                  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "linked_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at_utc"        TIMESTAMPTZ(6),
  "revoked_at_utc"          TIMESTAMPTZ(6),
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_identity_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_identity_links_provider_provider_subject_id_key"
  ON "user_identity_links" ("provider", "provider_subject_id");

CREATE INDEX IF NOT EXISTS "user_identity_links_user_id_status_idx"
  ON "user_identity_links" ("user_id", "status");

DO $$
BEGIN
  ALTER TABLE "user_identity_links"
    ADD CONSTRAINT "user_identity_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Deterministic backfill — one ACTIVE link per existing OAuth account.
--    Idempotent via ON CONFLICT DO NOTHING on the provider+subject unique.
-- ---------------------------------------------------------------------------
INSERT INTO "user_identity_links"
  ("user_id", "provider", "provider_subject_id", "normalized_email",
   "provider_email_verified", "status", "linked_at_utc")
SELECT
  u."id",
  u."provider",
  u."provider_user_id",
  LOWER(u."email"),
  (u."email_verified_at" IS NOT NULL),
  'ACTIVE',
  u."created_at"
FROM "users" u
WHERE u."provider" IN ('GOOGLE', 'APPLE')
  AND u."provider_user_id" IS NOT NULL
  AND LENGTH(u."provider_user_id") > 0
ON CONFLICT ("provider", "provider_subject_id") DO NOTHING;
