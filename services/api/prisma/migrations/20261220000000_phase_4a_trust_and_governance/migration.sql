-- PHASE 4A — Trust Center + Enterprise Governance Platform.
--
-- 12 new tables (all brand-new, Phase O-Final hygienic):
--
--   trust_center_articles            — versioned trust + methodology
--                                      + AI disclosure + security
--                                      articles.
--   trust_center_article_versions    — version history.
--   subprocessors                    — subprocessor registry.
--   subprocessor_versions            — change history.
--   status_components                — status page components.
--   status_incidents                 — incidents.
--   status_incident_updates          — incident timeline.
--   maintenance_windows              — scheduled maintenance.
--   departments                      — org sub-units.
--   delegated_admin_grants           — tiered admin grants.
--   governance_policies              — policy registry.
--   governance_policy_assignments    — org/dept/workspace scoping.
--   governance_policy_audit          — append-only audit trail.
--   access_review_campaigns          — campaign metadata.
--   access_review_items              — per-grant decisions.
--   cross_org_review_grants          — cross-org review invitations.
--
-- Hard rules:
--   * Brand-new tables → plain CREATE TABLE.
--   * Every CREATE INDEX wrapped in a DO/information_schema guard
--     with column-existence checks for every referenced column.
--   * Cascade deletes from parents.
--   * No existing tables altered.

BEGIN;

-- =============================================================================
-- 1. trust_center_articles
-- =============================================================================
CREATE TABLE "trust_center_articles" (
  "id"                        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                   UUID         NOT NULL,
  "kind"                      VARCHAR(20)  NOT NULL,
  "section"                   VARCHAR(60)  NOT NULL,
  "slug"                      VARCHAR(120) NOT NULL,
  "title"                     VARCHAR(200) NOT NULL,
  "summary"                   VARCHAR(600) NOT NULL,
  "body"                      TEXT         NOT NULL,
  "state"                     VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "version"                   INT          NOT NULL DEFAULT 1,
  "implementation_references" JSONB,
  "policy_tags"               JSONB,
  "authored_by_user_id"       UUID,
  "published_at_utc"          TIMESTAMPTZ(6),
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "trust_center_articles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trust_center_articles_team_kind_slug_uniq"
  ON "trust_center_articles" ("team_id", "kind", "slug");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='trust_center_articles'
                AND column_name='kind')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_articles'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_articles'
                    AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_articles'
                    AND column_name='section') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_articles_team_kind_state_idx" ON "trust_center_articles" ("team_id", "kind", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_articles_team_section_idx" ON "trust_center_articles" ("team_id", "section")';
  END IF;
END $$;

-- =============================================================================
-- 2. trust_center_article_versions
-- =============================================================================
CREATE TABLE "trust_center_article_versions" (
  "id"                        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                   UUID         NOT NULL,
  "article_id"                UUID         NOT NULL,
  "version"                   INT          NOT NULL,
  "title"                     VARCHAR(200) NOT NULL,
  "summary"                   VARCHAR(600) NOT NULL,
  "body"                      TEXT         NOT NULL,
  "state"                     VARCHAR(20)  NOT NULL,
  "implementation_references" JSONB,
  "policy_tags"               JSONB,
  "authored_by_user_id"       UUID         NOT NULL,
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "published_at_utc"          TIMESTAMPTZ(6),
  CONSTRAINT "trust_center_article_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trust_center_article_versions_article_fk"
    FOREIGN KEY ("article_id") REFERENCES "trust_center_articles" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "trust_center_article_versions_article_version_uniq"
  ON "trust_center_article_versions" ("article_id", "version");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='trust_center_article_versions'
                AND column_name='article_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_article_versions'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='trust_center_article_versions'
                    AND column_name='version') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "trust_center_article_versions_team_article_version_idx" ON "trust_center_article_versions" ("team_id", "article_id", "version")';
  END IF;
END $$;

