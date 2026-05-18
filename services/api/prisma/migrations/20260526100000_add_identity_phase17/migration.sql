-- Phase 17 — Enterprise Identity & Access Platform
--
-- Forward-only additive migration:
--   * 6 new enums (TeamMemberStatus, DelegatedAdminScopeKind,
--     AccessReviewKind, AccessReviewStatus, AccessReviewSubjectKind,
--     ExternalIdentityProvider).
--   * 5 new tables (member_capability_grants,
--     member_delegated_admin_scopes, organization_security_policies,
--     access_reviews, external_identity_mappings).
--   * 12 additive columns on team_members for access lifecycle.
--   * 3 additive columns on workflow_intake_sessions for contributor
--     governance.
--   * 6 additive columns on api_credentials for service-account
--     hardening.
--   * No existing column altered; no row mutated.
--
-- All identity rows are WORKSPACE-INTERNAL by design. Public verify,
-- OTS, anchor, report-v2, and verification package paths NEVER read
-- these tables.
--
-- Rollback:
--   DROP TABLE IF EXISTS external_identity_mappings;
--   DROP TABLE IF EXISTS access_reviews;
--   DROP TABLE IF EXISTS organization_security_policies;
--   DROP TABLE IF EXISTS member_delegated_admin_scopes;
--   DROP TABLE IF EXISTS member_capability_grants;
--   ALTER TABLE api_credentials DROP COLUMN environment, DROP COLUMN ip_allowlist,
--     DROP COLUMN rotation_required, DROP COLUMN disabled_by_user_id,
--     DROP COLUMN disabled_at_utc, DROP COLUMN expires_at_utc;
--   ALTER TABLE workflow_intake_sessions DROP COLUMN last_seen_at_utc,
--     DROP COLUMN revoked_reason, DROP COLUMN revoked_by_user_id;
--   ALTER TABLE team_members DROP COLUMN last_seen_at_utc,
--     DROP COLUMN revocation_reason, DROP COLUMN revoked_by_user_id,
--     DROP COLUMN revoked_at_utc, DROP COLUMN suspension_reason,
--     DROP COLUMN suspended_by_user_id, DROP COLUMN suspended_at_utc,
--     DROP COLUMN access_expires_at_utc, DROP COLUMN access_reason,
--     DROP COLUMN access_granted_by_user_id, DROP COLUMN access_granted_at_utc,
--     DROP COLUMN status;
--   DROP TYPE  IF EXISTS "ExternalIdentityProvider";
--   DROP TYPE  IF EXISTS "AccessReviewSubjectKind";
--   DROP TYPE  IF EXISTS "AccessReviewStatus";
--   DROP TYPE  IF EXISTS "AccessReviewKind";
--   DROP TYPE  IF EXISTS "DelegatedAdminScopeKind";
--   DROP TYPE  IF EXISTS "TeamMemberStatus";

