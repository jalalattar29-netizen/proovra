-- PHASE 3A ELITE CLOSURE — Policy Engine + Advanced Video Intelligence.
--
-- Eight new tables (Phase O-Final hygienic):
--
--   redaction_policies              redaction_policy_versions
--   redaction_policy_assignments    redaction_policy_audit
--   video_frames                    video_tracks
--   video_track_detections          video_timeline_events
--
-- Hard rules:
--   * Brand-new tables → plain CREATE TABLE (loud failure on collision).
--   * Every CREATE INDEX wrapped in a DO/information_schema guard.
--   * Cascade deletes: policy → versions / assignments / audit;
--     video track → detections.
--   * No existing tables altered.

BEGIN;

-- =============================================================================
-- 1. redaction_policies
-- =============================================================================
CREATE TABLE "redaction_policies" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"            UUID         NOT NULL,
  "name"               VARCHAR(180) NOT NULL,
  "description"        VARCHAR(600),
  "created_by_user_id" UUID         NOT NULL,
  "archived_at"        TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "redaction_policies_team_name_uniq"
  ON "redaction_policies" ("team_id", "name");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_policies'
                AND column_name='archived_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policies_team_archived_idx" ON "redaction_policies" ("team_id", "archived_at")';
  END IF;
END $$;

-- =============================================================================
-- 2. redaction_policy_versions
-- =============================================================================
CREATE TABLE "redaction_policy_versions" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "policy_id"           UUID         NOT NULL,
  "team_id"             UUID         NOT NULL,
  "version_ordinal"     SMALLINT     NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "rationale"           VARCHAR(600),
  "providers"           JSONB        NOT NULL,
  "kinds"               JSONB        NOT NULL,
  "rule_actions"        JSONB        NOT NULL,
  "custom_rules"        JSONB        NOT NULL,
  "authored_by_user_id" UUID         NOT NULL,
  "approved_by_user_id" UUID,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "submitted_at_utc"    TIMESTAMPTZ(6),
  "approved_at_utc"     TIMESTAMPTZ(6),
  "published_at_utc"    TIMESTAMPTZ(6),
  "superseded_at_utc"   TIMESTAMPTZ(6),
  CONSTRAINT "redaction_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_policy_versions_policy_fk"
    FOREIGN KEY ("policy_id") REFERENCES "redaction_policies" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "redaction_policy_versions_policy_ordinal_uniq"
  ON "redaction_policy_versions" ("policy_id", "version_ordinal");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_policy_versions'
                AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_versions_team_state_idx" ON "redaction_policy_versions" ("team_id", "state")';
  END IF;
END $$;

-- =============================================================================
-- 3. redaction_policy_assignments
-- =============================================================================
CREATE TABLE "redaction_policy_assignments" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"            UUID         NOT NULL,
  "policy_id"          UUID         NOT NULL,
  "policy_version_id"  UUID         NOT NULL,
  "scope"              VARCHAR(20)  NOT NULL,
  "scope_target_id"    UUID,
  "rationale"          VARCHAR(600),
  "assigned_by_user_id" UUID        NOT NULL,
  "assigned_at_utc"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at_utc"     TIMESTAMPTZ(6),
  CONSTRAINT "redaction_policy_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_policy_assignments_policy_fk"
    FOREIGN KEY ("policy_id") REFERENCES "redaction_policies" ("id") ON DELETE CASCADE,
  CONSTRAINT "redaction_policy_assignments_version_fk"
    FOREIGN KEY ("policy_version_id") REFERENCES "redaction_policy_versions" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_policy_assignments'
                AND column_name='scope') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_assignments_scope_idx" ON "redaction_policy_assignments" ("team_id", "scope", "scope_target_id")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_policy_assignments'
                AND column_name='policy_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_assignments_policy_idx" ON "redaction_policy_assignments" ("policy_id")';
  END IF;
END $$;

-- =============================================================================
-- 4. redaction_policy_audit
-- =============================================================================
CREATE TABLE "redaction_policy_audit" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID         NOT NULL,
  "policy_id"         UUID         NOT NULL,
  "policy_version_id" UUID,
  "code"              VARCHAR(60)  NOT NULL,
  "actor_user_id"     UUID,
  "payload"           JSONB,
  "occurred_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_policy_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_policy_audit_policy_fk"
    FOREIGN KEY ("policy_id") REFERENCES "redaction_policies" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_policy_audit'
                AND column_name='policy_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_audit_team_policy_occ_idx" ON "redaction_policy_audit" ("team_id", "policy_id", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_policy_audit_code_idx" ON "redaction_policy_audit" ("code")';
  END IF;
