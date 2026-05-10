-- Adds CaptureSession + CaptureSessionEvent for durable Capture draft support.
--
-- Forward-only, additive migration:
--   * Two new enums (CaptureSessionStatus, CaptureSessionEventType).
--   * Two new tables (capture_sessions, capture_session_events).
--   * No existing rows are modified, no FKs added to existing tables (the
--     finalized_evidence_id link is held on capture_sessions, not the other way).
--
-- Rollback risk: low. To reverse, drop the two tables (CASCADE) and then drop
-- the two enums. No data depends on these tables.
--
-- Production deploy command:
--   pnpm --filter proovra-api prisma migrate deploy

CREATE TYPE "CaptureSessionStatus" AS ENUM (
  'DRAFT',
  'FINALIZED',
  'DISCARDED',
  'EXPIRED'
);

CREATE TYPE "CaptureSessionEventType" AS ENUM (
  'CREATED',
  'UPDATED',
  'TEMPLATE_CHANGED',
  'ITEMS_UPDATED',
  'RESUMED',
  'FINALIZED',
  'DISCARDED',
  'EXPIRED'
);

CREATE TABLE "capture_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "team_id" UUID,
  "status" "CaptureSessionStatus" NOT NULL DEFAULT 'DRAFT',
  "template_id" VARCHAR(120),
  "template_version" INTEGER,
  "template_name" VARCHAR(180),
  "plan_mode" VARCHAR(40),
  "template_snapshot" JSONB,
  "internal_notes" TEXT,
  "use_location" BOOLEAN NOT NULL DEFAULT FALSE,
  "items_snapshot" JSONB,
  "upload_state_snapshot" JSONB,
  "finalized_evidence_id" UUID,
  "finalized_at_utc" TIMESTAMPTZ(6),
  "discarded_at_utc" TIMESTAMPTZ(6),
  "expires_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "capture_sessions_finalized_evidence_id_key"
  ON "capture_sessions" ("finalized_evidence_id");
CREATE INDEX "capture_sessions_owner_user_id_status_updated_at_idx"
  ON "capture_sessions" ("owner_user_id", "status", "updated_at" DESC);
CREATE INDEX "capture_sessions_team_id_status_updated_at_idx"
  ON "capture_sessions" ("team_id", "status", "updated_at" DESC);
CREATE INDEX "capture_sessions_status_expires_at_utc_idx"
  ON "capture_sessions" ("status", "expires_at_utc");
CREATE INDEX "capture_sessions_finalized_evidence_id_idx"
  ON "capture_sessions" ("finalized_evidence_id");

CREATE TABLE "capture_session_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "event_type" "CaptureSessionEventType" NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "capture_session_events_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "capture_sessions" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "capture_session_events_session_id_created_at_idx"
  ON "capture_session_events" ("session_id", "created_at" DESC);
CREATE INDEX "capture_session_events_event_type_idx"
  ON "capture_session_events" ("event_type");
