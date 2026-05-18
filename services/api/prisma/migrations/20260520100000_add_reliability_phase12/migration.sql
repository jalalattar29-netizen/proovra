-- Phase 12 — Reliability & large-upload platform
--
-- Forward-only additive migration:
--   * One new table (upload_sessions) — 1:1 mirror of evidence upload
--     lifecycle. Adds nothing to evidence/evidence_part rows.
--   * One new enum (UploadSessionStatus).
--   * No existing rows modified, no existing columns altered.
--
-- The existing EvidenceStatus machine (CREATED → UPLOADING → SIGNED →
-- REPORTED) remains the source of truth for forensic / chain decisions.
-- UploadSession is the operations-facing layer; FAILED / STALLED /
-- ABANDONED states do NOT delete or mutate any evidence row.
--
-- Rollback risk: low. To reverse:
--   DROP TABLE IF EXISTS upload_sessions;
--   DROP TYPE IF EXISTS "UploadSessionStatus";

-- 1. Enum -----------------------------------------------------------------

CREATE TYPE "UploadSessionStatus" AS ENUM (
  'CREATED',
  'PRESIGNED',
  'UPLOADING',
  'PARTIAL',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'STALLED',
  'ABANDONED',
  'REVIEW_REQUIRED'
);

-- 2. upload_sessions ------------------------------------------------------

CREATE TABLE "upload_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL UNIQUE,
  "team_id" UUID,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'CREATED',
  "is_multipart" BOOLEAN NOT NULL DEFAULT FALSE,
  "expected_part_count" INTEGER,
  "completed_part_count" INTEGER NOT NULL DEFAULT 0,
  "multipart_upload_id" VARCHAR(256),
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "failure_reason" VARCHAR(400),
  "last_activity_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "stalled_at_utc" TIMESTAMPTZ(6),
  "abandoned_at_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "upload_sessions_evidence_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "upload_sessions_team_status_idx"
  ON "upload_sessions" ("team_id", "status");
CREATE INDEX "upload_sessions_status_activity_idx"
  ON "upload_sessions" ("status", "last_activity_at_utc");
CREATE INDEX "upload_sessions_status_created_idx"
  ON "upload_sessions" ("status", "created_at" DESC);
