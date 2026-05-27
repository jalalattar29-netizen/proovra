-- =============================================================================
-- Phase 2.7X Stage 1 — Additive Organization domain.
--
-- This migration introduces the Organization tenant boundary as an
-- ADDITIVE-ONLY change. All new tables. New `organization_id` FK on
-- `teams` is nullable so existing rows remain valid. No data is
-- mutated, no columns are dropped, no enums are reshaped.
--
-- Stage 1 acceptance:
--   - `Organization`, `OrganizationMembership`, `OrganizationInvite`,
--     `OrganizationAuditEvent`, `OrganizationPolicy` models created.
--   - `teams.organization_id` column added as nullable UUID with
--     `ON DELETE SET NULL` to preserve evidence isolation on org
--     deletion.
--   - `OrganizationStatus` and `OrganizationRole` enums created.
--   - `OrganizationVerificationState` enum is REUSED (already present
--     in DB from earlier phases — not recreated).
--
-- Subsequent stages (do NOT touch in this migration):
--   - Stage 2: backfill personal-team -> org-of-1 promotion
--   - Stage 3: dual-read endpoints accepting either tenant key
--   - Stage 4: frontend org surface
--   - Stage 5: tighten constraints (NOT NULL where appropriate)
--   - Stage 6: destructive removal of any deprecated columns
--
-- Phase 2.5C wrapper + Phase 2.5D in-process hook + Phase 2.5E
-- preflight verified host classification = LOCAL before this file
-- was applied. This migration was generated via `prisma migrate
-- diff` and trimmed to additive-only sections; the broader diff
-- contained pre-existing DB-vs-schema drift unrelated to Stage 1
-- (deleted models still in DB) which is a separate cleanup item.
-- =============================================================================

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('ORG_OWNER', 'ORG_ADMIN', 'ORG_SECURITY_ADMIN', 'ORG_BILLING_ADMIN', 'ORG_AUDITOR', 'ORG_MEMBER');

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "organization_id" UUID;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(180) NOT NULL,
    "legal_name" VARCHAR(180),
    "legal_email" VARCHAR(320),
    "address" TEXT,
    "timezone" VARCHAR(64),
    "logo_url" VARCHAR(512),
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "billing_owner_user_id" UUID,
    "verification_state" "OrganizationVerificationState",
    "verified_at_utc" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'ORG_MEMBER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "last_resent_at" TIMESTAMPTZ(6),
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "event_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "last_updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_idx" ON "organization_memberships"("user_id");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_role_idx" ON "organization_memberships"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invites_token_key" ON "organization_invites"("token");

-- CreateIndex
CREATE INDEX "organization_invites_organization_id_idx" ON "organization_invites"("organization_id");

-- CreateIndex
CREATE INDEX "organization_invites_email_idx" ON "organization_invites"("email");

-- CreateIndex
CREATE INDEX "organization_audit_events_organization_id_created_at_idx" ON "organization_audit_events"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "organization_audit_events_event_type_idx" ON "organization_audit_events"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "organization_policies_organization_id_key_key" ON "organization_policies"("organization_id", "key");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_events" ADD CONSTRAINT "organization_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
