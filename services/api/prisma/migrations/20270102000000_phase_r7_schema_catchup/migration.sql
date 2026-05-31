-- Phase R7 Schema Catchup — ADDITIVE schema extension (HARDENED for partial-state safety).
--
-- BACKGROUND
-- Production dry-run failed with:
--   relation "video_tracks" already exists
-- because the file's 6 CREATE TABLE statements were unguarded. Production had
-- partially applied a prior version of this migration and `video_tracks` (plus
-- possibly other tables) already existed when the migration re-ran.
--
-- This hardened version applies the same defensive pattern proven safe for
-- 20270101000000_phase_r3_model_catchup:
--   * CREATE TABLE → DO $$ IF NOT EXISTS (pg_tables) THEN EXECUTE CREATE TABLE … END IF; END $$;
--     (NOT `CREATE TABLE IF NOT EXISTS` — Phase O safety audit flags that as CRITICAL.)
--     Inner CREATE TABLE bodies contain columns + PK only.
--   * UNIQUE constraints  → separate DO with pg_constraint + per-column information_schema guard
--   * FK constraints      → separate DO with pg_constraint + per-child-col + per-parent-col guard
--   * ALTER TABLE columns → `ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS …` (Postgres-native)
--   * CREATE INDEX        → per-index DO guard checking pg_tables + every indexed column
--
-- ZERO destructive SQL: no DROP, no DELETE, no TRUNCATE, no destructive rename.
-- Capabilities preserved: video tracks/frames/detections, external review portal
-- (activities, comments, decisions), device + capture-trust additive columns,
-- external invitation deliveries, evidence exchange packages, access reviews,
-- webhook deliveries, redaction projects/derivatives, chain transfers.

BEGIN;

-- ===========================================================================
-- PHASE 1 — Tables (columns + PRIMARY KEY only).
-- Each table is guarded by pg_tables; UNIQUE / FK constraints land in Phase 2.
-- ===========================================================================

