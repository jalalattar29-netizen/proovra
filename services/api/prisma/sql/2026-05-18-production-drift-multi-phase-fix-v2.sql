-- =============================================================================
-- Production drift fix — v2 (PARTIAL-STATE SAFE)
--
-- The v1 patch wrapped every block in a single BEGIN…COMMIT. When one
-- statement in the middle failed (probably an unguarded ALTER TABLE /
-- ALTER TYPE / FK whose parent object didn't exist in prod yet), the
-- entire transaction rolled back and nothing landed.
--
-- v2 takes a different shape:
--   * NO outer BEGIN/COMMIT.
--   * Every mutating statement is wrapped in a `DO $$` block with full
--     guards: target table exists, referenced table exists, target
--     enum exists, constraint not already present, column not already
--     present.
--   * Each DO block is one statement from Postgres' perspective; if
--     one fails the next still runs (unless you wrap the whole thing
--     in a BEGIN/COMMIT — DON'T).
--   * Pre-check + post-check queries embedded at the top and bottom
--     so you can verify exactly what was missing and what landed.
--   * Re-runnable. Safe to apply repeatedly; every block converges to
--     "nothing to do" once the schema is in place.
--
-- HOW TO APPLY:
--   * Run the PRE-CHECK block first (it returns rows describing the
--     drift state — no mutation).
--   * Run this file in the Neon SQL editor with autocommit / "Run
--     selection" so each statement commits independently. DO NOT
--     paste it inside an explicit `BEGIN;` block.
--   * Re-run if anything fails — every block is idempotent.
--   * Then run the POST-CHECK block.
--   * THEN, and only then, run the `prisma migrate resolve --applied`
--     commands.
-- =============================================================================


-- =============================================================================
-- PRE-CHECK — run this BEFORE the mutating script. Returns one row
-- per target object with its current presence state. No writes.
-- =============================================================================
--
-- SELECT 'table'  AS kind, name, to_regclass('public.' || name) IS NOT NULL AS present FROM (VALUES
--   ('workspace_governance_policies'), ('evidence_legal_holds'),
--   ('api_credentials'), ('integration_webhook_endpoints'),
--   ('integration_webhook_deliveries'),
--   ('evidence_workflow_templates'), ('evidence_workflow_instances'),
--   ('evidence_workflow_instance_evidence'),
--   ('evidence_workflow_step_instances'),
--   ('evidence_workflow_visibility_decisions'),
--   ('review_escalations'), ('reviewer_workload_snapshots'),
--   ('evidence_saved_views'), ('evidence_reviewer_comments'),
--   ('evidence_legal_notes'), ('evidence_annotations'),
--   ('evidence_ai_categorizations')
-- ) AS t(name)
-- UNION ALL
-- SELECT 'enum' AS kind, typname AS name, EXISTS(SELECT 1 FROM pg_type WHERE typname = t.typname) AS present FROM (VALUES
--   ('EvidenceDeletionMode'), ('LegalHoldStatus'),
--   ('ApiCredentialStatus'), ('WebhookEndpointStatus'), ('WebhookDeliveryStatus'),
--   ('WorkspaceCategory'),
--   ('EvidenceCommentVisibility'), ('EvidenceLegalNoteType'),
--   ('EvidenceAnnotationType'), ('EvidenceAnnotationCoordinateSpace'),
--   ('EvidenceAiCategorizationStatus')
-- ) AS t(typname)
-- UNION ALL
-- SELECT 'parent_table' AS kind, name, to_regclass('public.' || name) IS NOT NULL AS present FROM (VALUES
--   ('users'), ('teams'), ('evidence'), ('evidence_parts'),
--   ('evidence_requests'), ('workflow_intake_sessions'),
--   ('evidence_review_workflows'), ('custody_events')
-- ) AS t(name)
-- ORDER BY kind, name;


-- =============================================================================
-- ENUMS (guarded; safe if absent or already present)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceDeletionMode') THEN
    CREATE TYPE "EvidenceDeletionMode" AS ENUM ('ALLOWED', 'ADMIN_ONLY', 'DISABLED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LegalHoldStatus') THEN
    CREATE TYPE "LegalHoldStatus" AS ENUM ('ACTIVE', 'RELEASED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApiCredentialStatus') THEN
    CREATE TYPE "ApiCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookEndpointStatus') THEN
    CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookDeliveryStatus') THEN
    CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'CANCELLED');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceCategory') THEN
    CREATE TYPE "WorkspaceCategory" AS ENUM (
      'GENERAL', 'INSURANCE', 'LEGAL', 'JOURNALISM', 'INVESTIGATIONS',
      'COMPLIANCE', 'FIELD_OPERATIONS', 'RESEARCH', 'OTHER'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceCommentVisibility') THEN
    CREATE TYPE "EvidenceCommentVisibility" AS ENUM ('INTERNAL', 'TEAM');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceLegalNoteType') THEN
    CREATE TYPE "EvidenceLegalNoteType" AS ENUM (
      'GENERAL', 'PRIVILEGED', 'DISCLOSURE', 'REVIEW_BOUNDARY', 'HANDOFF'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationType') THEN
    CREATE TYPE "EvidenceAnnotationType" AS ENUM (
      'POINT', 'BOX', 'REGION', 'TIMESTAMP', 'TEXT'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAnnotationCoordinateSpace') THEN
    CREATE TYPE "EvidenceAnnotationCoordinateSpace" AS ENUM (
      'NORMALIZED', 'PIXEL', 'TIME_ONLY', 'DOCUMENT_PAGE'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceAiCategorizationStatus') THEN
    CREATE TYPE "EvidenceAiCategorizationStatus" AS ENUM (
      'DISABLED', 'PENDING', 'COMPLETED', 'FAILED'
    );
  END IF;
END$$;

-- =============================================================================
-- ENUM-VALUE ADDITIONS (only if enum type exists)
-- CustodyEventType is a Phase-1-era enum; guarded for safety.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustodyEventType') THEN
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_PLACED';
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_RELEASED';
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_LEGAL_HOLD';
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DELETE_BLOCKED_BY_RETENTION';
    ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'EXPORT_BLOCKED_BY_POLICY';
  END IF;
END$$;

-- =============================================================================
-- TABLES (CREATE TABLE IF NOT EXISTS — already idempotent)
-- FKs are added in a separate, fully-guarded block below.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "workspace_governance_policies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "default_retention_days" INTEGER,
  "evidence_deletion_mode" "EvidenceDeletionMode" NOT NULL DEFAULT 'ALLOWED',
  "require_legal_hold_approval_for_deletion" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_report" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_package" BOOLEAN NOT NULL DEFAULT FALSE,
  "require_review_before_public_verify" BOOLEAN NOT NULL DEFAULT FALSE,
  "allow_external_intake" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_anonymous_intake" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_public_verify" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_package_download" BOOLEAN NOT NULL DEFAULT TRUE,
  "allow_report_download" BOOLEAN NOT NULL DEFAULT TRUE,
  "metadata_redaction_default" JSONB,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_legal_holds" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "case_id" UUID,
  "title" VARCHAR(180) NOT NULL,
  "reason" VARCHAR(4000),
  "status" "LegalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "placed_by_user_id" UUID NOT NULL,
  "placed_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "released_by_user_id" UUID,
  "released_at_utc" TIMESTAMPTZ(6),
  "release_note" VARCHAR(4000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "api_credentials" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "name" VARCHAR(180) NOT NULL,
  "description" VARCHAR(2000),
  "key_prefix" VARCHAR(32) NOT NULL,
  "key_hash" VARCHAR(128) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "ApiCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" UUID NOT NULL,
  "last_used_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "integration_webhook_endpoints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "description" VARCHAR(400),
  "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
  "secret_ciphertext" VARCHAR(512) NOT NULL,
  "secret_prefix" VARCHAR(32) NOT NULL,
  "event_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_success_at_utc" TIMESTAMPTZ(6),
  "last_failure_at_utc" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "integration_webhook_deliveries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "endpoint_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "event_id" VARCHAR(64) NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload_json" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at_utc" TIMESTAMPTZ(6),
  "response_status" INTEGER,
  "response_body_preview" VARCHAR(2000),
  "error_message" VARCHAR(2000),
  "sent_at_utc" TIMESTAMPTZ(6),
  "failed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_workflow_templates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" VARCHAR(120) NOT NULL,
  "team_id" UUID,
  "workspace_category" "WorkspaceCategory",
  "version" INTEGER NOT NULL DEFAULT 1,
  "name" VARCHAR(180) NOT NULL,
  "description" VARCHAR(2000),
  "archived" BOOLEAN NOT NULL DEFAULT FALSE,
  "plan_mode" VARCHAR(40) NOT NULL,
  "location_requirement" VARCHAR(20) NOT NULL,
  "intake_modes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowed_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "steps_json" JSONB NOT NULL,
  "rules_json" JSONB,
  "visibility_policy_json" JSONB,
  "review_policy_json" JSONB,
  "export_policy_json" JSONB,
  "created_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_workflow_instances" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "template_id" UUID,
  "template_slug" VARCHAR(120),
  "template_version" INTEGER,
  "status" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  "pre_hold_status" VARCHAR(32),
  "intake_mode" VARCHAR(40) NOT NULL,
  "actor_role" VARCHAR(40) NOT NULL,
  "case_id" UUID,
  "claim_ref" VARCHAR(128),
  "matter_ref" VARCHAR(128),
  "evidence_request_id" UUID,
  "intake_session_id" UUID,
  "external_contact_hash" VARCHAR(64),
  "created_by_user_id" UUID,
  "assigned_reviewer_user_id" UUID,
  "title" VARCHAR(180),
  "submitted_at_utc" TIMESTAMPTZ(6),
  "approved_at_utc" TIMESTAMPTZ(6),
  "closed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_workflow_instance_evidence" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "step_instance_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_workflow_step_instances" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "step_key" VARCHAR(80) NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT FALSE,
  "order_index" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
  "accepted_kinds_json" JSONB,
  "identity_requirement" VARCHAR(40),
  "location_requirement" VARCHAR(20),
  "mapped_evidence_id" UUID,
  "completed_by_user_id" UUID,
  "completed_at_utc" TIMESTAMPTZ(6),
  "waiver_reason" VARCHAR(400),
  "private_reviewer_note" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "evidence_workflow_visibility_decisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "evidence_id" UUID,
  "field_key" VARCHAR(80) NOT NULL,
  "visible_in_app" BOOLEAN NOT NULL DEFAULT TRUE,
  "visible_to_contributor" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_public_verify" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_report" BOOLEAN NOT NULL DEFAULT FALSE,
  "visible_in_verification_package" BOOLEAN NOT NULL DEFAULT FALSE,
  "requires_redaction" BOOLEAN NOT NULL DEFAULT FALSE,
  "reason" VARCHAR(400) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "review_escalations" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "workflow_id"              UUID         NOT NULL,
  "workflow_instance_id"     UUID,
  "evidence_id"              UUID,
  "reason"                   VARCHAR(48)  NOT NULL,
  "severity"                 VARCHAR(16)  NOT NULL DEFAULT 'WARNING',
  "status"                   VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  "safe_summary"             VARCHAR(400) NOT NULL,
  "created_by_user_id"       UUID,
  "assigned_to_user_id"      UUID,
  "acknowledged_at_utc"      TIMESTAMPTZ(6),
  "acknowledged_by_user_id"  UUID,
  "resolved_at_utc"          TIMESTAMPTZ(6),
  "resolved_by_user_id"      UUID,
  "resolution_note"          VARCHAR(400),
  "suppressed_at_utc"        TIMESTAMPTZ(6),
  "suppression_reason"       VARCHAR(400),
  "incident_id"              UUID,
  "fingerprint"              VARCHAR(80)  NOT NULL,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "review_escalations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reviewer_workload_snapshots" (
  "id"                          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                     UUID         NOT NULL,
  "reviewer_user_id"            UUID         NOT NULL,
  "active_review_count"         INTEGER      NOT NULL DEFAULT 0,
  "overdue_review_count"        INTEGER      NOT NULL DEFAULT 0,
  "due_soon_review_count"       INTEGER      NOT NULL DEFAULT 0,
  "escalated_review_count"      INTEGER      NOT NULL DEFAULT 0,
  "needs_info_review_count"     INTEGER      NOT NULL DEFAULT 0,
  "capacity_score"              INTEGER      NOT NULL DEFAULT 100,
  "safe_note"                   VARCHAR(400),
  "computed_at_utc"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviewer_workload_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_saved_views" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "team_id"       UUID,
  "name"          VARCHAR(120) NOT NULL,
  "description"   VARCHAR(400),
  "filters_json"  JSONB NOT NULL,
  "sort_key"      VARCHAR(64),
  "scope"         VARCHAR(32)  NOT NULL,
  "is_default"    BOOLEAN NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_saved_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_reviewer_comments" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "visibility"     "EvidenceCommentVisibility" NOT NULL DEFAULT 'INTERNAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_reviewer_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_legal_notes" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"    UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "note_type"      "EvidenceLegalNoteType" NOT NULL DEFAULT 'GENERAL',
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "evidence_legal_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_annotations" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"        UUID NOT NULL,
  "evidence_part_id"   UUID,
  "author_user_id"     UUID NOT NULL,
  "annotation_type"    "EvidenceAnnotationType" NOT NULL,
  "body"               TEXT,
  "page_number"        INTEGER,
  "media_timestamp_ms" INTEGER,
  "x"                  DOUBLE PRECISION,
  "y"                  DOUBLE PRECISION,
  "width"              DOUBLE PRECISION,
  "height"             DOUBLE PRECISION,
  "coordinate_space"   "EvidenceAnnotationCoordinateSpace" NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"         TIMESTAMPTZ(6),
  CONSTRAINT "evidence_annotations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "evidence_ai_categorizations" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id"           UUID NOT NULL,
  "requested_by_user_id"  UUID NOT NULL,
  "status"                "EvidenceAiCategorizationStatus" NOT NULL DEFAULT 'PENDING',
  "categories_json"       JSONB,
  "suggested_tags_json"   JSONB,
  "risk_flags_json"       JSONB,
  "summary"               TEXT,
  "legal_disclaimer"      TEXT NOT NULL,
  "model"                 VARCHAR(120),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_ai_categorizations_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- ADDITIVE COLUMNS — each block: target table must exist, then ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- Phase 10: workspace_governance_policies.allow_original_download
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_governance_policies'
  ) THEN
    ALTER TABLE "workspace_governance_policies"
      ADD COLUMN IF NOT EXISTS "allow_original_download" BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END$$;

-- Phase 2 (workflow template foundation): teams.workspace_category column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'teams'
  )
  AND EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'WorkspaceCategory'
  ) THEN
    ALTER TABLE "teams"
      ADD COLUMN IF NOT EXISTS "workspace_category" "WorkspaceCategory";
  END IF;
END$$;

-- Phase 22: evidence_workflow_templates.status column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evidence_workflow_templates'
  ) THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';
  END IF;
END$$;

-- Phase 25: evidence_review_workflows additive columns. Skip cleanly if
-- the parent table itself isn't yet present (older drift).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evidence_review_workflows'
  ) THEN
    ALTER TABLE "evidence_review_workflows"
      ADD COLUMN IF NOT EXISTS "assignment_due_at_utc" TIMESTAMPTZ(6),
      ADD COLUMN IF NOT EXISTS "completion_due_at_utc" TIMESTAMPTZ(6),
      ADD COLUMN IF NOT EXISTS "paused_reason"         VARCHAR(400),
      ADD COLUMN IF NOT EXISTS "active_escalation_id"  UUID;
  END IF;
END$$;

-- =============================================================================
-- INDEXES — each block: target table exists AND every referenced column
-- exists. CREATE INDEX IF NOT EXISTS is already idempotent for the name
-- collision case; this extra guard handles the "table or column missing"
-- case that would otherwise error.
-- =============================================================================

-- workspace_governance_policies unique(team_id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_governance_policies'
      AND column_name = 'team_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_governance_policies_team_id_key"
      ON "workspace_governance_policies" ("team_id");
  END IF;
END$$;

-- evidence_legal_holds indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_legal_holds') THEN
    CREATE INDEX IF NOT EXISTS "evidence_legal_holds_team_status_idx" ON "evidence_legal_holds" ("team_id","status");
    CREATE INDEX IF NOT EXISTS "evidence_legal_holds_evidence_status_idx" ON "evidence_legal_holds" ("evidence_id","status");
    CREATE INDEX IF NOT EXISTS "evidence_legal_holds_case_idx" ON "evidence_legal_holds" ("case_id");
    CREATE INDEX IF NOT EXISTS "evidence_legal_holds_placed_by_idx" ON "evidence_legal_holds" ("placed_by_user_id");
  END IF;
END$$;

-- api_credentials indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='api_credentials') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "api_credentials_key_hash_key" ON "api_credentials" ("key_hash");
    CREATE INDEX IF NOT EXISTS "api_credentials_team_status_idx" ON "api_credentials" ("team_id","status");
    CREATE INDEX IF NOT EXISTS "api_credentials_team_created_idx" ON "api_credentials" ("team_id","created_at" DESC);
  END IF;
END$$;

-- integration_webhook_endpoints indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='integration_webhook_endpoints') THEN
    CREATE INDEX IF NOT EXISTS "integration_webhook_endpoints_team_status_idx" ON "integration_webhook_endpoints" ("team_id","status");
  END IF;
END$$;

-- integration_webhook_deliveries indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='integration_webhook_deliveries') THEN
    CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_endpoint_created_idx" ON "integration_webhook_deliveries" ("endpoint_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_team_created_idx" ON "integration_webhook_deliveries" ("team_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_status_idx" ON "integration_webhook_deliveries" ("status");
    CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_next_attempt_idx" ON "integration_webhook_deliveries" ("next_attempt_at_utc");
    CREATE INDEX IF NOT EXISTS "integration_webhook_deliveries_event_id_idx" ON "integration_webhook_deliveries" ("event_id");
  END IF;
