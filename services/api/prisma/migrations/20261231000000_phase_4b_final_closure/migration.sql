-- Phase 4B Final Closure — ADDITIVE schema extension.
--
-- Pattern: Phase-O-Final compliant.
-- * BEGIN / COMMIT wrapped.
-- * Plain CREATE TABLE for new tables.
-- * ADD COLUMN IF NOT EXISTS for additive columns.
-- * All CREATE INDEX wrapped in DO/information_schema column-existence guards.
-- * No DROP, no RENAME, no DELETE, no TRUNCATE.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. evidence_exchange_package_builds — new table for package builder jobs
-- ---------------------------------------------------------------------------
CREATE TABLE "evidence_exchange_package_builds" (
  "id"              TEXT         NOT NULL,
  "team_id"         UUID         NOT NULL,
  "package_id"      TEXT         NOT NULL,
  "state"           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "storage_key"     VARCHAR(600),
  "payload_sha256"  VARCHAR(64),
  "size_bytes"      BIGINT,
  "failure_reason"  VARCHAR(600),
  "started_at_utc"  TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_exchange_package_builds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_exchange_package_builds_package_id_key" UNIQUE ("package_id")
);

-- ---------------------------------------------------------------------------
-- 2. archive_tier_transitions — additive columns
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "archive_tier_transitions"
  ADD COLUMN IF NOT EXISTS "state"                 VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "storage_class_before"  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "storage_class_after"   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "executed_at_utc"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "failure_reason"        VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "restore_target_at_utc" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 3. destruction_certificates — additive columns
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS "destruction_certificates"
  ADD COLUMN IF NOT EXISTS "certificate_pdf_uri"       VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "certificate_bytes_sha256"  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "certificate_version"       VARCHAR(60) NOT NULL DEFAULT 'PROOVRA_DESTRUCTION_CERT_V1';

-- ---------------------------------------------------------------------------
-- 4. Indexes — all wrapped in DO/information_schema column-existence guards
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- evidence_exchange_package_builds: (team_id, state)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_exchange_package_builds'
       AND column_name  = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_exchange_package_builds'
       AND column_name  = 'state'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_package_builds_team_state_idx"
               ON "evidence_exchange_package_builds" ("team_id", "state")';
  END IF;

  -- evidence_exchange_package_builds: (team_id, created_at DESC)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_exchange_package_builds'
       AND column_name  = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_exchange_package_builds'
       AND column_name  = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_package_builds_team_created_idx"
               ON "evidence_exchange_package_builds" ("team_id", "created_at" DESC)';
  END IF;

  -- archive_tier_transitions: (team_id, state) — new column guard
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'archive_tier_transitions'
       AND column_name  = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'archive_tier_transitions'
       AND column_name  = 'state'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "archive_tier_transitions_team_state_idx"
               ON "archive_tier_transitions" ("team_id", "state")';
  END IF;
END $$;

COMMIT;
