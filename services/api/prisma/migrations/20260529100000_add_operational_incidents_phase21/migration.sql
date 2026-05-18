-- Phase 21 — Enterprise Observability, Incident Response & Resilience
--
-- Forward-only additive migration:
--   * 3 new enums (IncidentSeverity, IncidentStatus, IncidentCategory).
--   * 2 new tables (operational_incidents, operational_incident_events).
--   * No existing column altered; no row mutated.
--
-- All operational-incident rows are WORKSPACE-INTERNAL by design.
-- Public verify, OTS, anchor, report-v2, and verification package paths
-- NEVER read these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS operational_incident_events;
--   DROP TABLE IF EXISTS operational_incidents;
--   DROP TYPE  IF EXISTS "IncidentCategory";
--   DROP TYPE  IF EXISTS "IncidentStatus";
--   DROP TYPE  IF EXISTS "IncidentSeverity";

-- 1. Enums ---------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "IncidentSeverity" AS ENUM (
    'INFO', 'WARNING', 'HIGH', 'CRITICAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentStatus" AS ENUM (
    'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentCategory" AS ENUM (
    'UPLOAD',
    'REPORT',
    'PACKAGE',
    'WEBHOOK',
    'COMMUNICATIONS',
    'IDENTITY_SECURITY',
    'GOVERNANCE',
    'STORAGE',
    'AI',
    'INTEGRATION',
    'DATABASE',
    'WORKER',
    'RECONCILIATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. operational_incidents -----------------------------------------------

CREATE TABLE IF NOT EXISTS "operational_incidents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID,
  "category" "IncidentCategory" NOT NULL,
  "severity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
  "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "fingerprint" VARCHAR(200) NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "safe_summary" VARCHAR(400) NOT NULL,
  "first_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "request_id" VARCHAR(128),
  "trace_id" VARCHAR(128),
  "related_evidence_id" UUID,
  "related_job_id" VARCHAR(128),
  "related_provider" VARCHAR(64),
  "opened_by_system" BOOLEAN NOT NULL DEFAULT TRUE,
  "acknowledged_by_user_id" UUID,
  "acknowledged_at_utc" TIMESTAMPTZ(6),
  "resolved_by_user_id" UUID,
  "resolved_at_utc" TIMESTAMPTZ(6),
  "resolution_note" VARCHAR(400),
  "runbook_slug" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "operational_incidents_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL,
  CONSTRAINT "operational_incidents_acknowledged_by_user_id_fkey"
    FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "operational_incidents_resolved_by_user_id_fkey"
    FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

-- Dedup compound: (teamId, fingerprint). When teamId is NULL (system-
-- wide incident) we use a separate fingerprint convention to avoid
-- cross-team collision.
CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_team_fingerprint_uk"
  ON "operational_incidents" ("team_id", "fingerprint");

CREATE INDEX IF NOT EXISTS "operational_incidents_team_status_idx"
  ON "operational_incidents" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "operational_incidents_team_severity_idx"
  ON "operational_incidents" ("team_id", "severity");
CREATE INDEX IF NOT EXISTS "operational_incidents_team_category_idx"
  ON "operational_incidents" ("team_id", "category");
CREATE INDEX IF NOT EXISTS "operational_incidents_last_seen_at_idx"
  ON "operational_incidents" ("last_seen_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_incidents_status_idx"
  ON "operational_incidents" ("status");

-- 3. operational_incident_events -----------------------------------------

CREATE TABLE IF NOT EXISTS "operational_incident_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "incident_id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "safe_message" VARCHAR(400) NOT NULL,
  "metadata_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "operational_incident_events_incident_id_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "operational_incidents"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "operational_incident_events_incident_created_at_idx"
  ON "operational_incident_events" ("incident_id", "created_at" DESC);