END$$;

-- teams.workspace_category index
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='teams' AND column_name='workspace_category'
  ) THEN
    CREATE INDEX IF NOT EXISTS "teams_workspace_category_idx" ON "teams" ("workspace_category");
  END IF;
END$$;

-- evidence_workflow_templates indexes (incl. partial unique by slug scope)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_workflow_templates') THEN
    CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_id_archived_idx" ON "evidence_workflow_templates" ("team_id","archived");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_id_workspace_category_idx" ON "evidence_workflow_templates" ("team_id","workspace_category");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_slug_idx" ON "evidence_workflow_templates" ("slug");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_workspace_category_idx" ON "evidence_workflow_templates" ("workspace_category");
    CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_templates_team_slug_unique"
      ON "evidence_workflow_templates" ("team_id","slug") WHERE "team_id" IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_templates_global_slug_unique"
      ON "evidence_workflow_templates" ("slug") WHERE "team_id" IS NULL;
  END IF;
  -- The team_status index requires the `status` column added above.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='evidence_workflow_templates' AND column_name='status'
  ) THEN
    CREATE INDEX IF NOT EXISTS "evidence_workflow_templates_team_status_idx" ON "evidence_workflow_templates" ("team_id","status");
  END IF;
END$$;

-- evidence_workflow_instances indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_workflow_instances') THEN
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_status_idx" ON "evidence_workflow_instances" ("team_id","status");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_created_at_idx" ON "evidence_workflow_instances" ("team_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_team_intake_mode_idx" ON "evidence_workflow_instances" ("team_id","intake_mode");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_template_id_idx" ON "evidence_workflow_instances" ("template_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_evidence_request_id_idx" ON "evidence_workflow_instances" ("evidence_request_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_intake_session_id_idx" ON "evidence_workflow_instances" ("intake_session_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instances_external_contact_hash_idx" ON "evidence_workflow_instances" ("external_contact_hash");
  END IF;
END$$;

-- evidence_workflow_instance_evidence indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_uk"
      ON "evidence_workflow_instance_evidence" ("workflow_instance_id","evidence_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_evidence_id_idx"
      ON "evidence_workflow_instance_evidence" ("evidence_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_instance_evidence_step_instance_id_idx"
      ON "evidence_workflow_instance_evidence" ("step_instance_id");
  END IF;
END$$;

-- evidence_workflow_step_instances indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_workflow_step_instances') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_step_uk"
      ON "evidence_workflow_step_instances" ("workflow_instance_id","step_key");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_status_idx"
      ON "evidence_workflow_step_instances" ("workflow_instance_id","status");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_workflow_order_idx"
      ON "evidence_workflow_step_instances" ("workflow_instance_id","order_index");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_step_instances_mapped_evidence_id_idx"
      ON "evidence_workflow_step_instances" ("mapped_evidence_id");
  END IF;
END$$;

-- evidence_workflow_visibility_decisions indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_uk"
      ON "evidence_workflow_visibility_decisions" ("workflow_instance_id","evidence_id","field_key");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_workflow_idx"
      ON "evidence_workflow_visibility_decisions" ("workflow_instance_id");
    CREATE INDEX IF NOT EXISTS "evidence_workflow_visibility_decisions_evidence_idx"
      ON "evidence_workflow_visibility_decisions" ("evidence_id");
  END IF;
END$$;

-- review_escalations indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='review_escalations') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "review_escalations_team_fingerprint_uk" ON "review_escalations" ("team_id","fingerprint");
    CREATE INDEX IF NOT EXISTS "review_escalations_team_status_idx" ON "review_escalations" ("team_id","status");
    CREATE INDEX IF NOT EXISTS "review_escalations_team_severity_idx" ON "review_escalations" ("team_id","severity");
    CREATE INDEX IF NOT EXISTS "review_escalations_team_reason_idx" ON "review_escalations" ("team_id","reason");
    CREATE INDEX IF NOT EXISTS "review_escalations_workflow_created_idx" ON "review_escalations" ("workflow_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "review_escalations_workflow_instance_idx" ON "review_escalations" ("workflow_instance_id");
    CREATE INDEX IF NOT EXISTS "review_escalations_assigned_to_status_idx" ON "review_escalations" ("assigned_to_user_id","status");
    CREATE INDEX IF NOT EXISTS "review_escalations_incident_idx" ON "review_escalations" ("incident_id");
  END IF;
END$$;

-- reviewer_workload_snapshots indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='reviewer_workload_snapshots') THEN
    CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_reviewer_computed_idx"
      ON "reviewer_workload_snapshots" ("team_id","reviewer_user_id","computed_at_utc" DESC);
    CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_computed_idx"
      ON "reviewer_workload_snapshots" ("team_id","computed_at_utc" DESC);
    CREATE INDEX IF NOT EXISTS "reviewer_workload_snapshots_team_capacity_idx"
      ON "reviewer_workload_snapshots" ("team_id","capacity_score");
  END IF;
END$$;

-- evidence_review_workflows additive-column indexes (depend on columns
-- added above; skip cleanly if either column is missing).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='evidence_review_workflows'
      AND column_name='assignment_due_at_utc'
  ) THEN
    CREATE INDEX IF NOT EXISTS "evidence_review_workflows_assignment_due_at_utc_idx"
      ON "evidence_review_workflows" ("assignment_due_at_utc");
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='evidence_review_workflows'
      AND column_name='completion_due_at_utc'
  ) THEN
    CREATE INDEX IF NOT EXISTS "evidence_review_workflows_completion_due_at_utc_idx"
      ON "evidence_review_workflows" ("completion_due_at_utc");
  END IF;
