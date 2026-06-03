-- Phase 2 Drift Repair — Domain 2: Governance
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- Phase 2 four-stream inventory + synthesis (Stream B: Governance). Master
-- Drift Matrix rows 16-25 (10 ADDITIVE_SAFE items). Row 26
-- (AccessReviewEscalation) is IGNORE_INTENTIONAL_LEGACY: the model is absent
-- from schema.prisma so no migration is required.
--
-- ============================================================================
-- TABLES REPAIRED (3) — 10 new columns total
-- ============================================================================
--   * delegated_admin_grants          (+3 columns: organization_id,
--                                                  department_id, workspace_id)
--   * governance_policy_assignments   (+4 columns: scope, inherit_from_parent,
--                                                  is_override, assigned_by_user_id)
--   * governance_policy_audits        (+3 columns: code, reason, occurred_at_utc)
--
-- ============================================================================
-- HARD RULES (Phase 2 non-negotiables)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP / RENAME / DELETE / TRUNCATE / UPDATE on existing
--   rows. No SET NOT NULL or DROP NOT NULL on pre-existing columns.
-- * IDEMPOTENT. Every column add is `ADD COLUMN IF NOT EXISTS`.
-- * NULLABLE-FIRST. NOT NULL DEFAULT used only where the Prisma model
--   declares a `@default(...)` value (boolean defaults + occurred_at_utc).
--
-- ============================================================================
-- TABLE 1 — delegated_admin_grants (3 columns)
-- ============================================================================
-- Prisma model: DelegatedAdminGrant (organizationId, departmentId,
--                                    workspaceId — all optional scope keys).
-- Service callsite: services/api/src/services/governance/delegated-admin.service.ts.
-- These are alternative scope discriminators: a grant can target an org, a
-- department, or a workspace. Hence all three are nullable.
-- The 20270802 Sentry batch repair added `granted_to_user_id`, `scope_target_id`,
-- `created_at`, `updated_at` on this same table; the three scope-key columns
-- below are not covered by that or any subsequent migration.

ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;

ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "department_id" UUID;

ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "workspace_id" UUID;

-- ============================================================================
-- TABLE 2 — governance_policy_assignments (4 columns)
-- ============================================================================
-- Prisma model: GovernancePolicyAssignment (scope, inheritFromParent,
--                                           isOverride, assignedByUserId).
-- Service callsite: services/api/src/services/governance/governance-policy.service.ts.
-- `scope` is the assignment target classifier (ORG / DEPT / WORKSPACE / USER)
-- — nullable until set. `inheritFromParent` + `isOverride` carry boolean
-- semantics with Prisma `@default(false)` → NOT NULL DEFAULT FALSE.
-- `assigned_by_user_id` tracks who authored the assignment — nullable for
-- legacy / system-generated rows.

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(40);

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "inherit_from_parent" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "is_override" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "assigned_by_user_id" UUID;

-- ============================================================================
-- TABLE 3 — governance_policy_audits (3 columns)
-- ============================================================================
-- Prisma model: GovernancePolicyAudit (code, reason, occurredAtUtc).
-- Service callsite: services/api/src/services/governance/governance-policy.service.ts.
-- `code` + `reason` are nullable audit metadata. `occurred_at_utc` is the
-- canonical event timestamp; Prisma declares `@default(now())` so NOT NULL
-- DEFAULT NOW() atomically backfills existing rows during the ADD COLUMN.

ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "code" VARCHAR(80);

ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "reason" VARCHAR(400);

ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
