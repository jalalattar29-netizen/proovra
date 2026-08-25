-- =============================================================================
-- THE PRODUCTION HYBRID INCIDENT SCHEMA — a TEST FIXTURE, never a migration.
-- =============================================================================
--
-- WHAT THIS REPRODUCES, AND WHY IT IS NOT AN INVENTION
-- ---------------------------------------------------------------------------
-- Production carries BOTH column families on the incident tables: the canonical
-- snake_case columns migrations manage, and a legacy camelCase family named
-- after the Prisma FIELD names. This repository has already diagnosed that exact
-- shape once, on other tables, in
-- 20260620200000_reviewer_ops_naming_drift_repair:
--
--   "Without @map, the Prisma client emits quoted camelCase column names in
--    INSERT/SELECT SQL. Migrations created snake_case columns. In production
--    this produced TWO physical columns per affected field - one that migrations
--    manage, one that the Prisma client actually reads and writes."
--
-- That migration deliberately did not drop the legacy columns, recording that "a
-- separate cleanup migration will drop them after operators confirm". For the
-- incident tables that cleanup was never written, so the hybrid survived every
-- later migration - each of which used IF NOT EXISTS guards and therefore had
-- nothing to object to.
--
-- The legacy column NAMES below are not chosen: they are generated from the
-- deployed data model's field names, which is precisely what a client without
-- @map emits. The TYPES are read from the canonical columns of a fully-migrated
-- database, so the two families are type-identical and every difference the
-- tests observe is about NAMING and BINDING rather than about types.
--
-- WHAT MAKES IT DANGEROUS
-- ---------------------------------------------------------------------------
-- Duplicate columns alone are survivable. What is not survivable is that the
-- live UNIQUE index and the live FOREIGN KEY sit on the LEGACY family:
--
--   * a unique on ("teamId", fingerprint) does NOT deduplicate a write Prisma
--     makes against (team_id, fingerprint), so the writer's entire dedupe
--     contract is enforcing nothing about the columns it actually writes;
--   * a foreign key on "incidentId" constrains nothing about a write to
--     incident_id.
--
-- Reproducing the columns without those bindings would reproduce the appearance
-- of the fault and not the fault.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The legacy column family on operational_incidents.
-- ---------------------------------------------------------------------------
ALTER TABLE "operational_incidents"
  ADD COLUMN IF NOT EXISTS "teamId" UUID,
  ADD COLUMN IF NOT EXISTS "safeSummary" CHARACTER VARYING(400),
  ADD COLUMN IF NOT EXISTS "firstSeenAtUtc" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "lastSeenAtUtc" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "occurrenceCount" INTEGER DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "requestId" CHARACTER VARYING(128),
  ADD COLUMN IF NOT EXISTS "traceId" CHARACTER VARYING(128),
  ADD COLUMN IF NOT EXISTS "relatedEvidenceId" UUID,
  ADD COLUMN IF NOT EXISTS "relatedJobId" CHARACTER VARYING(128),
  ADD COLUMN IF NOT EXISTS "relatedProvider" CHARACTER VARYING(64),
  ADD COLUMN IF NOT EXISTS "openedBySystem" BOOLEAN DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "acknowledgedByUserId" UUID,
  ADD COLUMN IF NOT EXISTS "acknowledgedAtUtc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolvedByUserId" UUID,
  ADD COLUMN IF NOT EXISTS "resolvedAtUtc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "resolutionNote" CHARACTER VARYING(400),
  ADD COLUMN IF NOT EXISTS "assignedOperatorUserId" UUID,
  ADD COLUMN IF NOT EXISTS "assignedByUserId" UUID,
  ADD COLUMN IF NOT EXISTS "assignedAtUtc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "runbookSlug" CHARACTER VARYING(64),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(6) DEFAULT NOW() NOT NULL;

-- The legacy family carries the data too: the un-annotated client wrote through
-- it for as long as it was the model's view of this table.
UPDATE "operational_incidents" SET "teamId" = "team_id" WHERE "teamId" IS NULL;
UPDATE "operational_incidents" SET "safeSummary" = "safe_summary" WHERE "safeSummary" IS NULL;
UPDATE "operational_incidents" SET "firstSeenAtUtc" = "first_seen_at_utc" WHERE "firstSeenAtUtc" IS NULL;
UPDATE "operational_incidents" SET "lastSeenAtUtc" = "last_seen_at_utc" WHERE "lastSeenAtUtc" IS NULL;
UPDATE "operational_incidents" SET "occurrenceCount" = "occurrence_count" WHERE "occurrenceCount" IS NULL;
UPDATE "operational_incidents" SET "requestId" = "request_id" WHERE "requestId" IS NULL;
UPDATE "operational_incidents" SET "traceId" = "trace_id" WHERE "traceId" IS NULL;
UPDATE "operational_incidents" SET "relatedEvidenceId" = "related_evidence_id" WHERE "relatedEvidenceId" IS NULL;
UPDATE "operational_incidents" SET "relatedJobId" = "related_job_id" WHERE "relatedJobId" IS NULL;
UPDATE "operational_incidents" SET "relatedProvider" = "related_provider" WHERE "relatedProvider" IS NULL;
UPDATE "operational_incidents" SET "openedBySystem" = "opened_by_system" WHERE "openedBySystem" IS NULL;
UPDATE "operational_incidents" SET "acknowledgedByUserId" = "acknowledged_by_user_id" WHERE "acknowledgedByUserId" IS NULL;
UPDATE "operational_incidents" SET "acknowledgedAtUtc" = "acknowledged_at_utc" WHERE "acknowledgedAtUtc" IS NULL;
UPDATE "operational_incidents" SET "resolvedByUserId" = "resolved_by_user_id" WHERE "resolvedByUserId" IS NULL;
UPDATE "operational_incidents" SET "resolvedAtUtc" = "resolved_at_utc" WHERE "resolvedAtUtc" IS NULL;
UPDATE "operational_incidents" SET "resolutionNote" = "resolution_note" WHERE "resolutionNote" IS NULL;
UPDATE "operational_incidents" SET "assignedOperatorUserId" = "assigned_operator_user_id" WHERE "assignedOperatorUserId" IS NULL;
UPDATE "operational_incidents" SET "assignedByUserId" = "assigned_by_user_id" WHERE "assignedByUserId" IS NULL;
UPDATE "operational_incidents" SET "assignedAtUtc" = "assigned_at_utc" WHERE "assignedAtUtc" IS NULL;
UPDATE "operational_incidents" SET "runbookSlug" = "runbook_slug" WHERE "runbookSlug" IS NULL;
UPDATE "operational_incidents" SET "createdAt" = "created_at" WHERE "createdAt" IS NULL;
UPDATE "operational_incidents" SET "updatedAt" = "updated_at" WHERE "updatedAt" IS NULL;

