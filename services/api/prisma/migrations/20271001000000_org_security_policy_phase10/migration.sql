-- PHASE 10 (§10.1–§10.8, 2026-07-23) — advanced enterprise identity.
-- Extends the ONE canonical OrganizationSecurityPolicy aggregate + adds the
-- break-glass and support-access grant tables. AUTHORED, NOT APPLIED.

ALTER TABLE "organization_security_policies"
  ADD COLUMN "policy_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sso_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "managed_identity_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "no_personal_space" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "security_mode" VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "max_session_age_seconds" INTEGER,
  ADD COLUMN "idle_timeout_seconds" INTEGER,
  ADD COLUMN "concurrent_session_limit" INTEGER,
  ADD COLUMN "step_up_interval_seconds" INTEGER,
  ADD COLUMN "allowed_auth_methods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "emergency_access_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "emergency_user_id" UUID NOT NULL,
  "granted_role" VARCHAR(48) NOT NULL DEFAULT 'EMERGENCY_READ_ONLY',
  "reason" VARCHAR(600) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "requested_by_user_id" UUID NOT NULL,
  "step_up_proof_id" VARCHAR(128),
  "started_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  CONSTRAINT "emergency_access_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "emergency_access_grants_organization_id_status_idx" ON "emergency_access_grants"("organization_id", "status");
CREATE INDEX "emergency_access_grants_emergency_user_id_idx" ON "emergency_access_grants"("emergency_user_id");
ALTER TABLE "emergency_access_grants" ADD CONSTRAINT "emergency_access_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "support_access_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "support_user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "team_id" UUID,
  "reason" VARCHAR(600) NOT NULL,
  "access_level" VARCHAR(24) NOT NULL DEFAULT 'READ_ONLY',
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "approved_by_user_id" UUID,
  "started_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at_utc" TIMESTAMPTZ(6),
  CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_access_grants_organization_id_status_idx" ON "support_access_grants"("organization_id", "status");
CREATE INDEX "support_access_grants_support_user_id_status_idx" ON "support_access_grants"("support_user_id", "status");
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_support_user_id_fkey" FOREIGN KEY ("support_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