-- 1. New enums ------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "TeamMemberStatus" AS ENUM (
    'ACTIVE', 'SUSPENDED', 'REVOKED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DelegatedAdminScopeKind" AS ENUM (
    'GOVERNANCE_ADMIN',
    'REVIEW_ADMIN',
    'INTELLIGENCE_ADMIN',
    'INTEGRATION_ADMIN',
    'COLLABORATION_ADMIN',
    'IDENTITY_ADMIN',
    'RETENTION_ADMIN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AccessReviewKind" AS ENUM (
    'PERIODIC_MEMBER_REVIEW',
    'STALE_ACCESS',
    'UNUSED_SERVICE_ACCOUNT',
    'EXPIRING_TEMPORARY_ACCESS',
    'SUSPICIOUS_ACCESS_PATTERN',
    'EMERGENCY_REVOCATION_FOLLOWUP'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AccessReviewStatus" AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED_KEEP',
    'COMPLETED_REVOKED',
    'COMPLETED_SUSPENDED',
    'COMPLETED_NO_ACTION',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AccessReviewSubjectKind" AS ENUM (
    'TEAM_MEMBER', 'SERVICE_ACCOUNT', 'CONTRIBUTOR_SESSION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExternalIdentityProvider" AS ENUM (
    'GENERIC_SAML',
    'GENERIC_OIDC',
    'GENERIC_SCIM',
    'OKTA',
    'AZURE_AD',
    'GOOGLE_WORKSPACE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. team_members lifecycle columns --------------------------------------

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "status" "TeamMemberStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "access_granted_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "access_granted_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "access_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "access_expires_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "suspended_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "suspended_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "suspension_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "revoked_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "revocation_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "last_seen_at_utc" TIMESTAMPTZ(6);

DO $$ BEGIN
  ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_access_granted_by_user_id_fkey"
    FOREIGN KEY ("access_granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_suspended_by_user_id_fkey"
    FOREIGN KEY ("suspended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "team_members_team_id_status_idx"
  ON "team_members" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "team_members_access_expires_at_utc_idx"
  ON "team_members" ("access_expires_at_utc");

-- 3. workflow_intake_sessions governance columns --------------------------

ALTER TABLE "workflow_intake_sessions"
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "revoked_reason" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "last_seen_at_utc" TIMESTAMPTZ(6);

DO $$ BEGIN
  ALTER TABLE "workflow_intake_sessions"
    ADD CONSTRAINT "workflow_intake_sessions_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "workflow_intake_sessions_last_seen_at_utc_idx"
  ON "workflow_intake_sessions" ("last_seen_at_utc");

-- 4. api_credentials hardening columns ------------------------------------

ALTER TABLE "api_credentials"
  ADD COLUMN IF NOT EXISTS "expires_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "disabled_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "disabled_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "rotation_required" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "ip_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "environment" VARCHAR(32);

DO $$ BEGIN
  ALTER TABLE "api_credentials"
    ADD CONSTRAINT "api_credentials_disabled_by_user_id_fkey"
    FOREIGN KEY ("disabled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "api_credentials_expires_at_utc_idx"
  ON "api_credentials" ("expires_at_utc");
CREATE INDEX IF NOT EXISTS "api_credentials_disabled_at_utc_idx"
  ON "api_credentials" ("disabled_at_utc");

-- 5. member_capability_grants --------------------------------------------

CREATE TABLE IF NOT EXISTS "member_capability_grants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_member_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "permission" VARCHAR(96) NOT NULL,
  "reason" VARCHAR(400),
  "granted_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "granted_by_user_id" UUID NOT NULL,
  "expires_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "member_capability_grants_team_member_id_fkey"
    FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE CASCADE,
  CONSTRAINT "member_capability_grants_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "member_capability_grants_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "member_capability_grants_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "member_capability_grants_member_permission_uk"
  ON "member_capability_grants" ("team_member_id", "permission");
CREATE INDEX IF NOT EXISTS "member_capability_grants_team_permission_idx"
  ON "member_capability_grants" ("team_id", "permission");
CREATE INDEX IF NOT EXISTS "member_capability_grants_member_idx"
  ON "member_capability_grants" ("team_member_id");
CREATE INDEX IF NOT EXISTS "member_capability_grants_expires_at_utc_idx"
  ON "member_capability_grants" ("expires_at_utc");
CREATE INDEX IF NOT EXISTS "member_capability_grants_revoked_at_utc_idx"
  ON "member_capability_grants" ("revoked_at_utc");

-- 6. member_delegated_admin_scopes ---------------------------------------

CREATE TABLE IF NOT EXISTS "member_delegated_admin_scopes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_member_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "scope_kind" "DelegatedAdminScopeKind" NOT NULL,
  "reason" VARCHAR(400),
  "granted_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "granted_by_user_id" UUID NOT NULL,
  "expires_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revoked_reason" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "member_delegated_admin_scopes_team_member_id_fkey"
    FOREIGN KEY ("team_member_id") REFERENCES "team_members"("id") ON DELETE CASCADE,
  CONSTRAINT "member_delegated_admin_scopes_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "member_delegated_admin_scopes_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "member_delegated_admin_scopes_revoked_by_user_id_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "member_delegated_admin_scopes_member_scope_uk"
  ON "member_delegated_admin_scopes" ("team_member_id", "scope_kind");
CREATE INDEX IF NOT EXISTS "member_delegated_admin_scopes_team_scope_idx"
  ON "member_delegated_admin_scopes" ("team_id", "scope_kind");
CREATE INDEX IF NOT EXISTS "member_delegated_admin_scopes_member_idx"
  ON "member_delegated_admin_scopes" ("team_member_id");
CREATE INDEX IF NOT EXISTS "member_delegated_admin_scopes_expires_at_utc_idx"
  ON "member_delegated_admin_scopes" ("expires_at_utc");
CREATE INDEX IF NOT EXISTS "member_delegated_admin_scopes_revoked_at_utc_idx"
  ON "member_delegated_admin_scopes" ("revoked_at_utc");

-- 7. organization_security_policies --------------------------------------

CREATE TABLE IF NOT EXISTS "organization_security_policies" (
  "team_id" UUID PRIMARY KEY,
  "mfa_required_flag" BOOLEAN NOT NULL DEFAULT FALSE,
  "allowed_email_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "restricted_ip_ranges" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reviewer_session_timeout_seconds" INTEGER,
  "contributor_session_timeout_seconds" INTEGER,
  "sso_ready_flag" BOOLEAN NOT NULL DEFAULT FALSE,
  "scim_ready_flag" BOOLEAN NOT NULL DEFAULT FALSE,
  "notes" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_by_user_id" UUID,

  CONSTRAINT "organization_security_policies_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_security_policies_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

-- 8. access_reviews -------------------------------------------------------

CREATE TABLE IF NOT EXISTS "access_reviews" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "kind" "AccessReviewKind" NOT NULL,
  "status" "AccessReviewStatus" NOT NULL DEFAULT 'PENDING',
  "subject_kind" "AccessReviewSubjectKind" NOT NULL,
  "subject_user_id" UUID,
  "subject_api_credential_id" UUID,
  "subject_intake_session_id" UUID,
  "initiated_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "initiated_by_user_id" UUID,
  "due_at_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "completed_by_user_id" UUID,
  "decision_note" VARCHAR(2000),
  "context_snapshot_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "access_reviews_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "access_reviews_initiated_by_user_id_fkey"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "access_reviews_completed_by_user_id_fkey"
    FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "access_reviews_subject_user_id_fkey"
    FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "access_reviews_team_status_idx"
  ON "access_reviews" ("team_id", "status");
CREATE INDEX IF NOT EXISTS "access_reviews_team_kind_idx"
  ON "access_reviews" ("team_id", "kind");
CREATE INDEX IF NOT EXISTS "access_reviews_due_at_utc_idx"
  ON "access_reviews" ("due_at_utc");
CREATE INDEX IF NOT EXISTS "access_reviews_subject_user_id_idx"
  ON "access_reviews" ("subject_user_id");
CREATE INDEX IF NOT EXISTS "access_reviews_subject_api_credential_id_idx"
  ON "access_reviews" ("subject_api_credential_id");
CREATE INDEX IF NOT EXISTS "access_reviews_subject_intake_session_id_idx"
  ON "access_reviews" ("subject_intake_session_id");

-- 9. external_identity_mappings -------------------------------------------

CREATE TABLE IF NOT EXISTS "external_identity_mappings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" "ExternalIdentityProvider" NOT NULL,
  "external_subject_id" VARCHAR(320) NOT NULL,
  "display_name" VARCHAR(180),
  "external_email" VARCHAR(320),
  "linked_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "unlinked_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "external_identity_mappings_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "external_identity_mappings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "external_identity_mappings_provider_subject_uk"
  ON "external_identity_mappings" ("provider", "external_subject_id");
CREATE INDEX IF NOT EXISTS "external_identity_mappings_team_user_idx"
  ON "external_identity_mappings" ("team_id", "user_id");
CREATE INDEX IF NOT EXISTS "external_identity_mappings_user_idx"
  ON "external_identity_mappings" ("user_id");
CREATE INDEX IF NOT EXISTS "external_identity_mappings_unlinked_at_utc_idx"
  ON "external_identity_mappings" ("unlinked_at_utc");
