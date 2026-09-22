-- =============================================================================
-- BD-2 — batch analysis jobs become durable.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Purely additive: two new tables and two new
-- enums. Nothing existing is dropped, narrowed, renamed or backfilled, and a
-- deployment still running the prior build is unaffected until its code is
-- replaced — the prior build keeps its jobs in process memory and never reads
-- these tables.
--
-- WHY. `batch-analysis.service.ts` stored jobs in a plain object on a module
-- singleton. A restart lost every job, and two API instances could not see
-- each other's, so a job could simply vanish. Both clients reported that
-- honestly because neither could do anything else; the fix belongs here.
--
-- SHAPE. Modelled on `evidence_intelligence_jobs`, which is this repository's
-- existing durable-job shape, rather than inventing a second one. The
-- workspace is ON the job row, so isolation is a query predicate instead of a
-- filter each caller has to remember.
--
-- There is NO backfill, deliberately: the rows being replaced only ever lived
-- in the memory of a process that has since exited. There is nothing to
-- migrate, and inventing rows for jobs nobody can produce evidence of would be
-- worse than starting empty.
-- =============================================================================

CREATE TYPE "BatchAnalysisJobStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "BatchAnalysisItemStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "batch_analysis_jobs" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id"   UUID NOT NULL,
  "team_id"         UUID NOT NULL,
  "name"            VARCHAR(200) NOT NULL,
  "description"     VARCHAR(1000),
  "status"          "BatchAnalysisJobStatus" NOT NULL DEFAULT 'PENDING',
  "total_items"     INTEGER NOT NULL DEFAULT 0,
  "processed_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items"    INTEGER NOT NULL DEFAULT 0,
  "claimed_at_utc"   TIMESTAMPTZ(6),
  "started_at_utc"   TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "batch_analysis_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_analysis_jobs_owner_user_id_created_at_idx"
  ON "batch_analysis_jobs" ("owner_user_id", "created_at" DESC);

CREATE INDEX "batch_analysis_jobs_team_id_status_created_at_idx"
  ON "batch_analysis_jobs" ("team_id", "status", "created_at" DESC);

CREATE TABLE "batch_analysis_job_items" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_id"      UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "position"    INTEGER NOT NULL,
  "status"      "BatchAnalysisItemStatus" NOT NULL DEFAULT 'PENDING',
  -- Operator-readable only. NEVER a provider response or evidence content:
  -- the legacy batch service is metadata-only by design.
  "error"       VARCHAR(400),
  "result_json" JSONB,
  "started_at_utc"   TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),

  CONSTRAINT "batch_analysis_job_items_pkey" PRIMARY KEY ("id")
);

-- One row per position per job: the ordering is part of the record, and a
-- duplicate position would make "item 3 failed" ambiguous.
CREATE UNIQUE INDEX "batch_analysis_job_items_job_id_position_key"
  ON "batch_analysis_job_items" ("job_id", "position");

CREATE INDEX "batch_analysis_job_items_job_id_status_idx"
  ON "batch_analysis_job_items" ("job_id", "status");

-- CASCADE because an item has no meaning without its job, and a job is
-- deleted only by the owner discarding it.
ALTER TABLE "batch_analysis_job_items"
  ADD CONSTRAINT "batch_analysis_job_items_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "batch_analysis_jobs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
