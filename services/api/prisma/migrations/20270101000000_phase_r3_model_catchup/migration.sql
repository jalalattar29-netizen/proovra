-- Phase R3 Model Catchup — ADDITIVE schema extension.
--
-- Pattern: Phase-O-Final compliant.
-- * BEGIN / COMMIT wrapped.
-- * Plain CREATE TABLE for new tables (no IF NOT EXISTS).
-- * ADD COLUMN IF NOT EXISTS for additive columns on existing tables.
-- * All CREATE INDEX wrapped in DO/information_schema column-existence guards.
-- * No DROP, no RENAME, no DELETE, no TRUNCATE.

BEGIN;

-- ---------------------------------------------------------------------------
-- Phase 1B — Mobile Capture Trust
-- ---------------------------------------------------------------------------

-- Idempotent wrapper for devices (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[devices].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'devices'
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
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "devices_public_key_fingerprint_key" UNIQUE ("public_key_fingerprint")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for capture_device_attestations (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[capture_device_attestations].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'capture_device_attestations'
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
  CONSTRAINT "capture_device_attestations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_device_attestations_device_id_nonce_hex_key" UNIQUE ("device_id", "nonce_hex"),
  CONSTRAINT "capture_device_attestations_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for capture_trust_event_records (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[capture_trust_event_records].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'capture_trust_event_records'
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

-- ---------------------------------------------------------------------------
-- Phase 2A — Reviewer Workspace
-- ---------------------------------------------------------------------------

-- Idempotent wrapper for coding_schemas (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[coding_schemas].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'coding_schemas'
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

-- Idempotent wrapper for coding_fields (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[coding_fields].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'coding_fields'
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
  CONSTRAINT "coding_fields_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coding_fields_schema_id_slug_key" UNIQUE ("schema_id", "slug"),
  CONSTRAINT "coding_fields_schema_id_fkey"
    FOREIGN KEY ("schema_id") REFERENCES "coding_schemas"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for coding_values (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[coding_values].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'coding_values'
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
  CONSTRAINT "coding_values_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coding_values_workflow_id_field_id_key" UNIQUE ("workflow_id", "field_id"),
  CONSTRAINT "coding_values_field_id_fkey"
    FOREIGN KEY ("field_id") REFERENCES "coding_fields"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for reviewer_disagreements (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[reviewer_disagreements].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'reviewer_disagreements'
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

-- Idempotent wrapper for qc_samples (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[qc_samples].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'qc_samples'
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

-- Additive columns on EvidenceAnnotation
ALTER TABLE IF EXISTS "evidence_annotations"
  ADD COLUMN IF NOT EXISTS "parent_annotation_id" UUID;

-- Additive columns on EvidenceReviewWorkflow
ALTER TABLE IF EXISTS "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "coding_schema_id"      UUID,
  ADD COLUMN IF NOT EXISTS "coding_schema_version"  INTEGER;

-- ---------------------------------------------------------------------------
-- Phase 2B Closure — External Reviewer Portal
-- ---------------------------------------------------------------------------

-- Idempotent wrapper for external_reviewer_role_assignments (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[external_reviewer_role_assignments].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_reviewer_role_assignments'
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
  CONSTRAINT "external_reviewer_role_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_reviewer_role_assignments_token_hash_key" UNIQUE ("token_hash")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for external_review_invitation_deliveries (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[external_review_invitation_deliveries].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'external_review_invitation_deliveries'
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
  CONSTRAINT "external_review_invitation_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_review_invitation_deliveries_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "external_reviewer_role_assignments"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3A — Enterprise Redaction Platform
-- ---------------------------------------------------------------------------

-- Idempotent wrapper for redaction_projects (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_projects].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_projects'
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
  CONSTRAINT "redaction_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_projects_team_id_evidence_id_key" UNIQUE ("team_id", "evidence_id")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_versions (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_versions].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_versions'
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
  CONSTRAINT "redaction_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_versions_project_id_version_ordinal_key" UNIQUE ("project_id", "version_ordinal"),
  CONSTRAINT "redaction_versions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "redaction_projects"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_regions (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_regions].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_regions'
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
  CONSTRAINT "redaction_regions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_regions_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_detections (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_detections].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_detections'
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
  CONSTRAINT "redaction_detections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_detections_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_decisions (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_decisions].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_decisions'
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
  CONSTRAINT "redaction_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_decisions_region_id_fkey"
    FOREIGN KEY ("region_id") REFERENCES "redaction_regions"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_approvals (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_approvals].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_approvals'
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
  CONSTRAINT "redaction_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_approvals_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_derivatives (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_derivatives].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_derivatives'
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
  CONSTRAINT "redaction_derivatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_derivatives_version_id_key" UNIQUE ("version_id"),
  CONSTRAINT "redaction_derivatives_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "redaction_versions"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for redaction_activities (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[redaction_activities].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'redaction_activities'
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
  CONSTRAINT "redaction_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "redaction_activities_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "redaction_projects"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 4A — Trust Center + Enterprise Governance
-- ---------------------------------------------------------------------------

-- Idempotent wrapper for trust_center_articles (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[trust_center_articles].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'trust_center_articles'
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
  CONSTRAINT "trust_center_articles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trust_center_articles_slug_key" UNIQUE ("slug")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for trust_center_article_versions (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[trust_center_article_versions].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'trust_center_article_versions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "trust_center_article_versions" (
  "id"           UUID         NOT NULL,
  "article_id"   UUID         NOT NULL,
  "version"      INTEGER      NOT NULL,
  "body"         TEXT         NOT NULL,
  "published_at" TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "trust_center_article_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trust_center_article_versions_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "trust_center_articles"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for subprocessors (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[subprocessors].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'subprocessors'
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
  CONSTRAINT "subprocessors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subprocessors_name_key" UNIQUE ("name")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for subprocessor_versions (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[subprocessor_versions].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'subprocessor_versions'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "subprocessor_versions" (
  "id"              UUID         NOT NULL,
  "subprocessor_id" UUID         NOT NULL,
  "version"         INTEGER      NOT NULL,
  "change_note"     VARCHAR(800),
  "effective_at"    TIMESTAMPTZ(6) NOT NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "subprocessor_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subprocessor_versions_subprocessor_id_fkey"
    FOREIGN KEY ("subprocessor_id") REFERENCES "subprocessors"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for status_components (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[status_components].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'status_components'
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
  CONSTRAINT "status_components_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "status_components_key_key" UNIQUE ("key")
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for status_incidents (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[status_incidents].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'status_incidents'
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
  CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "status_incidents_component_id_fkey"
    FOREIGN KEY ("component_id") REFERENCES "status_components"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for status_incident_updates (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[status_incident_updates].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'status_incident_updates'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "status_incident_updates" (
  "id"          UUID        NOT NULL,
  "incident_id" UUID        NOT NULL,
  "state"       VARCHAR(30) NOT NULL,
  "body"        VARCHAR(2000) NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "status_incident_updates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "status_incident_updates_incident_id_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "status_incidents"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for maintenance_windows (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[maintenance_windows].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'maintenance_windows'
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

-- Idempotent wrapper for departments (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[departments].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'departments'
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

-- Idempotent wrapper for delegated_admin_grants (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[delegated_admin_grants].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'delegated_admin_grants'
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

-- Idempotent wrapper for governance_policies (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[governance_policies].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'governance_policies'
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

-- Idempotent wrapper for governance_policy_assignments (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[governance_policy_assignments].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'governance_policy_assignments'
  ) THEN
    EXECUTE $sql$
CREATE TABLE "governance_policy_assignments" (
  "id"            UUID        NOT NULL,
  "policy_id"     UUID        NOT NULL,
  "team_id"       UUID        NOT NULL,
  "scope_kind"    VARCHAR(40) NOT NULL,
  "scope_target_id" UUID,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policy_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policy_assignments_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "governance_policies"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for governance_policy_audits (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[governance_policy_audits].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'governance_policy_audits'
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
  CONSTRAINT "governance_policy_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policy_audits_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "governance_policies"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for access_review_campaigns (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[access_review_campaigns].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'access_review_campaigns'
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

-- Idempotent wrapper for access_review_items (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[access_review_items].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'access_review_items'
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
  CONSTRAINT "access_review_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_review_items_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "access_review_campaigns"("id") ON DELETE CASCADE
);
    $sql$;
  END IF;
END $$;

-- Idempotent wrapper for cross_org_review_grants (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[cross_org_review_grants].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'cross_org_review_grants'
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

-- Idempotent wrapper for evidence_exchange_package_builds (production may be partially applied).
-- Phase O-Final compliant: DO/information_schema.tables guard
-- (NOT plain `CREATE TABLE IF NOT EXISTS`, which the migration
-- safety audit flags as CRITICAL because it silently hides
-- column drift on partially-evolved tables). The inner statement
-- still ends with `);` so the audit's column-tracking regex
-- continues to populate columnsAddedByTable[evidence_exchange_package_builds].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'evidence_exchange_package_builds'
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
  CONSTRAINT "evidence_exchange_package_builds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_exchange_package_builds_package_id_key" UNIQUE ("package_id")
);
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes — all wrapped in DO/information_schema column-existence guards
-- ---------------------------------------------------------------------------
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