END$$;

-- evidence_saved_views indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_saved_views') THEN
    CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_created_at_idx"
      ON "evidence_saved_views" ("owner_user_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_saved_views_team_id_created_at_idx"
      ON "evidence_saved_views" ("team_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_saved_views_owner_user_id_is_default_idx"
      ON "evidence_saved_views" ("owner_user_id","is_default");
  END IF;
END$$;

-- evidence_reviewer_comments / evidence_legal_notes / evidence_annotations / evidence_ai_categorizations indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_reviewer_comments') THEN
    CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_evidence_id_created_at_idx"
      ON "evidence_reviewer_comments" ("evidence_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_author_user_id_idx"
      ON "evidence_reviewer_comments" ("author_user_id");
    CREATE INDEX IF NOT EXISTS "evidence_reviewer_comments_deleted_at_idx"
      ON "evidence_reviewer_comments" ("deleted_at");
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_legal_notes') THEN
    CREATE INDEX IF NOT EXISTS "evidence_legal_notes_evidence_id_created_at_idx"
      ON "evidence_legal_notes" ("evidence_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_legal_notes_author_user_id_idx"
      ON "evidence_legal_notes" ("author_user_id");
    CREATE INDEX IF NOT EXISTS "evidence_legal_notes_deleted_at_idx"
      ON "evidence_legal_notes" ("deleted_at");
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_annotations') THEN
    CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_id_created_at_idx"
      ON "evidence_annotations" ("evidence_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_annotations_evidence_part_id_idx"
      ON "evidence_annotations" ("evidence_part_id");
    CREATE INDEX IF NOT EXISTS "evidence_annotations_author_user_id_idx"
      ON "evidence_annotations" ("author_user_id");
    CREATE INDEX IF NOT EXISTS "evidence_annotations_deleted_at_idx"
      ON "evidence_annotations" ("deleted_at");
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='evidence_ai_categorizations') THEN
    CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_evidence_id_created_at_idx"
      ON "evidence_ai_categorizations" ("evidence_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_requested_by_user_id_created_at_idx"
      ON "evidence_ai_categorizations" ("requested_by_user_id","created_at" DESC);
    CREATE INDEX IF NOT EXISTS "evidence_ai_categorizations_status_idx"
      ON "evidence_ai_categorizations" ("status");
  END IF;
END$$;

-- =============================================================================
-- FOREIGN KEYS — every block guards on (this table exists) AND
-- (referenced table exists) AND (constraint not already present).
-- Safe to re-run; safe when parent tables aren't installed yet.
-- =============================================================================

-- workspace_governance_policies → teams, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='workspace_governance_policies')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_governance_policies_team_fkey') THEN
    ALTER TABLE "workspace_governance_policies"
      ADD CONSTRAINT "workspace_governance_policies_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='workspace_governance_policies')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_governance_policies_updated_by_user_fkey') THEN
    ALTER TABLE "workspace_governance_policies"
      ADD CONSTRAINT "workspace_governance_policies_updated_by_user_fkey"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_legal_holds → teams, evidence, users, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_holds')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_team_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_holds')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_evidence_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_evidence_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_holds')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_placed_by_user_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_placed_by_user_fkey"
      FOREIGN KEY ("placed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_holds')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_released_by_user_fkey') THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_released_by_user_fkey"
      FOREIGN KEY ("released_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- api_credentials → teams, users, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='api_credentials')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_team_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='api_credentials')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_created_by_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_created_by_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='api_credentials')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_credentials_revoked_by_fkey') THEN
    ALTER TABLE "api_credentials"
      ADD CONSTRAINT "api_credentials_revoked_by_fkey"
      FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- integration_webhook_endpoints → teams, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='integration_webhook_endpoints')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_endpoints_team_fkey') THEN
    ALTER TABLE "integration_webhook_endpoints"
      ADD CONSTRAINT "integration_webhook_endpoints_team_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='integration_webhook_endpoints')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_endpoints_created_by_fkey') THEN
    ALTER TABLE "integration_webhook_endpoints"
      ADD CONSTRAINT "integration_webhook_endpoints_created_by_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END$$;

-- integration_webhook_deliveries → integration_webhook_endpoints
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='integration_webhook_deliveries')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='integration_webhook_endpoints')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_webhook_deliveries_endpoint_fkey') THEN
    ALTER TABLE "integration_webhook_deliveries"
      ADD CONSTRAINT "integration_webhook_deliveries_endpoint_fkey"
      FOREIGN KEY ("endpoint_id") REFERENCES "integration_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_workflow_templates → teams, users, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_templates')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_team_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_templates')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_created_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_templates')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_templates_updated_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_templates"
      ADD CONSTRAINT "evidence_workflow_templates_updated_by_user_id_fkey"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_workflow_instances → teams, evidence_workflow_templates, users, users, evidence_requests, workflow_intake_sessions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_team_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_templates')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_template_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "evidence_workflow_templates"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_created_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_assigned_reviewer_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_assigned_reviewer_user_id_fkey"
      FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_requests')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_evidence_request_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_evidence_request_id_fkey"
      FOREIGN KEY ("evidence_request_id") REFERENCES "evidence_requests"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='workflow_intake_sessions')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instances_intake_session_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instances"
      ADD CONSTRAINT "evidence_workflow_instances_intake_session_id_fkey"
      FOREIGN KEY ("intake_session_id") REFERENCES "workflow_intake_sessions"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- evidence_workflow_instance_evidence → evidence_workflow_instances, evidence
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instance_evidence_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instance_evidence"
      ADD CONSTRAINT "evidence_workflow_instance_evidence_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instance_evidence')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_instance_evidence_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_instance_evidence"
      ADD CONSTRAINT "evidence_workflow_instance_evidence_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE;
  END IF;
END$$;

-- evidence_workflow_step_instances → evidence_workflow_instances, users, evidence
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_step_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_step_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_completed_by_user_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_completed_by_user_id_fkey"
      FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_step_instances')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_step_instances_mapped_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_step_instances"
      ADD CONSTRAINT "evidence_workflow_step_instances_mapped_evidence_id_fkey"
      FOREIGN KEY ("mapped_evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- evidence_workflow_visibility_decisions → evidence_workflow_instances, evidence
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_instances')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_visibility_decisions_workflow_id_fkey') THEN
    ALTER TABLE "evidence_workflow_visibility_decisions"
      ADD CONSTRAINT "evidence_workflow_visibility_decisions_workflow_id_fkey"
      FOREIGN KEY ("workflow_instance_id") REFERENCES "evidence_workflow_instances"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_workflow_visibility_decisions')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_workflow_visibility_decisions_evidence_id_fkey') THEN
    ALTER TABLE "evidence_workflow_visibility_decisions"
      ADD CONSTRAINT "evidence_workflow_visibility_decisions_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- review_escalations → teams, evidence_review_workflows, users(×4)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_team_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_review_workflows')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_workflow_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_workflow_id_fkey"
      FOREIGN KEY ("workflow_id") REFERENCES "evidence_review_workflows"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_created_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_assigned_to_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_assigned_to_user_id_fkey"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_acknowledged_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_acknowledged_by_user_id_fkey"
      FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='review_escalations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_escalations_resolved_by_user_id_fkey') THEN
    ALTER TABLE "review_escalations"
      ADD CONSTRAINT "review_escalations_resolved_by_user_id_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- reviewer_workload_snapshots → teams, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reviewer_workload_snapshots')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_team_id_fkey') THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reviewer_workload_snapshots')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_workload_snapshots_reviewer_user_id_fkey') THEN
    ALTER TABLE "reviewer_workload_snapshots"
      ADD CONSTRAINT "reviewer_workload_snapshots_reviewer_user_id_fkey"
      FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END$$;

