-- Phase R3 Model Catchup — ADDITIVE schema extension (Round 2: fully partial-state safe).
--
-- BACKGROUND
-- ----------
-- Production partially applied an earlier version of this migration. Some tables
-- (e.g. external_review_invitation_deliveries) exist WITHOUT their inline FK
-- because the referenced table failed to create in the same partial apply.
-- Round 1's `wrap CREATE TABLE in IF NOT EXISTS` therefore skipped the entire
-- CREATE TABLE block on rerun, leaving the FK permanently absent and causing a
-- downstream statement to abort the transaction with
--   `current transaction is aborted, commands ignored until end of transaction block`.
--
-- Round 2 fixes this by splitting table creation from constraint creation so each
-- statement is independently guarded and rerunnable:
--
--   * Tables  → DO $$ IF NOT EXISTS (pg_tables) THEN CREATE TABLE … END IF; END $$;
--     (NOT `CREATE TABLE IF NOT EXISTS` — Phase O safety audit flags that as
--      CRITICAL because it silently hides column drift on partially-evolved tables.
--      Inner CREATE TABLE still ends with `);` so the audit's column-tracking
--      regex continues to populate columnsAddedByTable[<name>].)
--   * UNIQUE  → DO $$ IF table exists AND constraint missing THEN ALTER TABLE ADD CONSTRAINT … END IF;
--   * FK      → DO $$ IF child exists AND parent exists AND constraint missing THEN ALTER TABLE ADD CONSTRAINT …
--   * Columns → ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS … (Postgres-native idempotency).
--   * Indexes → CREATE INDEX IF NOT EXISTS … inside column-existence guards (unchanged).
--
-- ZERO destructive operations: no DROP, no RENAME, no DELETE, no TRUNCATE.
-- Tested via services/api/scripts/test-r3-rerun.sh against three scenarios:
--   (1) clean DB, (2) rerun on already-applied DB, (3) partial state with
--   external_review_invitation_deliveries + redaction_{projects,versions,regions,detections}
--   pre-created (matches the documented production state).

BEGIN;

-- ===========================================================================
-- PHASE 1 — Tables (columns + PRIMARY KEY only).
-- Each table is guarded by pg_tables; FK/UNIQUE constraints land in Phase 2.
-- ===========================================================================