-- The NOT NULL columns that carry NO default. This is the shape that turns a
-- cosmetic duplicate into a write-blocking one: an INSERT naming only the
-- canonical columns cannot satisfy a NOT NULL legacy twin with no default, so
-- every such INSERT fails 23502. Applied AFTER the backfill above, exactly as
-- the original CREATE TABLE would have had it from the start.
ALTER TABLE "operational_incidents" ALTER COLUMN "safeSummary" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Move the UNIQUE and the hot indexes onto the LEGACY family.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "operational_incidents_team_fingerprint_uk";
ALTER TABLE "operational_incidents" DROP CONSTRAINT IF EXISTS "operational_incidents_team_id_fingerprint_key";
DROP INDEX IF EXISTS "operational_incidents_team_id_fingerprint_key";
CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_team_fingerprint_key"
  ON "operational_incidents" ("teamId", "fingerprint");
DROP INDEX IF EXISTS "operational_incidents_last_seen_at_idx";
CREATE INDEX IF NOT EXISTS "operational_incidents_lastSeenAtUtc_idx"
  ON "operational_incidents" ("lastSeenAtUtc" DESC);
DROP INDEX IF EXISTS "operational_incidents_assigned_operator_user_id_idx";
CREATE INDEX IF NOT EXISTS "operational_incidents_assignedOperatorUserId_idx"
  ON "operational_incidents" ("assignedOperatorUserId");

-- ---------------------------------------------------------------------------
-- 3. operational_incident_events - the same, plus one HISTORICAL field name the
--    current model no longer has at all (createdAtUtc). Production carries
--    columns that pair with no current field, and a fixture without one would
--    never exercise the UNPAIRED path.
-- ---------------------------------------------------------------------------
ALTER TABLE "operational_incident_events"
  ADD COLUMN IF NOT EXISTS "incidentId" UUID,
  ADD COLUMN IF NOT EXISTS "eventType" CHARACTER VARYING(64),
  ADD COLUMN IF NOT EXISTS "safeMessage" CHARACTER VARYING(400),
  ADD COLUMN IF NOT EXISTS "metadataJson" JSONB,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ(6) DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "createdAtUtc" TIMESTAMPTZ(6);
UPDATE "operational_incident_events" SET "incidentId" = "incident_id" WHERE "incidentId" IS NULL;
UPDATE "operational_incident_events" SET "eventType" = "event_type" WHERE "eventType" IS NULL;
UPDATE "operational_incident_events" SET "safeMessage" = "safe_message" WHERE "safeMessage" IS NULL;
UPDATE "operational_incident_events" SET "metadataJson" = "metadata_json" WHERE "metadataJson" IS NULL;
UPDATE "operational_incident_events" SET "createdAt" = "created_at" WHERE "createdAt" IS NULL;
UPDATE "operational_incident_events" SET "createdAtUtc" = "created_at" WHERE "createdAtUtc" IS NULL;

-- The write-blocking NOT NULLs on the events table, after its backfill.
ALTER TABLE "operational_incident_events" ALTER COLUMN "incidentId" SET NOT NULL;
ALTER TABLE "operational_incident_events" ALTER COLUMN "eventType" SET NOT NULL;
ALTER TABLE "operational_incident_events" ALTER COLUMN "safeMessage" SET NOT NULL;

-- Idempotent: the fixture is applied more than once in a single test run,
-- so the legacy constraint is dropped before it is (re-)created.
ALTER TABLE "operational_incident_events" DROP CONSTRAINT IF EXISTS "operational_incident_events_incident_id_fkey";
ALTER TABLE "operational_incident_events" DROP CONSTRAINT IF EXISTS "operational_incident_events_incidentId_fkey";
ALTER TABLE "operational_incident_events"
  ADD CONSTRAINT "operational_incident_events_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "operational_incidents"("id") ON DELETE CASCADE;
DROP INDEX IF EXISTS "operational_incident_events_incident_created_at_idx";
CREATE INDEX IF NOT EXISTS "operational_incident_events_incidentId_createdAtUtc_idx"
  ON "operational_incident_events" ("incidentId", "createdAtUtc" DESC);

COMMIT;
