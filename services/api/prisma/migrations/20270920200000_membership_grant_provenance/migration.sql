-- =============================================================================
-- PHASE 3 (2026-07-21) — normalized membership-grant provenance.
--
-- A user may hold the same membership through multiple sources (manual
-- assignment + IdP group + SCIM …). Each source is one grant row; revoking a
-- source revokes only that grant; the membership row is deactivated only
-- when no active grant remains (source-aware revocation, implemented in
-- services/identity/membership-provisioning.service.ts).
--
-- Additive only. No existing table/column is altered. Rollback = DROP TABLE
-- + DROP TYPE with zero data loss for pre-existing data.
--
-- NOTE (legacy rows): memberships created before this migration have no
-- grant rows. The orchestrator treats a membership with ZERO grant rows as
-- legacy-MANUAL for revocation purposes (documented compatibility rule,
-- removed after the provenance backfill in a later phase).
-- =============================================================================

CREATE TYPE "MembershipGrantSource" AS ENUM (
  'MANUAL',
  'INVITATION',
  'SSO_JIT',
  'SCIM',
  'IDP_GROUP',
  'ENTERPRISE_BOOTSTRAP',
  'SELF_SERVICE_OWNER',
  'SYSTEM_REPAIR',
  -- Backfilled marker for pre-provenance memberships (historical source
  -- unprovable). Source-scoped revocation can never remove it; only an
  -- explicit manual revocation can.
  'LEGACY_UNKNOWN'
);

CREATE TABLE "membership_grants" (
  "id"                         UUID NOT NULL DEFAULT gen_random_uuid(),
  "team_member_id"             UUID,
  "organization_membership_id" UUID,
  "source"                     "MembershipGrantSource" NOT NULL,
  "intent"                     VARCHAR(60) NOT NULL,
  "granted_by_user_id"         UUID,
  "external_ref"               VARCHAR(200),
  "granted_role"               VARCHAR(40),
  "revoked_at_utc"             TIMESTAMPTZ(6),
  "revoked_by_user_id"         UUID,
  "created_at"                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "membership_grants_pkey" PRIMARY KEY ("id"),
  -- Exactly one membership layer per grant.
  CONSTRAINT "membership_grants_one_layer_check" CHECK (
    ("team_member_id" IS NOT NULL) <> ("organization_membership_id" IS NOT NULL)
  )
);

CREATE INDEX "membership_grants_team_member_id_revoked_at_utc_idx"
  ON "membership_grants" ("team_member_id", "revoked_at_utc");
CREATE INDEX "membership_grants_organization_membership_id_revoked_at_ut_idx"
  ON "membership_grants" ("organization_membership_id", "revoked_at_utc");
CREATE INDEX "membership_grants_source_external_ref_idx"
  ON "membership_grants" ("source", "external_ref");