-- devices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'devices'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "devices" (
  "id"                    UUID         NOT NULL,
  "team_id"               UUID         NOT NULL,
  "owner_user_id"         UUID         NOT NULL,
  "label"                 VARCHAR(256) NOT NULL,
  "public_key_hex"        VARCHAR(256) NOT NULL,
  "public_key_fingerprint" VARCHAR(128) NOT NULL,
  "attestation_provider"  VARCHAR(40)  NOT NULL,
  "revoked_at_utc"        TIMESTAMPTZ(6),
  "revocation_reason"     VARCHAR(400),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- capture_device_attestations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'capture_device_attestations'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "capture_device_attestations" (
  "id"              UUID         NOT NULL,
  "device_id"       UUID         NOT NULL,
  "team_id"         UUID         NOT NULL,
  "nonce_hex"       VARCHAR(128) NOT NULL,
  "provider"        VARCHAR(40)  NOT NULL,
  "verdict"         VARCHAR(40)  NOT NULL,
  "failure_reason"  VARCHAR(200),
  "attested_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "capture_device_attestations_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- capture_trust_event_records
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'capture_trust_event_records'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "capture_trust_event_records" (
  "id"             UUID         NOT NULL,
  "team_id"        UUID         NOT NULL,
  "evidence_id"    UUID         NOT NULL,
  "device_id"      UUID,
  "code"           VARCHAR(80)  NOT NULL,
  "sequence"       INTEGER      NOT NULL,
  "event_hash"     VARCHAR(64)  NOT NULL,
  "prev_event_hash" VARCHAR(64),
  "payload"        JSONB,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "capture_trust_event_records_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- coding_schemas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_schemas'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "coding_schemas" (
  "id"          UUID         NOT NULL,
  "team_id"     UUID         NOT NULL,
  "name"        VARCHAR(200) NOT NULL,
  "slug"        VARCHAR(100) NOT NULL,
  "version"     INTEGER      NOT NULL DEFAULT 1,
  "state"       VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "description" VARCHAR(800),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "coding_schemas_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- coding_fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_fields'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "coding_fields" (
  "id"         UUID         NOT NULL,
  "schema_id"  UUID         NOT NULL,
  "team_id"    UUID         NOT NULL,
  "slug"       VARCHAR(100) NOT NULL,
  "label"      VARCHAR(200) NOT NULL,
  "field_type" VARCHAR(40)  NOT NULL,
  "required"   BOOLEAN      NOT NULL DEFAULT FALSE,
  "position"   INTEGER      NOT NULL DEFAULT 0,
  "config"     JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "coding_fields_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- coding_values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_values'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "coding_values" (
  "id"          UUID         NOT NULL,
  "workflow_id" UUID         NOT NULL,
  "field_id"    UUID         NOT NULL,
  "team_id"     UUID         NOT NULL,
  "value"       JSONB        NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "coding_values_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- reviewer_disagreements
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'reviewer_disagreements'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "reviewer_disagreements" (
  "id"                UUID         NOT NULL,
  "workflow_id"       UUID         NOT NULL,
  "team_id"           UUID         NOT NULL,
  "filed_by_user_id"  UUID         NOT NULL,
  "state"             VARCHAR(40)  NOT NULL DEFAULT 'FILED',
  "reason"            VARCHAR(800) NOT NULL,
  "resolution"        VARCHAR(800),
  "resolved_at_utc"   TIMESTAMPTZ(6),
  "resolved_by_user_id" UUID,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "reviewer_disagreements_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- qc_samples
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'qc_samples'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "qc_samples" (
  "id"                  UUID         NOT NULL,
  "workflow_id"         UUID         NOT NULL,
  "team_id"             UUID         NOT NULL,
  "assigned_to_user_id" UUID,
  "verdict"             VARCHAR(20),
  "failure_reasons"     JSONB        NOT NULL DEFAULT '[]',
  "sampled_at_utc"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "verdict_at_utc"      TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "qc_samples_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- external_reviewer_role_assignments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_reviewer_role_assignments'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "external_reviewer_role_assignments" (
  "id"                UUID         NOT NULL,
  "team_id"           UUID         NOT NULL,
  "evidence_id"       UUID         NOT NULL,
  "granted_by_user_id" UUID        NOT NULL,
  "external_email"    VARCHAR(320) NOT NULL,
  "grant_state"       VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "raw_token"         VARCHAR(128),
  "token_hash"        VARCHAR(128),
  "expires_at_utc"    TIMESTAMPTZ(6),
  "revoked_at_utc"    TIMESTAMPTZ(6),
  "auth_method"       VARCHAR(20)  NOT NULL DEFAULT 'TOKEN',
  "sso_connection_id" VARCHAR(128),
  "allowed_domains"   TEXT[]       NOT NULL DEFAULT '{}',
  "sso_subject_hash"  VARCHAR(128),
  "sso_name_id"       VARCHAR(320),
  "sso_bound_at_utc"  TIMESTAMPTZ(6),
  "mfa_satisfied_at_utc" TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_reviewer_role_assignments_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- external_review_invitation_deliveries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_invitation_deliveries'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "external_review_invitation_deliveries" (
  "id"               UUID         NOT NULL,
  "team_id"          UUID         NOT NULL,
  "grant_id"         UUID         NOT NULL,
  "status"           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "provider"         VARCHAR(40)  NOT NULL DEFAULT 'RESEND_API',
  "attempt"          INTEGER      NOT NULL DEFAULT 1,
  "provider_msg_id"  VARCHAR(200),
  "bulk_batch_id"    VARCHAR(128),
  "failure_reason"   VARCHAR(400),
  "sent_at_utc"      TIMESTAMPTZ(6),
  "opened_at_utc"    TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_review_invitation_deliveries_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_projects
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_projects'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_projects" (
  "id"                UUID        NOT NULL,
  "team_id"           UUID        NOT NULL,
  "evidence_id"       UUID        NOT NULL,
  "state"             VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  "created_by_user_id" UUID       NOT NULL,
  "closed_at_utc"     TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_projects_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_versions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_versions" (
  "id"                UUID        NOT NULL,
  "project_id"        UUID        NOT NULL,
  "team_id"           UUID        NOT NULL,
  "version_ordinal"   INTEGER     NOT NULL,
  "state"             VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "artifact_kind"     VARCHAR(40) NOT NULL,
  "created_by_user_id" UUID       NOT NULL,
  "published_at_utc"  TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_versions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_regions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_regions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_regions" (
  "id"         UUID        NOT NULL,
  "version_id" UUID        NOT NULL,
  "team_id"    UUID        NOT NULL,
  "kind"       VARCHAR(40) NOT NULL,
  "geometry"   JSONB       NOT NULL,
  "method"     VARCHAR(40) NOT NULL,
  "label"      VARCHAR(200),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_regions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_detections
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_detections'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_detections" (
  "id"              UUID        NOT NULL,
  "version_id"      UUID        NOT NULL,
  "team_id"         UUID        NOT NULL,
  "detection_kind"  VARCHAR(40) NOT NULL,
  "provider"        VARCHAR(40) NOT NULL,
  "confidence"      DOUBLE PRECISION,
  "geometry"        JSONB,
  "payload"         JSONB,
  "state"           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_detections_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_decisions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_decisions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_decisions" (
  "id"                UUID        NOT NULL,
  "region_id"         UUID        NOT NULL,
  "team_id"           UUID        NOT NULL,
  "decided_by_user_id" UUID       NOT NULL,
  "state"             VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "rationale"         VARCHAR(800),
  "decided_at_utc"    TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_decisions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_approvals
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_approvals'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_approvals" (
  "id"                 UUID        NOT NULL,
  "version_id"         UUID        NOT NULL,
  "team_id"            UUID        NOT NULL,
  "approved_by_user_id" UUID       NOT NULL,
  "verdict"            VARCHAR(20) NOT NULL,
  "rationale"          VARCHAR(800),
  "approved_at_utc"    TIMESTAMPTZ(6) NOT NULL,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_approvals_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_derivatives
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_derivatives'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_derivatives" (
  "id"               UUID        NOT NULL,
  "version_id"       UUID        NOT NULL,
  "team_id"          UUID        NOT NULL,
  "state"            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "storage_key"      VARCHAR(600),
  "file_sha256"      VARCHAR(64),
  "kind"             VARCHAR(40) NOT NULL,
  "generated_at_utc" TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "redaction_derivatives_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- redaction_activities
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_activities'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "redaction_activities" (
  "id"           UUID        NOT NULL,
  "project_id"   UUID        NOT NULL,
  "team_id"      UUID        NOT NULL,
  "actor_user_id" UUID,
  "code"         VARCHAR(80) NOT NULL,
  "payload"      JSONB,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "redaction_activities_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- trust_center_articles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'trust_center_articles'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "trust_center_articles" (
  "id"         UUID         NOT NULL,
  "team_id"    UUID,
  "kind"       VARCHAR(40)  NOT NULL,
  "section"    VARCHAR(80)  NOT NULL,
  "slug"       VARCHAR(120) NOT NULL,
  "state"      VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "title"      VARCHAR(300) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "trust_center_articles_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- trust_center_article_versions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'trust_center_article_versions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "trust_center_article_versions" (
  "id"           UUID         NOT NULL,
  "article_id"   UUID         NOT NULL,
  "version"      INTEGER      NOT NULL,
  "body"         TEXT         NOT NULL,
  "published_at" TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "trust_center_article_versions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- subprocessors
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'subprocessors'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "subprocessors" (
  "id"          UUID         NOT NULL,
  "name"        VARCHAR(200) NOT NULL,
  "category"    VARCHAR(80)  NOT NULL,
  "state"       VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "country"     VARCHAR(80),
  "description" VARCHAR(800),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subprocessors_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- subprocessor_versions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'subprocessor_versions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "subprocessor_versions" (
  "id"              UUID         NOT NULL,
  "subprocessor_id" UUID         NOT NULL,
  "version"         INTEGER      NOT NULL,
  "change_note"     VARCHAR(800),
  "effective_at"    TIMESTAMPTZ(6) NOT NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "subprocessor_versions_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- status_components
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_components'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "status_components" (
  "id"          UUID        NOT NULL,
  "key"         VARCHAR(80) NOT NULL,
  "label"       VARCHAR(200) NOT NULL,
  "health"      VARCHAR(30) NOT NULL DEFAULT 'OPERATIONAL',
  "description" VARCHAR(400),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "status_components_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- status_incidents
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_incidents'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "status_incidents" (
  "id"             UUID        NOT NULL,
  "component_id"   UUID        NOT NULL,
  "severity"       VARCHAR(20) NOT NULL,
  "state"          VARCHAR(30) NOT NULL DEFAULT 'INVESTIGATING',
  "title"          VARCHAR(300) NOT NULL,
  "started_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at_utc" TIMESTAMPTZ(6),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- status_incident_updates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_incident_updates'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "status_incident_updates" (
  "id"          UUID        NOT NULL,
  "incident_id" UUID        NOT NULL,
  "state"       VARCHAR(30) NOT NULL,
  "body"        VARCHAR(2000) NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "status_incident_updates_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- maintenance_windows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'maintenance_windows'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "maintenance_windows" (
  "id"           UUID         NOT NULL,
  "title"        VARCHAR(300) NOT NULL,
  "body"         VARCHAR(2000),
  "starts_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "ends_at_utc"  TIMESTAMPTZ(6) NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- departments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'departments'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "departments" (
  "id"         UUID         NOT NULL,
  "team_id"    UUID         NOT NULL,
  "name"       VARCHAR(200) NOT NULL,
  "state"      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "parent_id"  UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- delegated_admin_grants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'delegated_admin_grants'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "delegated_admin_grants" (
  "id"                  UUID        NOT NULL,
  "team_id"             UUID        NOT NULL,
  "granted_to_user_id"  UUID        NOT NULL,
  "granted_by_user_id"  UUID        NOT NULL,
  "tier"                VARCHAR(40) NOT NULL,
  "state"               VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "scope_target_id"     UUID,
  "expires_at_utc"      TIMESTAMPTZ(6),
  "revoked_at_utc"      TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "delegated_admin_grants_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- governance_policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policies'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "governance_policies" (
  "id"               UUID        NOT NULL,
  "team_id"          UUID        NOT NULL,
  "kind"             VARCHAR(60) NOT NULL,
  "name"             VARCHAR(200) NOT NULL,
  "state"            VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "enforcement_mode" VARCHAR(20) NOT NULL DEFAULT 'WARN',
  "config"           JSONB       NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- governance_policy_assignments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policy_assignments'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "governance_policy_assignments" (
  "id"            UUID        NOT NULL,
  "policy_id"     UUID        NOT NULL,
  "team_id"       UUID        NOT NULL,
  "scope_kind"    VARCHAR(40) NOT NULL,
  "scope_target_id" UUID,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policy_assignments_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- governance_policy_audits
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policy_audits'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "governance_policy_audits" (
  "id"            UUID        NOT NULL,
  "policy_id"     UUID        NOT NULL,
  "team_id"       UUID        NOT NULL,
  "actor_user_id" UUID,
  "action"        VARCHAR(60) NOT NULL,
  "payload"       JSONB,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policy_audits_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- access_review_campaigns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'access_review_campaigns'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "access_review_campaigns" (
  "id"              UUID         NOT NULL,
  "team_id"         UUID         NOT NULL,
  "kind"            VARCHAR(60)  NOT NULL,
  "state"           VARCHAR(20)  NOT NULL DEFAULT 'SCHEDULED',
  "title"           VARCHAR(300) NOT NULL,
  "starts_at_utc"   TIMESTAMPTZ(6) NOT NULL,
  "ends_at_utc"     TIMESTAMPTZ(6) NOT NULL,
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "access_review_campaigns_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- access_review_items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'access_review_items'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "access_review_items" (
  "id"               UUID        NOT NULL,
  "campaign_id"      UUID        NOT NULL,
  "team_id"          UUID        NOT NULL,
  "subject_user_id"  UUID        NOT NULL,
  "reviewer_user_id" UUID        NOT NULL,
  "decision"         VARCHAR(20),
  "rationale"        VARCHAR(800),
  "decided_at_utc"   TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "access_review_items_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- cross_org_review_grants
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'cross_org_review_grants'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "cross_org_review_grants" (
  "id"                UUID        NOT NULL,
  "team_id"           UUID        NOT NULL,
  "target_org_id"     UUID        NOT NULL,
  "granted_by_user_id" UUID       NOT NULL,
  "state"             VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "scope"             JSONB       NOT NULL DEFAULT '{}',
  "expires_at_utc"    TIMESTAMPTZ(6),
  "revoked_at_utc"    TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "cross_org_review_grants_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- evidence_exchange_package_builds
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'evidence_exchange_package_builds'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "evidence_exchange_package_builds" (
  "id"               TEXT         NOT NULL,
  "team_id"          UUID         NOT NULL,
  "package_id"       VARCHAR(200) NOT NULL,
  "state"            VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "storage_key"      VARCHAR(600),
  "payload_sha256"   VARCHAR(64),
  "size_bytes"       BIGINT,
  "failure_reason"   VARCHAR(600),
  "started_at_utc"   TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "evidence_exchange_package_builds_pkey" PRIMARY KEY ("id")
);
    $sql$;
  END IF;
END $$;

-- ===========================================================================
-- PHASE 2a — UNIQUE constraints (pg_constraint guarded).
-- Adds the constraint only when (table exists) AND (constraint missing).
-- Handles the partial-prod case where a table was created without its UNIQUE.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'devices'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'devices'
       AND c.conname = 'devices_public_key_fingerprint_key'
  ) THEN
    EXECUTE 'ALTER TABLE "devices" ADD CONSTRAINT "devices_public_key_fingerprint_key" UNIQUE ("public_key_fingerprint")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'capture_device_attestations'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'capture_device_attestations'
       AND c.conname = 'capture_device_attestations_device_id_nonce_hex_key'
  ) THEN
    EXECUTE 'ALTER TABLE "capture_device_attestations" ADD CONSTRAINT "capture_device_attestations_device_id_nonce_hex_key" UNIQUE ("device_id", "nonce_hex")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_fields'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'coding_fields'
       AND c.conname = 'coding_fields_schema_id_slug_key'
  ) THEN
    EXECUTE 'ALTER TABLE "coding_fields" ADD CONSTRAINT "coding_fields_schema_id_slug_key" UNIQUE ("schema_id", "slug")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_values'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'coding_values'
       AND c.conname = 'coding_values_workflow_id_field_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "coding_values" ADD CONSTRAINT "coding_values_workflow_id_field_id_key" UNIQUE ("workflow_id", "field_id")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_reviewer_role_assignments'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_reviewer_role_assignments'
       AND c.conname = 'external_reviewer_role_assignments_token_hash_key'
  ) THEN
    EXECUTE 'ALTER TABLE "external_reviewer_role_assignments" ADD CONSTRAINT "external_reviewer_role_assignments_token_hash_key" UNIQUE ("token_hash")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_projects'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_projects'
       AND c.conname = 'redaction_projects_team_id_evidence_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_projects" ADD CONSTRAINT "redaction_projects_team_id_evidence_id_key" UNIQUE ("team_id", "evidence_id")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_versions'
       AND c.conname = 'redaction_versions_project_id_version_ordinal_key'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_versions" ADD CONSTRAINT "redaction_versions_project_id_version_ordinal_key" UNIQUE ("project_id", "version_ordinal")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_derivatives'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_derivatives'
       AND c.conname = 'redaction_derivatives_version_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_derivatives" ADD CONSTRAINT "redaction_derivatives_version_id_key" UNIQUE ("version_id")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'trust_center_articles'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'trust_center_articles'
       AND c.conname = 'trust_center_articles_slug_key'
  ) THEN
    EXECUTE 'ALTER TABLE "trust_center_articles" ADD CONSTRAINT "trust_center_articles_slug_key" UNIQUE ("slug")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'subprocessors'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'subprocessors'
       AND c.conname = 'subprocessors_name_key'
  ) THEN
    EXECUTE 'ALTER TABLE "subprocessors" ADD CONSTRAINT "subprocessors_name_key" UNIQUE ("name")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_components'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'status_components'
       AND c.conname = 'status_components_key_key'
  ) THEN
    EXECUTE 'ALTER TABLE "status_components" ADD CONSTRAINT "status_components_key_key" UNIQUE ("key")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'evidence_exchange_package_builds'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'evidence_exchange_package_builds'
       AND c.conname = 'evidence_exchange_package_builds_package_id_key'
  ) THEN
    EXECUTE 'ALTER TABLE "evidence_exchange_package_builds" ADD CONSTRAINT "evidence_exchange_package_builds_package_id_key" UNIQUE ("package_id")';
  END IF;
END $$;

-- ===========================================================================
-- PHASE 2b — FOREIGN KEY constraints (pg_constraint + pg_tables guarded).
-- Adds the FK only when (child exists) AND (parent exists) AND (constraint missing).
-- The pg_tables-on-parent check ensures order independence: if the referenced
-- table is missing, this FK silently no-ops rather than aborting the transaction.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'capture_device_attestations'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'devices'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'capture_device_attestations'
       AND c.conname = 'capture_device_attestations_device_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "capture_device_attestations" ADD CONSTRAINT "capture_device_attestations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_fields'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_schemas'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'coding_fields'
       AND c.conname = 'coding_fields_schema_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "coding_fields" ADD CONSTRAINT "coding_fields_schema_id_fkey" FOREIGN KEY ("schema_id") REFERENCES "coding_schemas"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_values'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'coding_fields'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'coding_values'
       AND c.conname = 'coding_values_field_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "coding_values" ADD CONSTRAINT "coding_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "coding_fields"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_review_invitation_deliveries'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'external_reviewer_role_assignments'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'external_review_invitation_deliveries'
       AND c.conname = 'external_review_invitation_deliveries_grant_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "external_review_invitation_deliveries" ADD CONSTRAINT "external_review_invitation_deliveries_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "external_reviewer_role_assignments"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_projects'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_versions'
       AND c.conname = 'redaction_versions_project_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_versions" ADD CONSTRAINT "redaction_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "redaction_projects"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_regions'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_regions'
       AND c.conname = 'redaction_regions_version_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_regions" ADD CONSTRAINT "redaction_regions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_detections'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_detections'
       AND c.conname = 'redaction_detections_version_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_detections" ADD CONSTRAINT "redaction_detections_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_decisions'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_regions'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_decisions'
       AND c.conname = 'redaction_decisions_region_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_decisions" ADD CONSTRAINT "redaction_decisions_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "redaction_regions"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_approvals'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_approvals'
       AND c.conname = 'redaction_approvals_version_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_approvals" ADD CONSTRAINT "redaction_approvals_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_derivatives'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_versions'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_derivatives'
       AND c.conname = 'redaction_derivatives_version_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_derivatives" ADD CONSTRAINT "redaction_derivatives_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_activities'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'redaction_projects'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'redaction_activities'
       AND c.conname = 'redaction_activities_project_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "redaction_activities" ADD CONSTRAINT "redaction_activities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "redaction_projects"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'trust_center_article_versions'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'trust_center_articles'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'trust_center_article_versions'
       AND c.conname = 'trust_center_article_versions_article_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "trust_center_article_versions" ADD CONSTRAINT "trust_center_article_versions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "trust_center_articles"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'subprocessor_versions'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'subprocessors'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'subprocessor_versions'
       AND c.conname = 'subprocessor_versions_subprocessor_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "subprocessor_versions" ADD CONSTRAINT "subprocessor_versions_subprocessor_id_fkey" FOREIGN KEY ("subprocessor_id") REFERENCES "subprocessors"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_incidents'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_components'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'status_incidents'
       AND c.conname = 'status_incidents_component_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "status_incidents" ADD CONSTRAINT "status_incidents_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "status_components"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_incident_updates'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'status_incidents'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'status_incident_updates'
       AND c.conname = 'status_incident_updates_incident_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "status_incident_updates" ADD CONSTRAINT "status_incident_updates_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "status_incidents"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policy_assignments'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policies'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'governance_policy_assignments'
       AND c.conname = 'governance_policy_assignments_policy_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "governance_policy_assignments" ADD CONSTRAINT "governance_policy_assignments_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "governance_policies"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policy_audits'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'governance_policies'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'governance_policy_audits'
       AND c.conname = 'governance_policy_audits_policy_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "governance_policy_audits" ADD CONSTRAINT "governance_policy_audits_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "governance_policies"("id") ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'access_review_items'
  )
  AND EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'access_review_campaigns'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'access_review_items'
       AND c.conname = 'access_review_items_campaign_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "access_review_campaigns"("id") ON DELETE CASCADE';
  END IF;