-- =============================================================================
-- 3. subprocessors
-- =============================================================================
CREATE TABLE "subprocessors" (
  "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                  UUID         NOT NULL,
  "slug"                     VARCHAR(80)  NOT NULL,
  "name"                     VARCHAR(120) NOT NULL,
  "vendor"                   VARCHAR(120) NOT NULL,
  "purpose"                  VARCHAR(600) NOT NULL,
  "region"                   VARCHAR(80)  NOT NULL,
  "state"                    VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "version"                  INT          NOT NULL DEFAULT 1,
  "data_categories"          JSONB        NOT NULL,
  "documentation_url"        VARCHAR(400),
  "contract_ref"             VARCHAR(200),
  "change_history_summary"   VARCHAR(600) NOT NULL DEFAULT 'Initial registration',
  "effective_at_utc"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "subprocessors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subprocessors_team_slug_uniq"
  ON "subprocessors" ("team_id", "slug");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='subprocessors'
                AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='subprocessors'
                    AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "subprocessors_team_state_idx" ON "subprocessors" ("team_id", "state")';
  END IF;
END $$;

-- =============================================================================
-- 4. subprocessor_versions
-- =============================================================================
CREATE TABLE "subprocessor_versions" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "subprocessor_id"     UUID         NOT NULL,
  "version"             INT          NOT NULL,
  "change_summary"      VARCHAR(600) NOT NULL,
  "snapshot"            JSONB        NOT NULL,
  "authored_by_user_id" UUID,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "subprocessor_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subprocessor_versions_subprocessor_fk"
    FOREIGN KEY ("subprocessor_id") REFERENCES "subprocessors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "subprocessor_versions_subprocessor_version_uniq"
  ON "subprocessor_versions" ("subprocessor_id", "version");

-- =============================================================================
-- 5. status_components
-- =============================================================================
CREATE TABLE "status_components" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "key"                 VARCHAR(60)  NOT NULL,
  "label"               VARCHAR(120) NOT NULL,
  "description"         VARCHAR(600) NOT NULL,
  "health"              VARCHAR(40)  NOT NULL DEFAULT 'UNKNOWN',
  "upstream_source"     VARCHAR(40)  NOT NULL DEFAULT 'LOCAL',
  "upstream_reference"  VARCHAR(200),
  "last_updated_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "status_components_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "status_components_team_key_uniq"
  ON "status_components" ("team_id", "key");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='status_components'
                AND column_name='health')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='status_components'
                    AND column_name='team_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "status_components_team_health_idx" ON "status_components" ("team_id", "health")';
  END IF;
END $$;

-- =============================================================================
-- 6. status_incidents
-- =============================================================================
CREATE TABLE "status_incidents" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"         UUID         NOT NULL,
  "external_ref"    VARCHAR(120),
  "title"           VARCHAR(200) NOT NULL,
  "severity"        VARCHAR(20)  NOT NULL DEFAULT 'MINOR',
  "state"           VARCHAR(40)  NOT NULL DEFAULT 'INVESTIGATING',
  "component_keys"  JSONB        NOT NULL,
  "postmortem_url"  VARCHAR(400),
  "started_at_utc"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "resolved_at_utc" TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='status_incidents'
                AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='status_incidents'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='status_incidents'
                    AND column_name='started_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "status_incidents_team_state_started_idx" ON "status_incidents" ("team_id", "state", "started_at_utc" DESC)';
  END IF;
END $$;

-- =============================================================================
-- 7. status_incident_updates
-- =============================================================================
CREATE TABLE "status_incident_updates" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "incident_id"         UUID         NOT NULL,
  "body"                VARCHAR(2000) NOT NULL,
  "state"               VARCHAR(40)  NOT NULL,
  "authored_by_user_id" UUID,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "status_incident_updates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "status_incident_updates_incident_fk"
    FOREIGN KEY ("incident_id") REFERENCES "status_incidents" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='status_incident_updates'
                AND column_name='incident_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='status_incident_updates'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='status_incident_updates'
                    AND column_name='created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "status_incident_updates_team_incident_created_idx" ON "status_incident_updates" ("team_id", "incident_id", "created_at" DESC)';
  END IF;
END $$;

