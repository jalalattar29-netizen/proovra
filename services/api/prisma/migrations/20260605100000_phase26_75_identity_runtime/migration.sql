-- =============================================================================
-- Phase 26.75 — Enterprise Identity Enforcement + Security Runtime Platform
-- =============================================================================
-- Adds:
--   1. authenticated_sessions: 5 new columns for quarantine + risk
--      recompute tracking.
--   2. trusted_devices: 3 new columns for trust decay + quarantine.
--   3. geo_intelligence_lookups: new table for the bounded geo lookup
--      cache.
--
-- Forward-only. ADD COLUMN statements are nullable / default-bearing
-- so existing rows continue to work unchanged. No DROP / RENAME.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. authenticated_sessions — quarantine + runtime risk recompute
-- -----------------------------------------------------------------------------

ALTER TABLE "authenticated_sessions"
  ADD COLUMN IF NOT EXISTS "quarantined_at_utc"           TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "quarantined_by_user_id"       UUID,
  ADD COLUMN IF NOT EXISTS "quarantine_reason"            VARCHAR(96),
  ADD COLUMN IF NOT EXISTS "quarantine_release_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_risk_recomputed_at_utc"  TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "authenticated_sessions_team_quarantined_idx"
  ON "authenticated_sessions" ("team_id", "quarantined_at_utc");
CREATE INDEX IF NOT EXISTS "authenticated_sessions_team_recomputed_idx"
  ON "authenticated_sessions" ("team_id", "last_risk_recomputed_at_utc");

-- -----------------------------------------------------------------------------
-- 2. trusted_devices — trust decay + quarantine
-- -----------------------------------------------------------------------------

ALTER TABLE "trusted_devices"
  ADD COLUMN IF NOT EXISTS "trust_score_decay"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "decay_reason"          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "quarantined_at_utc"    TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "trusted_devices_team_decay_idx"
  ON "trusted_devices" ("team_id", "trust_score_decay");
CREATE INDEX IF NOT EXISTS "trusted_devices_team_quarantined_idx"
  ON "trusted_devices" ("team_id", "quarantined_at_utc");

-- -----------------------------------------------------------------------------
-- 3. geo_intelligence_lookups — bounded country-code cache
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "geo_intelligence_lookups" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "ip_hash"                  VARCHAR(64)  NOT NULL,
  "country_code"             VARCHAR(8),
  "provider"                 VARCHAR(32)  NOT NULL,
  "hit_count"                INTEGER      NOT NULL DEFAULT 0,
  "resolved_at_utc"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at_utc"           TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "geo_intelligence_lookups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "geo_intelligence_lookups_ip_hash_uk"
  ON "geo_intelligence_lookups" ("ip_hash");

CREATE INDEX IF NOT EXISTS "geo_intelligence_lookups_country_idx"
  ON "geo_intelligence_lookups" ("country_code");
CREATE INDEX IF NOT EXISTS "geo_intelligence_lookups_expires_idx"
  ON "geo_intelligence_lookups" ("expires_at_utc");

-- -----------------------------------------------------------------------------
-- VERIFICATION
-- -----------------------------------------------------------------------------
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'authenticated_sessions'
--     AND column_name IN (
--       'quarantined_at_utc',
--       'quarantined_by_user_id',
--       'quarantine_reason',
--       'quarantine_release_at_utc',
--       'last_risk_recomputed_at_utc'
--     );
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'trusted_devices'
--     AND column_name IN ('trust_score_decay', 'decay_reason', 'quarantined_at_utc');
-- SELECT 'geo_intelligence_lookups' AS t, COUNT(*) FROM information_schema.tables
--   WHERE table_name = 'geo_intelligence_lookups';
-- SELECT indexname FROM pg_indexes WHERE indexname IN (
--   'authenticated_sessions_team_quarantined_idx',
--   'authenticated_sessions_team_recomputed_idx',
--   'trusted_devices_team_decay_idx',
--   'trusted_devices_team_quarantined_idx',
--   'geo_intelligence_lookups_ip_hash_uk'
-- );
--
-- -----------------------------------------------------------------------------
-- ROLLBACK
-- -----------------------------------------------------------------------------
--
-- BEGIN;
-- DROP TABLE IF EXISTS "geo_intelligence_lookups";
-- DROP INDEX IF EXISTS "authenticated_sessions_team_quarantined_idx";
-- DROP INDEX IF EXISTS "authenticated_sessions_team_recomputed_idx";
-- DROP INDEX IF EXISTS "trusted_devices_team_decay_idx";
-- DROP INDEX IF EXISTS "trusted_devices_team_quarantined_idx";
-- ALTER TABLE "trusted_devices"
--   DROP COLUMN IF EXISTS "quarantined_at_utc",
--   DROP COLUMN IF EXISTS "decay_reason",
--   DROP COLUMN IF EXISTS "trust_score_decay";
-- ALTER TABLE "authenticated_sessions"
--   DROP COLUMN IF EXISTS "last_risk_recomputed_at_utc",
--   DROP COLUMN IF EXISTS "quarantine_release_at_utc",
--   DROP COLUMN IF EXISTS "quarantine_reason",
--   DROP COLUMN IF EXISTS "quarantined_by_user_id",
--   DROP COLUMN IF EXISTS "quarantined_at_utc";
-- COMMIT;