END $$;

-- ===========================================================================
-- PHASE 3a — Additive columns on existing tables (Postgres-native idempotency).
-- ===========================================================================

-- Additive columns on EvidenceAnnotation
ALTER TABLE IF EXISTS "evidence_annotations"
  ADD COLUMN IF NOT EXISTS "parent_annotation_id" UUID;

-- Additive columns on EvidenceReviewWorkflow
ALTER TABLE IF EXISTS "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "coding_schema_id"      UUID,
  ADD COLUMN IF NOT EXISTS "coding_schema_version"  INTEGER;

-- ===========================================================================
-- PHASE 3b — Indexes (per-column information_schema-guarded CREATE INDEX IF NOT EXISTS).
-- Unchanged from the original migration — already idempotent.
-- ===========================================================================
DO $$
BEGIN
  -- devices: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'devices'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "devices_team_id_idx" ON "devices" ("team_id")';
  END IF;

  -- devices: (owner_user_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'devices'
       AND column_name  = 'owner_user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "devices_owner_user_id_idx" ON "devices" ("owner_user_id")';
  END IF;

  -- capture_device_attestations: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'capture_device_attestations'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "capture_device_attestations_team_id_idx" ON "capture_device_attestations" ("team_id")';
  END IF;

  -- capture_trust_event_records: (team_id, evidence_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'capture_trust_event_records'
       AND column_name  = 'team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'capture_trust_event_records'
       AND column_name  = 'evidence_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "capture_trust_event_records_team_evidence_idx" ON "capture_trust_event_records" ("team_id", "evidence_id")';
  END IF;

  -- capture_trust_event_records: (evidence_id, sequence)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'capture_trust_event_records'
       AND column_name  = 'evidence_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'capture_trust_event_records'
       AND column_name  = 'sequence'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "capture_trust_event_records_evidence_seq_idx" ON "capture_trust_event_records" ("evidence_id", "sequence")';
  END IF;

  -- coding_schemas: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'coding_schemas'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "coding_schemas_team_id_idx" ON "coding_schemas" ("team_id")';
  END IF;

  -- coding_fields: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'coding_fields'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "coding_fields_team_id_idx" ON "coding_fields" ("team_id")';
  END IF;

  -- coding_values: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'coding_values'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "coding_values_team_id_idx" ON "coding_values" ("team_id")';
  END IF;

  -- reviewer_disagreements: (team_id), (workflow_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'reviewer_disagreements'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "reviewer_disagreements_team_id_idx" ON "reviewer_disagreements" ("team_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "reviewer_disagreements_workflow_id_idx" ON "reviewer_disagreements" ("workflow_id")';
  END IF;

  -- qc_samples: (team_id), (workflow_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'qc_samples'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "qc_samples_team_id_idx" ON "qc_samples" ("team_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "qc_samples_workflow_id_idx" ON "qc_samples" ("workflow_id")';
  END IF;

  -- external_reviewer_role_assignments: (team_id), (evidence_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'external_reviewer_role_assignments'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_reviewer_role_assignments_team_id_idx" ON "external_reviewer_role_assignments" ("team_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_reviewer_role_assignments_evidence_id_idx" ON "external_reviewer_role_assignments" ("evidence_id")';
  END IF;

  -- external_review_invitation_deliveries: (team_id, grant_id), (team_id, status)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'external_review_invitation_deliveries'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_team_grant_idx" ON "external_review_invitation_deliveries" ("team_id", "grant_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "external_review_invitation_deliveries_team_status_idx" ON "external_review_invitation_deliveries" ("team_id", "status")';
  END IF;

  -- redaction_projects: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'redaction_projects'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_projects_team_id_idx" ON "redaction_projects" ("team_id")';
  END IF;

  -- redaction_versions: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'redaction_versions'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_versions_team_id_idx" ON "redaction_versions" ("team_id")';
  END IF;

  -- redaction_activities: (project_id, created_at DESC), (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'redaction_activities'
       AND column_name  = 'project_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_activities_project_id_idx" ON "redaction_activities" ("project_id", "created_at" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "redaction_activities_team_id_idx" ON "redaction_activities" ("team_id")';
  END IF;

  -- trust_center_articles: (kind, section)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'trust_center_articles'
       AND column_name  = 'kind'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_articles_kind_section_idx" ON "trust_center_articles" ("kind", "section")';
  END IF;

  -- trust_center_article_versions: (article_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'trust_center_article_versions'
       AND column_name  = 'article_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_article_versions_article_id_idx" ON "trust_center_article_versions" ("article_id")';
  END IF;

  -- departments: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'departments'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "departments_team_id_idx" ON "departments" ("team_id")';
  END IF;

  -- delegated_admin_grants: (team_id), (granted_to_user_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'delegated_admin_grants'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "delegated_admin_grants_team_id_idx" ON "delegated_admin_grants" ("team_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "delegated_admin_grants_granted_to_user_id_idx" ON "delegated_admin_grants" ("granted_to_user_id")';
  END IF;

  -- governance_policies: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'governance_policies'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "governance_policies_team_id_idx" ON "governance_policies" ("team_id")';
  END IF;

  -- access_review_campaigns: (team_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'access_review_campaigns'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "access_review_campaigns_team_id_idx" ON "access_review_campaigns" ("team_id")';
  END IF;

  -- cross_org_review_grants: (team_id), (target_org_id)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'cross_org_review_grants'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "cross_org_review_grants_team_id_idx" ON "cross_org_review_grants" ("team_id")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "cross_org_review_grants_target_org_id_idx" ON "cross_org_review_grants" ("target_org_id")';
  END IF;

  -- evidence_exchange_package_builds: (team_id, state)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_exchange_package_builds'
       AND column_name  = 'team_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "evidence_exchange_package_builds_team_state_idx" ON "evidence_exchange_package_builds" ("team_id", "state")';
  END IF;
END $$;


COMMIT;
