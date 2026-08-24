-- PHASE B CLOSURE (2026-08-24) — the historical incident SLA authority.
--
-- Purely ADDITIVE. Two new tables, their indexes and their foreign keys. No
-- existing table gains, loses or changes a column; no existing row is read,
-- rewritten or deleted; destructiveStatements is empty.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Incident SLA posture was DERIVED per read from `workspace_governance_policy`,
-- which is one mutable row per workspace. That was measured against a live
-- database and found to be wrong in both directions:
--
--   tightening 24h -> 4h  flipped an existing OPEN condition from ON_TRACK to
--                         BREACHED and moved its deadline 20 hours into the
--                         past;
--   loosening  4h -> 72h  flipped a REAL breach back to ON_TRACK, erasing it.
--
-- The promise a workspace made about a specific condition is a historical
-- fact. It is now persisted as one.
--
-- WHAT EACH TABLE IS
-- ---------------------------------------------------------------------------
-- `workspace_sla_policy_versions` is IMMUTABLE. A row is identified by a
-- digest of its own hours, so a policy edit either resolves to the existing
-- version carrying those hours or inserts a new one; nothing is ever updated
-- in place. A workspace that toggles a value back and forth therefore reuses
-- versions rather than accumulating indistinguishable ones.
--
-- `operational_incident_sla_cycles` records the promise as it stood when ONE
-- condition qualified: the governing version AND a copy of the resolved
-- targets and deadlines. The copy is deliberate. Reading targets through the
-- version would be correct today and fragile the first time version
-- resolution changed, and the whole point of this migration is that the
-- answer must not depend on anything that can move later.
--
-- `cycle_number` is 1 at first qualification and increments on reopen. The
-- completed cycle is preserved: what happened to an earlier occurrence is a
-- separate fact from what is happening now.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
-- It performs NO BACKFILL. Every incident that exists when this runs has no
-- cycle row, and the projection reports those as UNTRACKED_LEGACY.
--
-- That is the entire point rather than an omission. Backfilling would have to
-- pick a policy that was not in force at the time and stamp it as though it
-- had been — inventing a deadline, and then inventing whether it was missed.
-- On a workspace with an old backlog that manufactures a wave of breaches out
-- of a schema change, which is exactly the false record this authority exists
-- to prevent. A promise nobody recorded cannot be recovered, and saying so is
-- the only truthful option.
--
-- The `policy_version_id`/target columns are NULLABLE for the same reason: a
-- condition qualified in a workspace with no configured policy records a
-- cycle with no targets, which reports NOT_APPLICABLE. That is deliberately
-- distinguishable from having no cycle row at all.
--
-- FOREIGN KEYS
-- ---------------------------------------------------------------------------
-- The cycle cascades from its incident: a deleted condition takes its own SLA
-- history with it, because a cycle for a record that no longer exists cannot
-- be read or acted on.
--
-- The policy version is ON DELETE RESTRICT, deliberately. A version referenced
-- by a cycle is the evidence of what was promised, and allowing it to be
-- deleted — or silently nulled — would destroy the binding this table exists
-- to keep.

-- ---------------------------------------------------------------------------
-- WHY `CREATE TABLE` AND NOT `CREATE TABLE IF NOT EXISTS`
-- ---------------------------------------------------------------------------
-- This repository has already been burned by the latter. A Phase 16 migration
-- used `CREATE TABLE IF NOT EXISTS "discussion_mentions"`; a production
-- database had a table of that name from an earlier bootstrap, so the guard
-- silently skipped the ENTIRE block and every column it declared was never
-- added. The migration reported success over a schema that was wrong, and the
-- damage surfaced much later as missing columns nobody could explain.
--
-- Both tables here are genuinely new. If either already exists, something is
-- true about the target database that this migration does not understand, and
-- stopping loudly is the only safe response. Idempotency is preserved where it
-- can be had honestly: the indexes below are `IF NOT EXISTS` (an index has
-- no shape to disagree about) and every foreign key is added inside a guarded
-- DO block, so re-running after a partial failure is a no-op rather than an
-- error.

