-- =============================================================================
-- Phase 26 — Enterprise Identity Governance Platform
-- =============================================================================
-- Adds three first-class tables on top of the Phase 17 identity surface:
--
--   1. sso_connections             — per-team IdP configuration
--   2. scim_provisioning_tokens    — per-team SCIM bearer tokens
--   3. authenticated_sessions      — active session inventory ledger
--
-- Forward-only. Zero DROP / RENAME on existing tables. New columns are
-- not required because all existing identity infrastructure (Phase 17:
-- ExternalIdentityMapping, OrganizationSecurityPolicy, RevokedSession,
-- ApiCredential, AccessReview) is reused as-is.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. sso_connections
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "sso_connections" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "provider"                 "ExternalIdentityProvider" NOT NULL,
  "display_name"             VARCHAR(180) NOT NULL,
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  "issuer_url"               VARCHAR(400),
  "client_id"                VARCHAR(180),
  "client_secret_hash"       VARCHAR(128),
  "client_secret_preview"    VARCHAR(32),
  "saml_metadata_json"       JSONB,
  "allowed_email_domains"    TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "jit_default_role"         VARCHAR(16),
  "notes"                    VARCHAR(2000),
  "created_by_user_id"       UUID         NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_used_at_utc"         TIMESTAMPTZ(6),
  "rotated_at_utc"           TIMESTAMPTZ(6),
  "revoked_at_utc"           TIMESTAMPTZ(6),
  "revoked_by_user_id"       UUID,
  "revoked_reason"           VARCHAR(400),
  CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- One active connection per (team, provider) — enforced at the
-- application layer when status = 'ACTIVE'. The unique index here
-- includes status so a rotated/disabled connection can coexist with
-- a new ACTIVE one for the same provider.
CREATE UNIQUE INDEX IF NOT EXISTS "sso_connections_team_provider_status_uk"
  ON "sso_connections" ("team_id", "provider", "status");

CREATE INDEX IF NOT EXISTS "sso_connections_team_status_idx"
  ON "sso_connections" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "sso_connections_team_provider_idx"
  ON "sso_connections" ("team_id", "provider");
CREATE INDEX IF NOT EXISTS "sso_connections_revoked_idx"
  ON "sso_connections" ("revoked_at_utc");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_connections_team_id_fkey') THEN
    ALTER TABLE "sso_connections"
      ADD CONSTRAINT "sso_connections_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_connections_created_by_user_id_fkey') THEN
    ALTER TABLE "sso_connections"
      ADD CONSTRAINT "sso_connections_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. scim_provisioning_tokens
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "scim_provisioning_tokens" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "name"                     VARCHAR(180) NOT NULL,
  "token_prefix"             VARCHAR(32)  NOT NULL,
  "token_hash"               VARCHAR(128) NOT NULL,
  "scopes"                   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "ip_allowlist"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_by_user_id"       UUID         NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_used_at_utc"         TIMESTAMPTZ(6),
  "expires_at_utc"           TIMESTAMPTZ(6),
  "revoked_at_utc"           TIMESTAMPTZ(6),
  "revoked_by_user_id"       UUID,
  "revoked_reason"           VARCHAR(400),
  CONSTRAINT "scim_provisioning_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_provisioning_tokens_token_hash_uk"
  ON "scim_provisioning_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "scim_provisioning_tokens_team_status_idx"
  ON "scim_provisioning_tokens" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "scim_provisioning_tokens_team_created_idx"
  ON "scim_provisioning_tokens" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "scim_provisioning_tokens_expires_idx"
  ON "scim_provisioning_tokens" ("expires_at_utc");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_provisioning_tokens_team_id_fkey') THEN
    ALTER TABLE "scim_provisioning_tokens"
      ADD CONSTRAINT "scim_provisioning_tokens_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_provisioning_tokens_created_by_user_id_fkey') THEN
    ALTER TABLE "scim_provisioning_tokens"
      ADD CONSTRAINT "scim_provisioning_tokens_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. authenticated_sessions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "authenticated_sessions" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID,
  "user_id"                  UUID         NOT NULL,
  "session_id_hash"          VARCHAR(64)  NOT NULL,
  "sso_connection_id"        UUID,
  "issued_at_utc"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at_utc"           TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "ip_preview"               VARCHAR(64),
  "ua_preview"               VARCHAR(120),
  "device_id_hash"           VARCHAR(64),
  "revoked_at_utc"           TIMESTAMPTZ(6),
  "revoked_by_user_id"       UUID,
  "revoked_reason"           VARCHAR(64),
  CONSTRAINT "authenticated_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "authenticated_sessions_user_session_hash_uk"
  ON "authenticated_sessions" ("user_id", "session_id_hash");

CREATE INDEX IF NOT EXISTS "authenticated_sessions_team_revoked_idx"
  ON "authenticated_sessions" ("team_id", "revoked_at_utc");
CREATE INDEX IF NOT EXISTS "authenticated_sessions_user_expires_idx"
  ON "authenticated_sessions" ("user_id", "expires_at_utc");
CREATE INDEX IF NOT EXISTS "authenticated_sessions_sso_connection_idx"
  ON "authenticated_sessions" ("sso_connection_id");
CREATE INDEX IF NOT EXISTS "authenticated_sessions_expires_idx"
  ON "authenticated_sessions" ("expires_at_utc");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authenticated_sessions_team_id_fkey') THEN
    ALTER TABLE "authenticated_sessions"
      ADD CONSTRAINT "authenticated_sessions_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authenticated_sessions_user_id_fkey') THEN
    ALTER TABLE "authenticated_sessions"
      ADD CONSTRAINT "authenticated_sessions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- Run after apply. Each query must return > 0.
-- -----------------------------------------------------------------------------
--
-- SELECT 'sso_connections'           AS t, COUNT(*) FROM information_schema.tables WHERE table_name = 'sso_connections';
-- SELECT 'scim_provisioning_tokens'  AS t, COUNT(*) FROM information_schema.tables WHERE table_name = 'scim_provisioning_tokens';
-- SELECT 'authenticated_sessions'    AS t, COUNT(*) FROM information_schema.tables WHERE table_name = 'authenticated_sessions';
--
-- SELECT indexname FROM pg_indexes WHERE indexname IN (
--   'sso_connections_team_provider_status_uk',
--   'scim_provisioning_tokens_token_hash_uk',
--   'authenticated_sessions_user_session_hash_uk'
-- );
--
-- SELECT conname FROM pg_constraint WHERE conname LIKE '%sso_connections%'
--   OR conname LIKE '%scim_provisioning_tokens%'
--   OR conname LIKE '%authenticated_sessions%';
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "authenticated_sessions";
-- DROP TABLE IF EXISTS "scim_provisioning_tokens";
-- DROP TABLE IF EXISTS "sso_connections";
-- COMMIT;