-- =============================================================================
-- 8. maintenance_windows
-- =============================================================================
CREATE TABLE "maintenance_windows" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"        UUID         NOT NULL,
  "title"          VARCHAR(200) NOT NULL,
  "description"    VARCHAR(2000) NOT NULL,
  "component_keys" JSONB        NOT NULL,
  "state"          VARCHAR(20)  NOT NULL DEFAULT 'SCHEDULED',
  "starts_at_utc"  TIMESTAMPTZ(6) NOT NULL,
  "ends_at_utc"    TIMESTAMPTZ(6) NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='maintenance_windows'
                AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='maintenance_windows'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='maintenance_windows'
                    AND column_name='starts_at_utc') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "maintenance_windows_team_state_idx" ON "maintenance_windows" ("team_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "maintenance_windows_team_starts_idx" ON "maintenance_windows" ("team_id", "starts_at_utc" DESC)';
  END IF;
END $$;

-- =============================================================================
-- 9. departments
-- =============================================================================
CREATE TABLE "departments" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"            UUID         NOT NULL,
  "organization_id"    UUID         NOT NULL,
  "name"               VARCHAR(200) NOT NULL,
  "slug"               VARCHAR(80)  NOT NULL,
  "state"              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_org_slug_uniq"
  ON "departments" ("organization_id", "slug");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='departments'
                AND column_name='organization_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='departments'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='departments'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "departments_team_org_state_idx" ON "departments" ("team_id", "organization_id", "state")';
  END IF;
END $$;

-- =============================================================================
-- 10. delegated_admin_grants
-- =============================================================================
CREATE TABLE "delegated_admin_grants" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "organization_id"     UUID         NOT NULL,
  "department_id"       UUID,
  "workspace_id"        UUID,
  "grantee_user_id"     UUID         NOT NULL,
  "tier"                VARCHAR(40)  NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "granted_by_user_id"  UUID         NOT NULL,
  "granted_at_utc"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at_utc"      TIMESTAMPTZ(6),
  "expires_at_utc"      TIMESTAMPTZ(6),
  CONSTRAINT "delegated_admin_grants_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='delegated_admin_grants'
                AND column_name='organization_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='delegated_admin_grants'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='delegated_admin_grants'
                    AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='delegated_admin_grants'
                    AND column_name='grantee_user_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='delegated_admin_grants'
                    AND column_name='tier') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "delegated_admin_grants_team_org_state_idx" ON "delegated_admin_grants" ("team_id", "organization_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "delegated_admin_grants_team_grantee_state_idx" ON "delegated_admin_grants" ("team_id", "grantee_user_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "delegated_admin_grants_team_tier_idx" ON "delegated_admin_grants" ("team_id", "tier")';
  END IF;
END $$;

-- =============================================================================
-- 11. governance_policies
-- =============================================================================
CREATE TABLE "governance_policies" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"             UUID         NOT NULL,
  "kind"                VARCHAR(40)  NOT NULL,
  "slug"                VARCHAR(80)  NOT NULL,
  "name"                VARCHAR(200) NOT NULL,
  "summary"             VARCHAR(600) NOT NULL,
  "state"               VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "enforcement_mode"    VARCHAR(20)  NOT NULL DEFAULT 'AUDIT_ONLY',
  "version"             INT          NOT NULL DEFAULT 1,
  "rule"                JSONB        NOT NULL,
  "created_by_user_id"  UUID         NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_policies_team_kind_slug_uniq"
  ON "governance_policies" ("team_id", "kind", "slug");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='governance_policies'
                AND column_name='kind')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policies'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policies'
                    AND column_name='state') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "governance_policies_team_kind_state_idx" ON "governance_policies" ("team_id", "kind", "state")';
  END IF;
END $$;

-- =============================================================================
-- 12. governance_policy_assignments
-- =============================================================================
CREATE TABLE "governance_policy_assignments" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"               UUID         NOT NULL,
  "policy_id"             UUID         NOT NULL,
  "scope"                 VARCHAR(40)  NOT NULL,
  "scope_target_id"       UUID         NOT NULL,
  "inherit_from_parent"   BOOLEAN      NOT NULL DEFAULT TRUE,
  "is_override"           BOOLEAN      NOT NULL DEFAULT FALSE,
  "assigned_by_user_id"   UUID         NOT NULL,
  "assigned_at_utc"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policy_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policy_assignments_policy_fk"
    FOREIGN KEY ("policy_id") REFERENCES "governance_policies" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "governance_policy_assignments_policy_scope_target_uniq"
  ON "governance_policy_assignments" ("policy_id", "scope", "scope_target_id");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='governance_policy_assignments'
                AND column_name='scope')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policy_assignments'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policy_assignments'
                    AND column_name='scope_target_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "governance_policy_assignments_team_scope_target_idx" ON "governance_policy_assignments" ("team_id", "scope", "scope_target_id")';
  END IF;