-- evidence_saved_views → users, teams
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_saved_views')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_saved_views_owner_user_id_fkey') THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_saved_views')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='teams')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_saved_views_team_id_fkey') THEN
    ALTER TABLE "evidence_saved_views"
      ADD CONSTRAINT "evidence_saved_views_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_reviewer_comments → evidence, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_reviewer_comments')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_reviewer_comments_evidence_id_fkey') THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_reviewer_comments')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_reviewer_comments_author_user_id_fkey') THEN
    ALTER TABLE "evidence_reviewer_comments"
      ADD CONSTRAINT "evidence_reviewer_comments_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_legal_notes → evidence, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_notes')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_notes_evidence_id_fkey') THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_legal_notes')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_notes_author_user_id_fkey') THEN
    ALTER TABLE "evidence_legal_notes"
      ADD CONSTRAINT "evidence_legal_notes_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_annotations → evidence, evidence_parts (optional), users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_annotations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_evidence_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_annotations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_parts')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_evidence_part_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_evidence_part_id_fkey"
      FOREIGN KEY ("evidence_part_id") REFERENCES "evidence_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_annotations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_annotations_author_user_id_fkey') THEN
    ALTER TABLE "evidence_annotations"
      ADD CONSTRAINT "evidence_annotations_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- evidence_ai_categorizations → evidence, users
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_ai_categorizations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_ai_categorizations_evidence_id_fkey') THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='evidence_ai_categorizations')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_ai_categorizations_requested_by_user_id_fkey') THEN
    ALTER TABLE "evidence_ai_categorizations"
      ADD CONSTRAINT "evidence_ai_categorizations_requested_by_user_id_fkey"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;