END $$;

-- =============================================================================
-- 5. video_frames
-- =============================================================================
CREATE TABLE "video_frames" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID         NOT NULL,
  "evidence_id"    UUID         NOT NULL,
  "frame_index"    INT          NOT NULL,
  "timestamp_ms"   INT          NOT NULL,
  "extractor"      VARCHAR(40)  NOT NULL,
  "storage_bucket" VARCHAR(180),
  "storage_key"    VARCHAR(400),
  "storage_region" VARCHAR(40),
  "byte_size"      INT,
  "content_type"   VARCHAR(120),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "video_frames_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "video_frames_team_evidence_frame_uniq"
  ON "video_frames" ("team_id", "evidence_id", "frame_index");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='video_frames'
                AND column_name='timestamp_ms') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_frames_team_ts_idx" ON "video_frames" ("team_id", "evidence_id", "timestamp_ms")';
  END IF;
END $$;

-- =============================================================================
-- 6. video_tracks
-- =============================================================================
CREATE TABLE "video_tracks" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "evidence_id"         UUID         NOT NULL,
  "version_id"          UUID,
  "kind"                VARCHAR(40)  NOT NULL,
  "label"               VARCHAR(80),
  "method"              VARCHAR(20)  NOT NULL DEFAULT 'BLUR',
  "start_frame"         INT          NOT NULL,
  "end_frame"           INT          NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'SUGGESTED',
  "confidence_band"     VARCHAR(20)  NOT NULL DEFAULT 'MEDIUM',
  "authored_by_user_id" UUID,
  "decided_by_user_id"  UUID,
  "decided_at_utc"      TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "video_tracks_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='video_tracks'
                AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_tracks_team_evidence_state_idx" ON "video_tracks" ("team_id", "evidence_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_tracks_team_version_idx" ON "video_tracks" ("team_id", "version_id")';
  END IF;
END $$;

-- =============================================================================
-- 7. video_track_detections
-- =============================================================================
CREATE TABLE "video_track_detections" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID         NOT NULL,
  "track_id"       UUID         NOT NULL,
  "frame_id"       UUID         NOT NULL,
  "bbox"           JSONB        NOT NULL,
  "raw_confidence" DOUBLE PRECISION NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "video_track_detections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "video_track_detections_track_fk"
    FOREIGN KEY ("track_id") REFERENCES "video_tracks" ("id") ON DELETE CASCADE,
  CONSTRAINT "video_track_detections_frame_fk"
    FOREIGN KEY ("frame_id") REFERENCES "video_frames" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "video_track_detections_track_frame_uniq"
  ON "video_track_detections" ("track_id", "frame_id");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='video_track_detections'
                AND column_name='track_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_track_detections_team_track_idx" ON "video_track_detections" ("team_id", "track_id")';
  END IF;
END $$;

-- =============================================================================
-- 8. video_timeline_events
-- =============================================================================
CREATE TABLE "video_timeline_events" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID         NOT NULL,
  "evidence_id"    UUID         NOT NULL,
  "version_id"     UUID,
  "track_id"       UUID,
  "layer"          VARCHAR(40)  NOT NULL,
  "label"          VARCHAR(80),
  "code"           VARCHAR(60)  NOT NULL,
  "start_frame"    INT          NOT NULL,
  "end_frame"      INT          NOT NULL,
  "start_ms"       INT          NOT NULL,
  "end_ms"         INT          NOT NULL,
  "payload"        JSONB,
  "actor_user_id"  UUID,
  "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "video_timeline_events_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='video_timeline_events'
                AND column_name='layer') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_timeline_events_team_evidence_occ_idx" ON "video_timeline_events" ("team_id", "evidence_id", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_timeline_events_team_evidence_layer_idx" ON "video_timeline_events" ("team_id", "evidence_id", "layer")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_timeline_events_track_idx" ON "video_timeline_events" ("track_id")';
  END IF;
END $$;

COMMIT;