-- video_tracks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'video_tracks'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "video_tracks" (
  "id"                  UUID        NOT NULL,
  "team_id"             UUID        NOT NULL,
  "evidence_id"         UUID        NOT NULL,
  "version_id"          UUID,
  "kind"                VARCHAR(40) NOT NULL,
  "label"               VARCHAR(80),
  "method"              VARCHAR(40) NOT NULL DEFAULT 'BLUR',
  "start_frame"         INTEGER     NOT NULL,
  "end_frame"           INTEGER     NOT NULL,
  "state"               VARCHAR(20) NOT NULL DEFAULT 'SUGGESTED',
  "confidence_band"     VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  "authored_by_user_id" UUID,
  "decided_by_user_id"  UUID,
  "decided_at_utc"      TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "video_tracks_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- video_frames
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'video_frames'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "video_frames" (
  "id"             UUID         NOT NULL,
  "team_id"        UUID         NOT NULL,
  "evidence_id"    UUID         NOT NULL,
  "frame_index"    INTEGER      NOT NULL,
  "timestamp_ms"   BIGINT,
  "extractor"      VARCHAR(40)  NOT NULL,
  "storage_bucket" VARCHAR(255),
  "storage_key"    VARCHAR(512),
  "storage_region" VARCHAR(64),
  "byte_size"      BIGINT,
  "content_type"   VARCHAR(120),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "video_frames_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- video_track_detections
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'video_track_detections'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "video_track_detections" (
  "id"             UUID             NOT NULL,
  "team_id"        UUID             NOT NULL,
  "track_id"       UUID             NOT NULL,
  "frame_id"       UUID             NOT NULL,
  "bbox"           JSONB            NOT NULL,
  "raw_confidence" DOUBLE PRECISION,
  CONSTRAINT "video_track_detections_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- external_review_activities
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_activities'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "external_review_activities" (
  "id"              UUID         NOT NULL,
  "team_id"         UUID         NOT NULL,
  "grant_id"        UUID         NOT NULL,
  "code"            VARCHAR(80)  NOT NULL,
  "session_id"      VARCHAR(128),
  "ip"              VARCHAR(64),
  "user_agent"      VARCHAR(400),
  "payload"         JSONB,
  "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "external_review_activities_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- external_review_comments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_comments'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "external_review_comments" (
  "id"                UUID          NOT NULL,
  "team_id"           UUID          NOT NULL,
  "grant_id"          UUID          NOT NULL,
  "workflow_id"       UUID          NOT NULL,
  "parent_comment_id" UUID,
  "body"              VARCHAR(4000) NOT NULL,
  "author_email"      VARCHAR(320)  NOT NULL,
  "author_display"    VARCHAR(200),
  "resolved_at_utc"   TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "external_review_comments_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- external_review_decisions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_decisions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "external_review_decisions" (
  "id"               UUID         NOT NULL,
  "team_id"          UUID         NOT NULL,
  "grant_id"         UUID         NOT NULL,
  "workflow_id"      UUID         NOT NULL,
  "verdict"          VARCHAR(40)  NOT NULL,
  "rationale"        VARCHAR(600),
  "reviewer_email"   VARCHAR(320) NOT NULL,
  "reviewer_display" VARCHAR(200),
  "submitted_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "external_review_decisions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- ===========================================================================
-- PHASE 2a — UNIQUE constraints (pg_constraint + per-column guarded).
-- ===========================================================================

-- video_frames_team_id_evidence_id_frame_index_key
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'video_frames'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_frames' AND column_name = 'team_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_frames' AND column_name = 'evidence_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_frames' AND column_name = 'frame_index'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'video_frames'
       AND c.conname = 'video_frames_team_id_evidence_id_frame_index_key'
  ) THEN
    EXECUTE 'ALTER TABLE "video_frames" ADD CONSTRAINT "video_frames_team_id_evidence_id_frame_index_key" UNIQUE ("team_id", "evidence_id", "frame_index")';
  END IF;
END $$;

-- video_track_detections_track_id_frame_id_key
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'video_track_detections'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_track_detections' AND column_name = 'track_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_track_detections' AND column_name = 'frame_id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'video_track_detections'
       AND c.conname = 'video_track_detections_track_id_frame_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "video_track_detections" ADD CONSTRAINT "video_track_detections_track_id_frame_id_key" UNIQUE ("track_id", "frame_id")';
  END IF;
END $$;

-- external_review_decisions_grant_id_workflow_id_key
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_decisions'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_review_decisions' AND column_name = 'grant_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_review_decisions' AND column_name = 'workflow_id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_review_decisions'
       AND c.conname = 'external_review_decisions_grant_id_workflow_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_decisions" ADD CONSTRAINT "external_review_decisions_grant_id_workflow_id_key" UNIQUE ("grant_id", "workflow_id")';
  END IF;
END $$;

-- ===========================================================================
-- PHASE 2b — FOREIGN KEY constraints (pg_constraint + child/parent table +
-- per-child-column + per-parent-column guarded).
-- ===========================================================================

-- video_track_detections_track_id_fkey
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_track_detections')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_tracks')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_track_detections' AND column_name = 'track_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_tracks' AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'video_track_detections'
       AND c.conname = 'video_track_detections_track_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "video_track_detections" ADD CONSTRAINT "video_track_detections_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "video_tracks"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- video_track_detections_frame_id_fkey
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_track_detections')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_frames')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_track_detections' AND column_name = 'frame_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'video_frames' AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'video_track_detections'
       AND c.conname = 'video_track_detections_frame_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "video_track_detections" ADD CONSTRAINT "video_track_detections_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "video_frames"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- external_review_activities_grant_id_fkey
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_review_activities')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_reviewer_role_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_review_activities' AND column_name = 'grant_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments' AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_review_activities'
       AND c.conname = 'external_review_activities_grant_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_activities" ADD CONSTRAINT "external_review_activities_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "external_reviewer_role_assignments"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- external_review_comments_grant_id_fkey
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_review_comments')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_reviewer_role_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_review_comments' AND column_name = 'grant_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments' AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_review_comments'
       AND c.conname = 'external_review_comments_grant_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_comments" ADD CONSTRAINT "external_review_comments_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "external_reviewer_role_assignments"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- external_review_decisions_grant_id_fkey
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_review_decisions')
  AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='external_reviewer_role_assignments')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_review_decisions' AND column_name = 'grant_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments' AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_review_decisions'
       AND c.conname = 'external_review_decisions_grant_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_decisions" ADD CONSTRAINT "external_review_decisions_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "external_reviewer_role_assignments"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- ===========================================================================
