-- Phase 11 — Security hardening platform
--
-- Forward-only additive migration:
--   * Two new tables (file_security_scans, security_events).
--   * Two new enums (FileSecurityScanStatus, SecurityEventSeverity).
--   * No existing rows modified, no existing columns altered.
--
-- Default behavior preserved: MALWARE_SCANNING_ENABLED defaults to
-- false, so no scans are written until an operator opts in. Existing
-- evidence rows remain unchanged.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS security_events;
--   DROP TABLE IF EXISTS file_security_scans;
--   DROP TYPE IF EXISTS "SecurityEventSeverity";
--   DROP TYPE IF EXISTS "FileSecurityScanStatus";

-- 1. Enums ----------------------------------------------------------------

CREATE TYPE "FileSecurityScanStatus" AS ENUM (
  'PENDING',
  'CLEAN',
  'SUSPICIOUS',
  'FAILED',
  'SKIPPED'
);

CREATE TYPE "SecurityEventSeverity" AS ENUM (
  'INFO',
  'WARNING',
  'HIGH'
);

-- 2. file_security_scans ---------------------------------------------------

CREATE TABLE "file_security_scans" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "status" "FileSecurityScanStatus" NOT NULL DEFAULT 'PENDING',
  "scanner" VARCHAR(64),
  "signature_version" VARCHAR(64),
  "findings_summary" VARCHAR(2000),
  "scanned_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "file_security_scans_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "file_security_scans_evidence_created_idx"
  ON "file_security_scans" ("evidence_id", "created_at" DESC);
CREATE INDEX "file_security_scans_team_status_created_idx"
  ON "file_security_scans" ("team_id", "status", "created_at" DESC);
CREATE INDEX "file_security_scans_status_idx"
  ON "file_security_scans" ("status");

-- 3. security_events -------------------------------------------------------

CREATE TABLE "security_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "event_type" VARCHAR(64) NOT NULL,
  "severity" "SecurityEventSeverity" NOT NULL DEFAULT 'INFO',
  "evidence_id" UUID,
  "api_credential_id" UUID,
  "webhook_endpoint_id" UUID,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX "security_events_team_created_idx"
  ON "security_events" ("team_id", "created_at" DESC);
CREATE INDEX "security_events_severity_created_idx"
  ON "security_events" ("severity", "created_at" DESC);
CREATE INDEX "security_events_event_type_created_idx"
  ON "security_events" ("event_type", "created_at" DESC);
CREATE INDEX "security_events_created_idx"
  ON "security_events" ("created_at" DESC);
