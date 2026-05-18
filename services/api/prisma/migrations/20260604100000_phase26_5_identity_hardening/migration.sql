-- =============================================================================
-- Phase 26.5 — Enterprise Identity Hardening
-- =============================================================================
-- Adds:
--   1. Additive columns on `sso_connections` for IdP outage tracking.
--   2. Additive columns on `authenticated_sessions` for sampled
--      heartbeat + adaptive auth risk score + country code.
--   3. New table `sso_callback_attempts` (persistent OIDC state +
--      replay protection).
--   4. New table `scim_groups` (RFC 7644 Group resource, role-mapped).
--
-- Forward-only. All ALTER TABLE statements are NULLABLE or
-- DEFAULT-bearing so existing rows continue to work unchanged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. sso_connections — IdP outage tracking
-- -----------------------------------------------------------------------------

ALTER TABLE "sso_connections"
  ADD COLUMN IF NOT EXISTS "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "outage_detected_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "outage_cleared_at_utc"    TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "sso_connections_outage_idx"
  ON "sso_connections" ("outage_detected_at_utc");

-- -----------------------------------------------------------------------------
-- 2. authenticated_sessions — Phase 26.5 columns
-- -----------------------------------------------------------------------------

ALTER TABLE "authenticated_sessions"
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "risk_score"            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "country_code"          VARCHAR(8);

CREATE INDEX IF NOT EXISTS "authenticated_sessions_team_heartbeat_idx"
  ON "authenticated_sessions" ("team_id", "last_heartbeat_at_utc");
CREATE INDEX IF NOT EXISTS "authenticated_sessions_team_risk_idx"
  ON "authenticated_sessions" ("team_id", "risk_score");

-- -----------------------------------------------------------------------------
-- 3. sso_callback_attempts — replay-protection ledger
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "sso_callback_attempts" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "sso_connection_id"        UUID         NOT NULL,
  "state_hash"               VARCHAR(64)  NOT NULL,
  "nonce_hash"               VARCHAR(64)  NOT NULL,
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  "redirect_after"           VARCHAR(400),
  "ip_preview"               VARCHAR(64),
  "ua_preview"               VARCHAR(120),
  "issued_at_utc"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at_utc"           TIMESTAMPTZ(6) NOT NULL,
  "consumed_at_utc"          TIMESTAMPTZ(6),
  "consumed_by_user_id"      UUID,
  "replay_detected_at_utc"   TIMESTAMPTZ(6),
  "failure_reason"           VARCHAR(64),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "sso_callback_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sso_callback_attempts_state_hash_uk"
  ON "sso_callback_attempts" ("state_hash");

CREATE INDEX IF NOT EXISTS "sso_callback_attempts_team_status_idx"
  ON "sso_callback_attempts" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "sso_callback_attempts_conn_status_idx"
  ON "sso_callback_attempts" ("sso_connection_id", "status");
CREATE INDEX IF NOT EXISTS "sso_callback_attempts_expires_idx"
  ON "sso_callback_attempts" ("expires_at_utc");
CREATE INDEX IF NOT EXISTS "sso_callback_attempts_replay_idx"
  ON "sso_callback_attempts" ("replay_detected_at_utc");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_callback_attempts_team_id_fkey') THEN
    ALTER TABLE "sso_callback_attempts"
      ADD CONSTRAINT "sso_callback_attempts_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_callback_attempts_sso_connection_id_fkey') THEN
    ALTER TABLE "sso_callback_attempts"
      ADD CONSTRAINT "sso_callback_attempts_sso_connection_id_fkey"
      FOREIGN KEY ("sso_connection_id") REFERENCES "sso_connections"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. scim_groups — RFC 7644 Group resource
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "scim_groups" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "display_name"             VARCHAR(180) NOT NULL,
  "external_id"              VARCHAR(180),
  "mapped_role"              VARCHAR(24)  NOT NULL,
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"       UUID,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_team_external_id_uk"
  ON "scim_groups" ("team_id", "external_id");
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_team_display_status_uk"
  ON "scim_groups" ("team_id", "display_name", "status");

CREATE INDEX IF NOT EXISTS "scim_groups_team_status_idx"
  ON "scim_groups" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "scim_groups_team_mapped_role_idx"
  ON "scim_groups" ("team_id", "mapped_role");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_groups_team_id_fkey') THEN
    ALTER TABLE "scim_groups"
      ADD CONSTRAINT "scim_groups_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- -----------------------------------------------------------------------------
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sso_connections'
--     AND column_name IN ('consecutive_failure_count','outage_detected_at_utc','outage_cleared_at_utc');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'authenticated_sessions'
--     AND column_name IN ('last_heartbeat_at_utc','risk_score','country_code');
-- SELECT 'sso_callback_attempts' AS t, COUNT(*) FROM information_schema.tables
--   WHERE table_name = 'sso_callback_attempts';
-- SELECT 'scim_groups' AS t, COUNT(*) FROM information_schema.tables
--   WHERE table_name = 'scim_groups';
-- SELECT indexname FROM pg_indexes WHERE indexname IN (
--   'sso_callback_attempts_state_hash_uk',
--   'scim_groups_team_external_id_uk',
--   'sso_connections_outage_idx',
--   'authenticated_sessions_team_heartbeat_idx'
-- );
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "scim_groups";
-- DROP TABLE IF EXISTS "sso_callback_attempts";
-- DROP INDEX IF EXISTS "sso_connections_outage_idx";
-- DROP INDEX IF EXISTS "authenticated_sessions_team_heartbeat_idx";
-- DROP INDEX IF EXISTS "authenticated_sessions_team_risk_idx";
-- ALTER TABLE "authenticated_sessions"
--   DROP COLUMN IF EXISTS "country_code",
--   DROP COLUMN IF EXISTS "risk_score",
--   DROP COLUMN IF EXISTS "last_heartbeat_at_utc";
-- ALTER TABLE "sso_connections"
--   DROP COLUMN IF EXISTS "outage_cleared_at_utc",
--   DROP COLUMN IF EXISTS "outage_detected_at_utc",
--   DROP COLUMN IF EXISTS "consecutive_failure_count";
-- COMMIT;