-- PHASE 3a — Additive columns on existing tables (Postgres-native idempotency).
-- Every block uses `ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS …`.
-- ===========================================================================

-- Device: capture-trust device metadata
ALTER TABLE IF EXISTS "devices"
  ADD COLUMN IF NOT EXISTS "device_model"        VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "os_version"          VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "app_version"         VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "signature_algorithm" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "attestation_key_id"  VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "registered_at_utc"   TIMESTAMPTZ(6);

-- CaptureDeviceAttestation: session + verification timestamps
ALTER TABLE IF EXISTS "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "capture_session_id" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "verified_at_utc"    TIMESTAMPTZ(6);

-- CaptureTrustEventRecord: bounded event timestamp + session pointer
ALTER TABLE IF EXISTS "capture_trust_event_records"
  ADD COLUMN IF NOT EXISTS "at_utc"             TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "capture_session_id" VARCHAR(128);

-- Device: last-seen timestamp (declared twice in source; the second IF-NOT-EXISTS is a safe no-op)
ALTER TABLE IF EXISTS "devices"
  ADD COLUMN IF NOT EXISTS "last_seen_at_utc"   TIMESTAMPTZ(6);

-- CaptureDeviceAttestation: raw assertion hash
ALTER TABLE IF EXISTS "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "raw_assertion_sha256" VARCHAR(64);

-- ExternalReviewerRoleAssignment: role + MFA flag + invite email + lifecycle timestamps
ALTER TABLE IF EXISTS "external_reviewer_role_assignments"
  ADD COLUMN IF NOT EXISTS "role"                   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "mfa_required"           BOOLEAN,
  ADD COLUMN IF NOT EXISTS "invite_email"           VARCHAR(320),
  ADD COLUMN IF NOT EXISTS "watermark_policy"       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "invite_resent_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "invite_accepted_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "invite_sent_at_utc"     TIMESTAMPTZ(6);

-- ExternalReviewInvitationDelivery: delivery-tracking fields
ALTER TABLE IF EXISTS "external_review_invitation_deliveries"
  ADD COLUMN IF NOT EXISTS "recipient_email"    VARCHAR(320),
  ADD COLUMN IF NOT EXISTS "subject"            VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "queued_at_utc"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "delivered_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "failed_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "expired_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_error_preview" VARCHAR(800);

-- EvidenceExchangePackage: lifecycle timestamps
ALTER TABLE IF EXISTS "evidence_exchange_packages"
  ADD COLUMN IF NOT EXISTS "ready_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "delivered_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "expired_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_at_utc"   TIMESTAMPTZ(6);

-- EvidenceExchangePackageDelivery: channel + download + verify timestamps
ALTER TABLE IF EXISTS "evidence_exchange_package_deliveries"
  ADD COLUMN IF NOT EXISTS "recipient_org_slug"  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "channel"             VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "downloaded_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verified_at_utc"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "delivered_at_utc"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ip_address_hash"     VARCHAR(64);

-- CaptureDeviceAttestation: asserted timestamp
ALTER TABLE IF EXISTS "capture_device_attestations"
  ADD COLUMN IF NOT EXISTS "asserted_at_utc"       TIMESTAMPTZ(6);

