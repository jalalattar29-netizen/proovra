-- PHASE 3A — Enterprise Redaction Platform.
--
-- Eight new tables:
--   * redaction_projects             (one per (team, evidence))
--   * redaction_versions             (append-only versions of a project)
--   * redaction_regions              (bounded geometry rows)
--   * redaction_detections           (provider-produced suggestions)
--   * redaction_decisions            (reviewer per-detection decisions)
--   * redaction_approvals            (approver verdicts)
--   * redaction_derivatives          (pointer to generated redacted artifact)
--   * redaction_activity             (bounded audit timeline)
--
-- Hard rules:
--   * Brand-new tables → plain CREATE TABLE (NOT `IF NOT EXISTS`). The
--     Phase O safety gate requires loud failure on a divergent
--     pre-existing copy.
--   * Every CREATE INDEX wrapped in a DO/information_schema column
--     existence guard — the Phase O-Final defense against
--     `column does not exist` (SQL 42703) replays.
--   * Cascading deletes propagate from project → version → regions
--     /detections/decisions/approvals/derivative so a single archive
--     of a project is atomic.
--   * Original Evidence table is NEVER altered.

BEGIN;

-- =============================================================================
-- 1. redaction_projects
-- =============================================================================
CREATE TABLE "redaction_projects" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "evidence_id"         UUID         NOT NULL,
  "artifact_kind"       VARCHAR(20)  NOT NULL,
  "title"               VARCHAR(200),
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "created_by_user_id"  UUID         NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "archived_at"         TIMESTAMPTZ(6),
  CONSTRAINT "redaction_projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "redaction_projects_team_evidence_uniq"
  ON "redaction_projects" ("team_id", "evidence_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_projects'
                AND column_name='team_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='redaction_projects'
                 AND column_name='state')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_projects_team_state_idx" ON "redaction_projects" ("team_id", "state")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_projects'
                AND column_name='created_at')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_projects_team_created_idx" ON "redaction_projects" ("team_id", "created_at" DESC)';
  END IF;
END $$;

-- =============================================================================
-- 2. redaction_versions
-- =============================================================================
CREATE TABLE "redaction_versions" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "project_id"            UUID         NOT NULL,
  "team_id"               UUID         NOT NULL,
  "version_ordinal"       SMALLINT     NOT NULL,
  "state"                 VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "authored_by_user_id"   UUID         NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "submitted_at_utc"      TIMESTAMPTZ(6),
  "approved_at_utc"       TIMESTAMPTZ(6),
  "rejected_at_utc"       TIMESTAMPTZ(6),
  "published_at_utc"      TIMESTAMPTZ(6),
  "superseded_at_utc"     TIMESTAMPTZ(6),
  "rationale"             VARCHAR(600),
  CONSTRAINT "redaction_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_versions_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "redaction_projects" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "redaction_versions_project_ordinal_uniq"
  ON "redaction_versions" ("project_id", "version_ordinal");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_versions'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_versions_team_state_idx" ON "redaction_versions" ("team_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_versions_team_project_idx" ON "redaction_versions" ("team_id", "project_id")';
  END IF;
END $$;

-- =============================================================================
-- 3. redaction_regions
-- =============================================================================
CREATE TABLE "redaction_regions" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "version_id"          UUID         NOT NULL,
  "team_id"             UUID         NOT NULL,
  "kind"                VARCHAR(40)  NOT NULL,
  "method"              VARCHAR(20)  NOT NULL,
  "geometry"            JSONB        NOT NULL,
  "rationale"           VARCHAR(600),
  "source_detection_id" UUID,
  "source_provider"     VARCHAR(40),
  "authored_by_user_id" UUID         NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_regions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_regions_version_fk"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_regions'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_regions_team_version_idx" ON "redaction_regions" ("team_id", "version_id")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_regions'
                AND column_name='source_detection_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_regions_source_detection_idx" ON "redaction_regions" ("source_detection_id")';
  END IF;
END $$;