END $$;

-- =============================================================================
-- 13. governance_policy_audit
-- =============================================================================
CREATE TABLE "governance_policy_audit" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"          UUID         NOT NULL,
  "policy_id"        UUID         NOT NULL,
  "code"             VARCHAR(60)  NOT NULL,
  "actor_user_id"    UUID,
  "reason"           VARCHAR(600),
  "occurred_at_utc"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "governance_policy_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policy_audit_policy_fk"
    FOREIGN KEY ("policy_id") REFERENCES "governance_policies" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='governance_policy_audit'
                AND column_name='policy_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policy_audit'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policy_audit'
                    AND column_name='occurred_at_utc')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='governance_policy_audit'
                    AND column_name='code') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "governance_policy_audit_team_policy_occ_idx" ON "governance_policy_audit" ("team_id", "policy_id", "occurred_at_utc" DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "governance_policy_audit_team_code_occ_idx" ON "governance_policy_audit" ("team_id", "code", "occurred_at_utc" DESC)';
  END IF;
END $$;

-- =============================================================================
-- 14. access_review_campaigns
-- =============================================================================
CREATE TABLE "access_review_campaigns" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                UUID         NOT NULL,
  "kind"                   VARCHAR(40)  NOT NULL,
  "name"                   VARCHAR(200) NOT NULL,
  "state"                  VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  "organization_id"        UUID,
  "department_id"          UUID,
  "workspace_id"           UUID,
  "scheduled_start_utc"    TIMESTAMPTZ(6) NOT NULL,
  "scheduled_end_utc"      TIMESTAMPTZ(6) NOT NULL,
  "created_by_user_id"     UUID         NOT NULL,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "access_review_campaigns_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='access_review_campaigns'
                AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='access_review_campaigns'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='access_review_campaigns'
                    AND column_name='organization_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "access_review_campaigns_team_state_idx" ON "access_review_campaigns" ("team_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "access_review_campaigns_team_org_idx" ON "access_review_campaigns" ("team_id", "organization_id")';
  END IF;
END $$;

-- =============================================================================
-- 15. access_review_items
-- =============================================================================
CREATE TABLE "access_review_items" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"           UUID         NOT NULL,
  "campaign_id"       UUID         NOT NULL,
  "subject_user_id"   UUID         NOT NULL,
  "grant_ref"         VARCHAR(200) NOT NULL,
  "decision"          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "notes"             VARCHAR(2000),
  "reviewer_user_id"  UUID,
  "reviewed_at_utc"   TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "access_review_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_review_items_campaign_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "access_review_campaigns" ("id") ON DELETE CASCADE
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='access_review_items'
                AND column_name='campaign_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='access_review_items'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='access_review_items'
                    AND column_name='decision')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='access_review_items'
                    AND column_name='subject_user_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "access_review_items_team_campaign_decision_idx" ON "access_review_items" ("team_id", "campaign_id", "decision")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "access_review_items_team_subject_idx" ON "access_review_items" ("team_id", "subject_user_id")';
  END IF;
END $$;

-- =============================================================================
-- 16. cross_org_review_grants
-- =============================================================================
CREATE TABLE "cross_org_review_grants" (
  "id"                            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "team_id"                       UUID         NOT NULL,
  "inviting_organization_id"      UUID         NOT NULL,
  "invited_organization_id"       UUID,
  "invited_org_slug"              VARCHAR(120) NOT NULL,
  "external_review_grant_id"      UUID,
  "state"                         VARCHAR(20)  NOT NULL DEFAULT 'INVITED',
  "scope"                         VARCHAR(600) NOT NULL,
  "expires_at_utc"                TIMESTAMPTZ(6),
  "created_by_user_id"            UUID         NOT NULL,
  "created_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "cross_org_review_grants_pkey" PRIMARY KEY ("id")
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='cross_org_review_grants'
                AND column_name='state')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='cross_org_review_grants'
                    AND column_name='team_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='cross_org_review_grants'
                    AND column_name='inviting_organization_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "cross_org_review_grants_team_state_idx" ON "cross_org_review_grants" ("team_id", "state")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "cross_org_review_grants_team_inviting_state_idx" ON "cross_org_review_grants" ("team_id", "inviting_organization_id", "state")';
  END IF;
END $$;

COMMIT;
