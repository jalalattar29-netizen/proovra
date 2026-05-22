-- =============================================================================
-- Phase 32.8C+++++ — Dashboard Structural Intelligence Closure
-- =============================================================================
-- Adds:
--   1. queue_telemetry_snapshots + QueueTelemetryDomain / QueueTelemetrySource
--      enums (bounded sample of queue depth/backlog)
--   2. worker_telemetry_snapshots + WorkerTelemetryKind / WorkerTelemetryStatus
--      enums (bounded sample of worker heartbeat/status)
--   3. case_evidence_links + CaseEvidenceLinkRole / CaseEvidenceLinkSource
--      enums (many-to-many evidence ↔ case linkage)
--   4. operational_timeline_events + OperationalTimelineFamily /
--      OperationalTimelineConfidence enums (normalized timeline projection)
--   5. case_comments + CaseCommentVisibility enum (case-level coordination)
--   6. evidence_integrity_snapshots TSA issuer parsing columns
--      (tsa_issuer_common_name, tsa_issuer_organization, tsa_policy_oid,
--      tsa_parse_status, tsa_parse_error_code, tsa_parsed_at_utc)
--
-- Forward-only. All CREATE statements use IF NOT EXISTS. All ALTER TABLE
-- statements add nullable columns. CREATE TYPE wrapped in DO $$ IF NOT
-- EXISTS guards for idempotency.
--
-- Risks:
--   * All five new tables are ADVISORY operational data. Writer failures
--     MUST NEVER block evidence/report/package/verify core flows — callers
--     are responsible for wrapping invocations in try/catch.
--   * No data backfill is performed by this migration. case_evidence_links
--     are backfilled lazily by a separate service on first dashboard read
--     (idempotent — backfill never throws).
--   * Cascade rules:
--       - queue_telemetry_snapshots: CASCADE on Team delete (workspace-scoped
--         advisory data follows the workspace).
--       - worker_telemetry_snapshots: NO foreign keys (worker is global).
--       - case_evidence_links: NO foreign keys at DB level — Prisma manages
--         referential integrity. Avoids cycles with existing case/evidence FKs.
--       - operational_timeline_events: NO foreign keys. Projection is
--         append-only and degrades gracefully if source rows vanish.
--       - case_comments: NO foreign keys at DB level — Prisma manages.
--
-- Rollback (operator-side, in psql):
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_parsed_at_utc";
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_parse_error_code";
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_parse_status";
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_policy_oid";
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_issuer_organization";
--   ALTER TABLE "evidence_integrity_snapshots" DROP COLUMN IF EXISTS "tsa_issuer_common_name";
--   DROP TABLE IF EXISTS "case_comments";
--   DROP TYPE  IF EXISTS "CaseCommentVisibility";
--   DROP TABLE IF EXISTS "operational_timeline_events";
--   DROP TYPE  IF EXISTS "OperationalTimelineConfidence";
--   DROP TYPE  IF EXISTS "OperationalTimelineFamily";
--   DROP TABLE IF EXISTS "case_evidence_links";
--   DROP TYPE  IF EXISTS "CaseEvidenceLinkSource";
--   DROP TYPE  IF EXISTS "CaseEvidenceLinkRole";
--   DROP TABLE IF EXISTS "worker_telemetry_snapshots";
--   DROP TYPE  IF EXISTS "WorkerTelemetryStatus";
--   DROP TYPE  IF EXISTS "WorkerTelemetryKind";
--   DROP TABLE IF EXISTS "queue_telemetry_snapshots";
--   DROP TYPE  IF EXISTS "QueueTelemetrySource";
--   DROP TYPE  IF EXISTS "QueueTelemetryDomain";
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. queue_telemetry_snapshots
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QueueTelemetryDomain') THEN
    CREATE TYPE "QueueTelemetryDomain" AS ENUM (
      'REPORT',
      'PACKAGE',
      'REVIEW',
      'GOVERNANCE',
      'INTAKE',
      'WORKER',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QueueTelemetrySource') THEN
    CREATE TYPE "QueueTelemetrySource" AS ENUM (
      'BULLMQ',
      'DB_DERIVED',
      'WORKER_INTERNAL',
      'OTHER'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "queue_telemetry_snapshots" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_id"          UUID,
  "queue_name"       VARCHAR(80)              NOT NULL,
  "queue_domain"     "QueueTelemetryDomain"   NOT NULL,

  "waiting_count"    INTEGER                  NOT NULL DEFAULT 0,
  "active_count"     INTEGER                  NOT NULL DEFAULT 0,
  "delayed_count"    INTEGER                  NOT NULL DEFAULT 0,
  "failed_count"     INTEGER                  NOT NULL DEFAULT 0,
  "completed_count"  INTEGER,
  "retry_count"      INTEGER                  NOT NULL DEFAULT 0,
  "stalled_count"    INTEGER                  NOT NULL DEFAULT 0,

  "oldest_job_age_ms" INTEGER,
  "latest_job_age_ms" INTEGER,

  "sampled_at_utc"   TIMESTAMPTZ(6)           NOT NULL DEFAULT now(),
  "source"           "QueueTelemetrySource"   NOT NULL DEFAULT 'DB_DERIVED',
  "metadata_json"    JSONB,

  "created_at"       TIMESTAMPTZ(6)           NOT NULL DEFAULT now(),

  CONSTRAINT "queue_telemetry_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "queue_telemetry_snapshots_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "queue_telemetry_snapshots_queue_name_sampled_at_utc_idx"
  ON "queue_telemetry_snapshots" ("queue_name", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "queue_telemetry_snapshots_queue_domain_sampled_at_utc_idx"
  ON "queue_telemetry_snapshots" ("queue_domain", "sampled_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "queue_telemetry_snapshots_team_id_sampled_at_utc_idx"
  ON "queue_telemetry_snapshots" ("team_id", "sampled_at_utc" DESC);

-- -----------------------------------------------------------------------------
-- 2. worker_telemetry_snapshots
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkerTelemetryKind') THEN
    CREATE TYPE "WorkerTelemetryKind" AS ENUM (
      'API',
      'WORKER',
      'REPORT',
      'PACKAGE',
      'REVIEWER_RECONCILE',
      'OTS',
      'TSA',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkerTelemetryStatus') THEN
    CREATE TYPE "WorkerTelemetryStatus" AS ENUM (
      'HEALTHY',
      'DEGRADED',
      'CRITICAL',
      'UNKNOWN'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "worker_telemetry_snapshots" (
  "id"                          UUID NOT NULL DEFAULT gen_random_uuid(),
  "worker_id"                   VARCHAR(120)              NOT NULL,
  "worker_kind"                 "WorkerTelemetryKind"     NOT NULL,
  "status"                      "WorkerTelemetryStatus"   NOT NULL DEFAULT 'UNKNOWN',

  "heartbeat_at_utc"            TIMESTAMPTZ(6)            NOT NULL DEFAULT now(),
  "last_successful_run_at_utc"  TIMESTAMPTZ(6),
  "last_failed_run_at_utc"      TIMESTAMPTZ(6),
  "last_error_code"             VARCHAR(80),
  "last_error_message"          VARCHAR(400),

  "processed_count"             INTEGER,
  "failed_count"                INTEGER,
  "duration_ms"                 INTEGER,

  "metadata_json"               JSONB,

  "created_at"                  TIMESTAMPTZ(6)            NOT NULL DEFAULT now(),

  CONSTRAINT "worker_telemetry_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "worker_telemetry_snapshots_worker_kind_heartbeat_at_utc_idx"
  ON "worker_telemetry_snapshots" ("worker_kind", "heartbeat_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "worker_telemetry_snapshots_status_heartbeat_at_utc_idx"
  ON "worker_telemetry_snapshots" ("status", "heartbeat_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "worker_telemetry_snapshots_worker_id_heartbeat_at_utc_idx"
  ON "worker_telemetry_snapshots" ("worker_id", "heartbeat_at_utc" DESC);

-- -----------------------------------------------------------------------------
-- 3. case_evidence_links
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseEvidenceLinkRole') THEN
    CREATE TYPE "CaseEvidenceLinkRole" AS ENUM (
      'PRIMARY',
      'SUPPORTING',
      'RELATED',
      'DUPLICATE',
      'DERIVED',
      'CONTEXT'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseEvidenceLinkSource') THEN
    CREATE TYPE "CaseEvidenceLinkSource" AS ENUM (
      'USER',
      'SYSTEM',
      'IMPORT',
      'INTAKE',
      'WORKFLOW'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "case_evidence_links" (
  "id"                UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID                       NOT NULL,
  "case_id"           UUID                       NOT NULL,
  "evidence_id"       UUID                       NOT NULL,

  "role"              "CaseEvidenceLinkRole"     NOT NULL DEFAULT 'SUPPORTING',
  "source"            "CaseEvidenceLinkSource"   NOT NULL DEFAULT 'USER',

  "linked_by_user_id" UUID,
  "linked_at_utc"     TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "reason"            VARCHAR(400),

  "created_at"        TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),

  CONSTRAINT "case_evidence_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_evidence_links_case_id_evidence_id_role_key"
    UNIQUE ("case_id", "evidence_id", "role")
);

CREATE INDEX IF NOT EXISTS "case_evidence_links_team_id_linked_at_utc_idx"
  ON "case_evidence_links" ("team_id", "linked_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "case_evidence_links_case_id_idx"
  ON "case_evidence_links" ("case_id");
CREATE INDEX IF NOT EXISTS "case_evidence_links_evidence_id_idx"
  ON "case_evidence_links" ("evidence_id");
CREATE INDEX IF NOT EXISTS "case_evidence_links_role_idx"
  ON "case_evidence_links" ("role");

-- -----------------------------------------------------------------------------
-- 4. operational_timeline_events
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalTimelineFamily') THEN
    CREATE TYPE "OperationalTimelineFamily" AS ENUM (
      'EVIDENCE',
      'CASE',
      'CUSTODY',
      'REPORT',
      'PACKAGE',
      'REVIEW',
      'GOVERNANCE',
      'SECURITY',
      'OPS',
      'EXPORT',
      'SYSTEM'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationalTimelineConfidence') THEN
    CREATE TYPE "OperationalTimelineConfidence" AS ENUM (
      'DIRECT',
      'INFERRED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "operational_timeline_events" (
  "id"               UUID                                NOT NULL DEFAULT gen_random_uuid(),
  "team_id"          UUID,
  "case_id"          UUID,
  "evidence_id"      UUID,
  "actor_user_id"    UUID,

  "event_family"     "OperationalTimelineFamily"         NOT NULL,
  "event_type"       VARCHAR(80)                         NOT NULL,
  "severity"         VARCHAR(24)                         NOT NULL,

  "occurred_at_utc"  TIMESTAMPTZ(6)                      NOT NULL,

  "source_table"     VARCHAR(80)                         NOT NULL,
  "source_id"        VARCHAR(80)                         NOT NULL,

  "confidence"       "OperationalTimelineConfidence"     NOT NULL DEFAULT 'DIRECT',
  "safe_to_display"  BOOLEAN                             NOT NULL DEFAULT TRUE,

  "summary"          VARCHAR(400)                        NOT NULL,
  "route"            VARCHAR(400),
  "metadata_json"    JSONB,

  "created_at"       TIMESTAMPTZ(6)                      NOT NULL DEFAULT now(),

  CONSTRAINT "operational_timeline_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_timeline_source_uniq"
    UNIQUE ("source_table", "source_id", "event_type")
);

CREATE INDEX IF NOT EXISTS "operational_timeline_events_team_id_occurred_at_utc_idx"
  ON "operational_timeline_events" ("team_id", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_timeline_events_case_id_occurred_at_utc_idx"
  ON "operational_timeline_events" ("case_id", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_timeline_events_evidence_id_occurred_at_utc_idx"
  ON "operational_timeline_events" ("evidence_id", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_timeline_events_event_family_occurred_at_utc_idx"
  ON "operational_timeline_events" ("event_family", "occurred_at_utc" DESC);
CREATE INDEX IF NOT EXISTS "operational_timeline_events_occurred_at_utc_idx"
  ON "operational_timeline_events" ("occurred_at_utc" DESC);

-- -----------------------------------------------------------------------------
-- 5. case_comments
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaseCommentVisibility') THEN
    CREATE TYPE "CaseCommentVisibility" AS ENUM (
      'INTERNAL',
      'REVIEWERS',
      'ALL_MEMBERS'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "case_comments" (
  "id"                  UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID                       NOT NULL,
  "case_id"             UUID                       NOT NULL,
  "author_user_id"      UUID                       NOT NULL,

  "body"                VARCHAR(4000)              NOT NULL,
  "visibility"          "CaseCommentVisibility"    NOT NULL DEFAULT 'REVIEWERS',

  "resolved_at_utc"     TIMESTAMPTZ(6),
  "resolved_by_user_id" UUID,

  "created_at"          TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),

  CONSTRAINT "case_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "case_comments_team_id_created_at_idx"
  ON "case_comments" ("team_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "case_comments_case_id_created_at_idx"
  ON "case_comments" ("case_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "case_comments_author_user_id_idx"
  ON "case_comments" ("author_user_id");
CREATE INDEX IF NOT EXISTS "case_comments_resolved_at_utc_idx"
  ON "case_comments" ("resolved_at_utc");

-- -----------------------------------------------------------------------------
-- 6. evidence_integrity_snapshots — TSA issuer parsing columns
-- -----------------------------------------------------------------------------

ALTER TABLE "evidence_integrity_snapshots"
  ADD COLUMN IF NOT EXISTS "tsa_issuer_common_name"  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "tsa_issuer_organization" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "tsa_policy_oid"          VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "tsa_parse_status"        VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "tsa_parse_error_code"    VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "tsa_parsed_at_utc"       TIMESTAMPTZ(6);