-- ---------------------------------------------------------------------------
-- 1. Immutable policy versions
-- ---------------------------------------------------------------------------
CREATE TABLE "workspace_sla_policy_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "assignment_hours" INTEGER NOT NULL,
    "first_review_hours" INTEGER NOT NULL,
    "completion_hours" INTEGER NOT NULL,
    "escalation_hours" INTEGER NOT NULL,
    "due_soon_hours" INTEGER NOT NULL,
    "effective_from_utc" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_sla_policy_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_sla_policy_versions_team_id_digest_key"
    ON "workspace_sla_policy_versions" ("team_id", "digest");

CREATE INDEX IF NOT EXISTS "workspace_sla_policy_versions_team_id_effective_from_utc_idx"
    ON "workspace_sla_policy_versions" ("team_id", "effective_from_utc" DESC);

-- ---------------------------------------------------------------------------
-- 2. Per-incident SLA cycles
-- ---------------------------------------------------------------------------
CREATE TABLE "operational_incident_sla_cycles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "cycle_number" INTEGER NOT NULL,
    "policy_version_id" UUID,
    "policy_digest" VARCHAR(64),
    "severity_at_start" VARCHAR(16) NOT NULL,
    "started_at_utc" TIMESTAMPTZ(6) NOT NULL,
    "acknowledgement_target_hours" INTEGER,
    "resolution_target_hours" INTEGER,
    "due_soon_hours" INTEGER,
    "acknowledgement_due_at_utc" TIMESTAMPTZ(6),
    "resolution_due_at_utc" TIMESTAMPTZ(6),
    "acknowledged_at_utc" TIMESTAMPTZ(6),
    "resolved_at_utc" TIMESTAMPTZ(6),
    "acknowledgement_breached" BOOLEAN NOT NULL DEFAULT false,
    "resolution_breached" BOOLEAN NOT NULL DEFAULT false,
    "ended_at_utc" TIMESTAMPTZ(6),
    "end_reason" VARCHAR(24),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operational_incident_sla_cycles_pkey" PRIMARY KEY ("id")
);

-- One cycle per (incident, cycle number). This is what makes cycle creation
-- idempotent under concurrency: two writers racing to open the same cycle
-- collide here rather than producing two promises for one condition.
CREATE UNIQUE INDEX IF NOT EXISTS "operational_incident_sla_cycles_incident_id_cycle_number_key"
    ON "operational_incident_sla_cycles" ("incident_id", "cycle_number");

CREATE INDEX IF NOT EXISTS "operational_incident_sla_cycles_team_id_ended_at_utc_idx"
    ON "operational_incident_sla_cycles" ("team_id", "ended_at_utc");

CREATE INDEX IF NOT EXISTS "operational_incident_sla_cycles_team_id_ack_due_idx"
    ON "operational_incident_sla_cycles" ("team_id", "acknowledgement_due_at_utc");

CREATE INDEX IF NOT EXISTS "operational_incident_sla_cycles_team_id_res_due_idx"
    ON "operational_incident_sla_cycles" ("team_id", "resolution_due_at_utc");

-- ---------------------------------------------------------------------------
-- 3. Foreign keys, each guarded so a re-run is a no-op
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_sla_policy_versions_team_id_fkey'
    ) THEN
        ALTER TABLE "workspace_sla_policy_versions"
            ADD CONSTRAINT "workspace_sla_policy_versions_team_id_fkey"
            FOREIGN KEY ("team_id") REFERENCES "teams"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'operational_incident_sla_cycles_incident_id_fkey'
    ) THEN
        ALTER TABLE "operational_incident_sla_cycles"
            ADD CONSTRAINT "operational_incident_sla_cycles_incident_id_fkey"
            FOREIGN KEY ("incident_id") REFERENCES "operational_incidents"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'operational_incident_sla_cycles_policy_version_id_fkey'
    ) THEN
        ALTER TABLE "operational_incident_sla_cycles"
            ADD CONSTRAINT "operational_incident_sla_cycles_policy_version_id_fkey"
            FOREIGN KEY ("policy_version_id") REFERENCES "workspace_sla_policy_versions"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;