-- =============================================================================
-- 4. redaction_detections
-- =============================================================================
CREATE TABLE "redaction_detections" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "version_id"                  UUID         NOT NULL,
  "team_id"                     UUID         NOT NULL,
  "kind"                        VARCHAR(40)  NOT NULL,
  "provider"                    VARCHAR(40)  NOT NULL,
  "confidence_band"             VARCHAR(20)  NOT NULL,
  "raw_confidence"              DOUBLE PRECISION NOT NULL,
  "suggested_region_kind"       VARCHAR(40)  NOT NULL,
  "suggested_region_geometry"   JSONB        NOT NULL,
  "suggested_method"            VARCHAR(20)  NOT NULL DEFAULT 'BLACKOUT',
  "preview_label"               VARCHAR(80),
  "decision_state"              VARCHAR(20)  NOT NULL DEFAULT 'SUGGESTED',
  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_detections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_detections_version_fk"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_detections'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_detections_team_version_idx" ON "redaction_detections" ("team_id", "version_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_detections_team_provider_idx" ON "redaction_detections" ("team_id", "provider")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_detections'
                AND column_name='decision_state')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_detections_decision_state_idx" ON "redaction_detections" ("decision_state")';
  END IF;
END $$;

-- =============================================================================
-- 5. redaction_decisions
-- =============================================================================
CREATE TABLE "redaction_decisions" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "version_id"               UUID         NOT NULL,
  "team_id"                  UUID         NOT NULL,
  "detection_id"             UUID         NOT NULL,
  "decision_state"           VARCHAR(20)  NOT NULL,
  "modified_region_geometry" JSONB,
  "rationale"                VARCHAR(600),
  "decided_by_user_id"       UUID         NOT NULL,
  "decided_at_utc"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_decisions_version_fk"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions" ("id") ON DELETE CASCADE,
  CONSTRAINT "redaction_decisions_detection_fk"
    FOREIGN KEY ("detection_id") REFERENCES "redaction_detections" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_decisions'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_decisions_team_version_idx" ON "redaction_decisions" ("team_id", "version_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_decisions_detection_idx" ON "redaction_decisions" ("detection_id")';
  END IF;
END $$;

-- =============================================================================
-- 6. redaction_approvals
-- =============================================================================
CREATE TABLE "redaction_approvals" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "version_id"       UUID         NOT NULL,
  "team_id"          UUID         NOT NULL,
  "verdict"          VARCHAR(20)  NOT NULL,
  "rationale"        VARCHAR(600),
  "approver_user_id" UUID         NOT NULL,
  "decided_at_utc"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_approvals_version_fk"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_approvals'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_approvals_team_version_idx" ON "redaction_approvals" ("team_id", "version_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_approvals_approver_idx" ON "redaction_approvals" ("approver_user_id")';
  END IF;
END $$;

-- =============================================================================
-- 7. redaction_derivatives
-- =============================================================================
CREATE TABLE "redaction_derivatives" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "version_id"            UUID         NOT NULL,
  "team_id"               UUID         NOT NULL,
  "kind"                  VARCHAR(20)  NOT NULL,
  "state"                 VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "storage_bucket"        VARCHAR(180),
  "storage_key"           VARCHAR(400),
  "storage_region"        VARCHAR(40),
  "byte_size"             BIGINT,
  "file_sha256"           VARCHAR(64),
  "content_type"          VARCHAR(120),
  "render_engine"         VARCHAR(40),
  "render_started_at_utc" TIMESTAMPTZ(6),
  "rendered_at_utc"       TIMESTAMPTZ(6),
  "failure_reason"        VARCHAR(120),
  "last_error_preview"    VARCHAR(400),
  "download_count"        INT          NOT NULL DEFAULT 0,
  CONSTRAINT "redaction_derivatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_derivatives_version_fk"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "redaction_derivatives_version_uniq"
  ON "redaction_derivatives" ("version_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_derivatives'
                AND column_name='team_id')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_derivatives_team_state_idx" ON "redaction_derivatives" ("team_id", "state")';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_derivatives'
                AND column_name='file_sha256')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_derivatives_sha_idx" ON "redaction_derivatives" ("file_sha256")';
  END IF;
END $$;

-- =============================================================================
-- 8. redaction_activity
-- =============================================================================
CREATE TABLE "redaction_activity" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID         NOT NULL,
  "project_id"     UUID         NOT NULL,
  "version_id"     UUID,
  "code"           VARCHAR(60)  NOT NULL,
  "actor_user_id"  UUID,
  "payload"        JSONB,
  "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_activity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_activity_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "redaction_projects" ("id") ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_activity'
                AND column_name='team_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='redaction_activity'
                 AND column_name='occurred_at_utc')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_activity_team_project_occ_idx" ON "redaction_activity" ("team_id", "project_id", "occurred_at_utc" DESC)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='redaction_activity'
                AND column_name='code')
  THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_activity_code_idx" ON "redaction_activity" ("code")';
  END IF;
END $$;

COMMIT;