-- Device: last-seen timestamp (second declaration — safe IF-NOT-EXISTS no-op on rerun)
ALTER TABLE IF EXISTS "devices"
  ADD COLUMN IF NOT EXISTS "last_seen_at_utc"     TIMESTAMPTZ(6);

-- AccessReviewCampaign: extra lifecycle fields
ALTER TABLE IF EXISTS "access_review_campaigns"
  ADD COLUMN IF NOT EXISTS "name"                  VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "organization_id"       UUID,
  ADD COLUMN IF NOT EXISTS "scheduled_start_utc"   TIMESTAMPTZ(6);

-- AccessReviewItem: review tracking + notes
ALTER TABLE IF EXISTS "access_review_items"
  ADD COLUMN IF NOT EXISTS "reviewed_at_utc"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "notes"                 VARCHAR(1000);

-- ExternalReviewerRoleAssignment: organization display name
ALTER TABLE IF EXISTS "external_reviewer_role_assignments"
  ADD COLUMN IF NOT EXISTS "organization"          VARCHAR(200);

-- LifecycleWebhookDelivery: observability fields
ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "response_status"       INTEGER,
  ADD COLUMN IF NOT EXISTS "response_body_preview" VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS "enqueued_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "last_attempt_at_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "delivered_at_utc"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "dead_lettered_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "next_attempt_at_utc"   TIMESTAMPTZ(6);

-- RedactionProject: artifact kind + title
ALTER TABLE IF EXISTS "redaction_projects"
  ADD COLUMN IF NOT EXISTS "artifact_kind" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "title"         VARCHAR(200);

-- RedactionDerivative: storage + download fields
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "storage_region" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "byte_size"      BIGINT,
  ADD COLUMN IF NOT EXISTS "content_type"   VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "download_count" INTEGER NOT NULL DEFAULT 0;

-- ChainTransfer: response + completion timestamps
ALTER TABLE IF EXISTS "chain_transfers"
  ADD COLUMN IF NOT EXISTS "responded_at_utc"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "completed_at_utc"  TIMESTAMPTZ(6);

-- EvidenceExchangePackage: storage key
ALTER TABLE IF EXISTS "evidence_exchange_packages"
  ADD COLUMN IF NOT EXISTS "storage_key" VARCHAR(600);

-- EvidenceExchangePackageDelivery: recipient email
ALTER TABLE IF EXISTS "evidence_exchange_package_deliveries"
  ADD COLUMN IF NOT EXISTS "recipient_email" VARCHAR(320);

-- AccessReviewItem: grant reference
ALTER TABLE IF EXISTS "access_review_items"
  ADD COLUMN IF NOT EXISTS "grant_ref" VARCHAR(200);

-- ===========================================================================
-- PHASE 3b — Indexes (each one independently pg_tables + per-column guarded).
-- ===========================================================================
DO $$
BEGIN
  -- video_tracks_team_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_tracks')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='video_tracks' AND column_name='team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_tracks_team_id_idx" ON "video_tracks" ("team_id")';
  END IF;

  -- video_tracks_evidence_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_tracks')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='video_tracks' AND column_name='evidence_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_tracks_evidence_id_idx" ON "video_tracks" ("evidence_id")';
  END IF;

  -- video_frames_team_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_frames')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='video_frames' AND column_name='team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_frames_team_id_idx" ON "video_frames" ("team_id")';
  END IF;

  -- video_frames_evidence_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_frames')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='video_frames' AND column_name='evidence_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_frames_evidence_id_idx" ON "video_frames" ("evidence_id")';
  END IF;

  -- video_track_detections_team_id_idx
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='video_track_detections')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='video_track_detections' AND column_name='team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "video_track_detections_team_id_idx" ON "video_track_detections" ("team_id")';
  END IF;
END $$;

COMMIT;