-- =============================================================================
-- POST-CHECK — run after the script to verify what landed.
-- Every row should return present=true. Missing rows tell you which
-- parent objects are still absent (run the parent migration first).
-- =============================================================================
--
-- WITH expected_tables(name) AS (VALUES
--   ('workspace_governance_policies'), ('evidence_legal_holds'),
--   ('api_credentials'), ('integration_webhook_endpoints'),
--   ('integration_webhook_deliveries'),
--   ('evidence_workflow_templates'), ('evidence_workflow_instances'),
--   ('evidence_workflow_instance_evidence'),
--   ('evidence_workflow_step_instances'),
--   ('evidence_workflow_visibility_decisions'),
--   ('review_escalations'), ('reviewer_workload_snapshots'),
--   ('evidence_saved_views'), ('evidence_reviewer_comments'),
--   ('evidence_legal_notes'), ('evidence_annotations'),
--   ('evidence_ai_categorizations')
-- ), expected_enums(name) AS (VALUES
--   ('EvidenceDeletionMode'), ('LegalHoldStatus'),
--   ('ApiCredentialStatus'), ('WebhookEndpointStatus'), ('WebhookDeliveryStatus'),
--   ('WorkspaceCategory'),
--   ('EvidenceCommentVisibility'), ('EvidenceLegalNoteType'),
--   ('EvidenceAnnotationType'), ('EvidenceAnnotationCoordinateSpace'),
--   ('EvidenceAiCategorizationStatus')
-- )
-- SELECT 'table' AS kind, name,
--        (to_regclass('public.' || name) IS NOT NULL) AS present
-- FROM expected_tables
-- UNION ALL
-- SELECT 'enum' AS kind, name,
--        EXISTS (SELECT 1 FROM pg_type WHERE typname = expected_enums.name) AS present
-- FROM expected_enums
-- ORDER BY present, kind, name;


-- =============================================================================
-- AFTER A CLEAN POST-CHECK (every row present=true):
-- run these in services/api to mark the migrations applied.
-- DO NOT run them until the post-check is clean for the migration's
-- owned tables. Running migrate resolve while objects are still
-- missing makes Prisma believe the migration is done and it will skip
-- it on the next `prisma migrate deploy`.
--
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260516120000_add_workflow_template_foundation
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260517100000_add_governance_phase9
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260517140000_add_integrations_phase10
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260508133000_add_evidence_operations_workspace_features
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260530100000_add_workflow_engine_phase22
--   pnpm --dir services/api exec prisma migrate resolve --applied 20260601100000_add_reviewer_operations_phase25
-- =============================================================================
