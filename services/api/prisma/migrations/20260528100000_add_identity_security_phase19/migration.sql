-- Phase 19 — Enterprise Identity Security & Adaptive Access Control
--
-- Forward-only additive migration:
--   * 4 new enums (StepUpChallengeStatus, TrustedDeviceStatus,
--     RevokedSessionScope, RiskSubjectKind).
--   * 4 new tables (step_up_challenges, trusted_devices,
--     revoked_sessions, risk_signals).
--   * 3 additive columns on organization_security_policies
--     (mfa_policy_level, step_up_ttl_seconds, trusted_device_ttl_days).
--   * No existing column altered; no row mutated.
--
-- All identity-security rows are WORKSPACE-INTERNAL by design. Public
-- verify, OTS, anchor, report-v2, and verification package paths
-- NEVER read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS risk_signals;
--   DROP TABLE IF EXISTS revoked_sessions;
--   DROP TABLE IF EXISTS trusted_devices;
--   DROP TABLE IF EXISTS step_up_challenges;
--   ALTER TABLE organization_security_policies
--     DROP COLUMN IF EXISTS trusted_device_ttl_days,
--     DROP COLUMN IF EXISTS step_up_ttl_seconds,
--     DROP COLUMN IF EXISTS mfa_policy_level;
--   DROP TYPE IF EXISTS "RiskSubjectKind";
--   DROP TYPE IF EXISTS "RevokedSessionScope";
--   DROP TYPE IF EXISTS "TrustedDeviceStatus";
--   DROP TYPE IF EXISTS "StepUpChallengeStatus";

-- 1. Enums ---------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "StepUpChallengeStatus" AS ENUM (
    'PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TrustedDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RevokedSessionScope" AS ENUM (
    'SINGLE_SESSION', 'ALL_FOR_USER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RiskSubjectKind" AS ENUM (
    'USER', 'SERVICE_ACCOUNT', 'CONTRIBUTOR_SESSION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. organization_security_policies — additive columns ------------------

ALTER TABLE "organization_security_policies"
  ADD COLUMN IF NOT EXISTS "mfa_policy_level" VARCHAR(32) NOT NULL DEFAULT 'OFF',
  ADD COLUMN IF NOT EXISTS "step_up_ttl_seconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "trusted_device_ttl_days" INTEGER;

-- 3. step_up_challenges --------------------------------------------------

CREATE TABLE IF NOT EXISTS "step_up_challenges" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "initiated_by_user_id" UUID NOT NULL,
  "purpose" VARCHAR(64) NOT NULL,
  "resource_kind" VARCHAR(64),
  "resource_id" VARCHAR(128),
  "status" "StepUpChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "verification_attempt_id" UUID,
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "approved_at_utc" TIMESTAMPTZ(6),
  "reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "step_up_challenges_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "step_up_challenges_initiated_by_user_id_fkey"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "step_up_challenges_team_status_idx"
  ON "step_up_challenges" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "step_up_challenges_user_status_idx"
  ON "step_up_challenges" ("initiated_by_user_id", "status");
CREATE INDEX IF NOT EXISTS "step_up_challenges_expires_at_utc_idx"
  ON "step_up_challenges" ("expires_at_utc");
CREATE INDEX IF NOT EXISTS "step_up_challenges_team_purpose_resource_idx"
  ON "step_up_challenges" ("team_id", "purpose", "resource_id");

-- 4. trusted_devices -----------------------------------------------------

CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "device_id_hash" VARCHAR(64) NOT NULL,
  "ua_preview" VARCHAR(120),
  "ip_preview" VARCHAR(64),
  "ip_hash" VARCHAR(64),
  "status" "TrustedDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "trusted_until_utc" TIMESTAMPTZ(6) NOT NULL,
  "first_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "trusted_devices_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "trusted_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "trusted_devices_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_team_user_device_uk"
  ON "trusted_devices" ("team_id", "user_id", "device_id_hash");
CREATE INDEX IF NOT EXISTS "trusted_devices_team_status_idx"
  ON "trusted_devices" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "trusted_devices_user_status_idx"
  ON "trusted_devices" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "trusted_devices_trusted_until_utc_idx"
  ON "trusted_devices" ("trusted_until_utc");
CREATE INDEX IF NOT EXISTS "trusted_devices_revoked_at_utc_idx"
  ON "trusted_devices" ("revoked_at_utc");

-- 5. revoked_sessions ----------------------------------------------------

CREATE TABLE IF NOT EXISTS "revoked_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "user_id" UUID NOT NULL,
  "scope" "RevokedSessionScope" NOT NULL DEFAULT 'SINGLE_SESSION',
  "session_id_hash" VARCHAR(64),
  "revoked_before_iat" BIGINT,
  "reason" VARCHAR(64) NOT NULL,
  "revoked_by_user_id" UUID,
  "revoked_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "revoked_sessions_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL,
  CONSTRAINT "revoked_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "revoked_sessions_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "revoked_sessions_user_session_uk"
  ON "revoked_sessions" ("user_id", "session_id_hash");
CREATE INDEX IF NOT EXISTS "revoked_sessions_user_scope_idx"
  ON "revoked_sessions" ("user_id", "scope");
CREATE INDEX IF NOT EXISTS "revoked_sessions_team_revoked_at_idx"
  ON "revoked_sessions" ("team_id", "revoked_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "revoked_sessions_revoked_at_utc_idx"
  ON "revoked_sessions" ("revoked_at_utc");

-- 6. risk_signals --------------------------------------------------------

CREATE TABLE IF NOT EXISTS "risk_signals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "subject_kind" "RiskSubjectKind" NOT NULL,
  "subject_user_id" UUID,
  "subject_api_credential_id" UUID,
  "subject_intake_session_id" UUID,
  "signal_kind" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(400) NOT NULL,
  "ip_preview" VARCHAR(64),
  "ua_preview" VARCHAR(120),
  "observed_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "risk_signals_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "risk_signals_subject_user_id_fkey"
    FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "risk_signals_team_observed_at_idx"
  ON "risk_signals" ("team_id", "observed_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "risk_signals_team_signal_kind_idx"
  ON "risk_signals" ("team_id", "signal_kind");
CREATE INDEX IF NOT EXISTS "risk_signals_subject_user_id_idx"
  ON "risk_signals" ("subject_user_id");
CREATE INDEX IF NOT EXISTS "risk_signals_subject_api_credential_id_idx"
  ON "risk_signals" ("subject_api_credential_id");
CREATE INDEX IF NOT EXISTS "risk_signals_subject_intake_session_id_idx"
  ON "risk_signals" ("subject_intake_session_id");
CREATE INDEX IF NOT EXISTS "risk_signals_expires_at_utc_idx"
  ON "risk_signals" ("expires_at_utc");
