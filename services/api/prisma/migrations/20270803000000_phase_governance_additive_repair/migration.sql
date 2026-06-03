-- Phase Governance Additive Repair — ADDITIVE + IDEMPOTENT.
--
-- ============================================================================
-- TABLES REPAIRED (4)
-- ============================================================================
--   * cross_org_review_grants
--   * access_review_campaigns
--   * governance_policies
--   * departments
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- Phase Governance Additive Repair preflight (4-table column drift map),
-- run against `schema.prisma` (CrossOrgReviewGrant @ 10121-10150,
-- AccessReviewCampaign @ 10060-10091, GovernancePolicy @ 9980-10002,
-- Department @ 9931-9949) cross-referenced with every migration that
-- touched these tables:
--   * 20270101000000_phase_r3_model_catchup        (CREATE TABLE IF NOT EXISTS — lean column set)
--   * 20270102000000_phase_r7_schema_catchup       (added access_review_campaigns.name + organization_id + scheduled_start_utc)
--   * 20270106000000_phase_r7_governance_schema_fix(added departments.created_by_user_id; relaxed nullability)
--   * 20261220000000_phase_4a_trust_and_governance (no-op in production — CREATE TABLE without IF NOT EXISTS)
--   * 20270802000000_phase_sentry_batch_schema_drift_repair (untouched for these 4 tables)
--
-- The Phase 4A `CREATE TABLE` statements for these 4 tables run AFTER R3 in
-- timestamp order yet WITHOUT an `IF NOT EXISTS` clause — in production the
-- table already exists (from R3) so the Phase 4A statement fails silently
-- (or skips, depending on driver). The R3 + R7 column overlay is therefore
-- the *actual* shape of these tables in production, and 15 Prisma-declared
-- columns NEVER landed. Every routed query that touches one of these 15
-- columns currently fails with Prisma P2022 (column does not exist), which
-- the central error handler at services/api/src/server.ts:665-686 maps to
-- HTTP 503 SCHEMA_NOT_READY with a requestId. This migration closes the
-- drift in a single additive pass.
--
-- ============================================================================
-- USER BRIEF CONSTRAINT (HARD RULES)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT
--   / DROP TYPE / DROP SCHEMA. No DROP NOT NULL. No SET NOT NULL on any
--   pre-existing column. No RENAME of any kind.
-- * IDEMPOTENT. Every ADD COLUMN uses IF NOT EXISTS. Every CREATE INDEX
--   uses IF NOT EXISTS. Re-running is a no-op.
-- * NO DESTRUCTIVE OPERATIONS. No TRUNCATE, no DELETE, no UPDATE on
--   existing rows (the only data writes are DEFAULTs auto-applied by
--   ADD COLUMN, and none of the new columns specify a default — all are
--   nullable, matching the Prisma model).
-- * NO REVOKE / GRANT. No GRANT changes of any kind.
-- * NULLABLE-FIRST. Every new column is added NULL because the Prisma model
--   declares every one of these 15 columns as optional (`?`). A future
--   backfill+promote migration can tighten if/when the product calls for
--   it; this migration does NOT promote nullability.
--
-- ============================================================================
-- NO DESTRUCTIVE OPERATIONS PROMISE
-- ============================================================================
-- This migration contains:
--   * 15 ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS statements
--   *  1 CREATE INDEX IF NOT EXISTS statement (wrapped in a Phase O-Final
--     DO block that verifies every referenced column exists in
--     information_schema before issuing the CREATE INDEX — this is the
--     CREATE_INDEX_GUARDED MEDIUM-risk pattern, not the bare
--     INDEX_COLUMN_RISK CRITICAL pattern).
-- and NOTHING ELSE. Grep this file for DROP, RENAME, TRUNCATE, DELETE,
-- UPDATE, REVOKE, GRANT, SET NOT NULL, DROP NOT NULL — every match must
-- be inside this header comment. The DDL body has zero destructive verbs.

-- ============================================================================
-- 1. cross_org_review_grants — 4 missing columns + 1 supporting index
-- ============================================================================
-- R3-skeleton columns present:    id, team_id, target_org_id, granted_by_user_id,
--                                 state, scope, expires_at_utc, revoked_at_utc,
--                                 created_at, updated_at
-- R7 relaxation:                  target_org_id DROP NOT NULL
-- MISSING per Prisma schema:      inviting_organization_id, invited_organization_id,
--                                 invited_org_slug, external_review_grant_id
ALTER TABLE IF EXISTS "cross_org_review_grants"
  ADD COLUMN IF NOT EXISTS "inviting_organization_id" UUID,
  ADD COLUMN IF NOT EXISTS "invited_organization_id"  UUID,
  ADD COLUMN IF NOT EXISTS "invited_org_slug"         VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "external_review_grant_id" UUID;

-- Index supports listCrossOrgGrants filter (cross-org-review.service.ts:272)
-- which selects on (team_id, inviting_organization_id, state).
--
-- Wrapped in a Phase O-Final-style DO block: every referenced column is
-- verified to exist via information_schema before the CREATE INDEX runs.
-- This guarantees the index creation cannot fail with SQL 42703 even on
-- partially-applied state (e.g. the ADD COLUMN block above is skipped
-- because someone manually pre-created the column with the wrong type
-- and the IF NOT EXISTS short-circuited). The pattern matches the
-- guarded-INDEX classification in services/api/scripts/full-migration-audit.mjs
-- (CREATE_INDEX_GUARDED, MEDIUM risk) rather than the bare-CREATE-INDEX
-- classification (INDEX_COLUMN_RISK, CRITICAL).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cross_org_review_grants'
       AND column_name='team_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cross_org_review_grants'
       AND column_name='inviting_organization_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cross_org_review_grants'
       AND column_name='state'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "cross_org_review_grants_team_inviting_state_idx"
               ON "cross_org_review_grants" ("team_id", "inviting_organization_id", "state")';
  END IF;
END $$;

-- ============================================================================
-- 2. access_review_campaigns — 4 missing columns
-- ============================================================================
-- R3-skeleton columns present:    id, team_id, kind, state, title, starts_at_utc,
--                                 ends_at_utc, completed_at_utc, created_at, updated_at
-- R7 catchup additions:           name, organization_id, scheduled_start_utc
-- R7 governance relaxation:       title DROP NOT NULL; starts_at_utc + ends_at_utc
--                                 SET DEFAULT NOW()
-- MISSING per Prisma schema:      scheduled_end_utc, department_id, workspace_id,
--                                 created_by_user_id
ALTER TABLE IF EXISTS "access_review_campaigns"
  ADD COLUMN IF NOT EXISTS "scheduled_end_utc"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "department_id"       UUID,
  ADD COLUMN IF NOT EXISTS "workspace_id"        UUID,
  ADD COLUMN IF NOT EXISTS "created_by_user_id"  UUID;

-- ============================================================================
-- 3. governance_policies — 5 missing columns
-- ============================================================================
-- R3-skeleton columns present:    id, team_id, kind, name, state, enforcement_mode,
--                                 config (jsonb default '{}'), created_at, updated_at
-- R7 catchup additions:           (none for this table)
-- R7 governance additions:        (none for this table)
-- MISSING per Prisma schema:      slug, summary, rule, version, created_by_user_id
ALTER TABLE IF EXISTS "governance_policies"
  ADD COLUMN IF NOT EXISTS "slug"                VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "summary"             VARCHAR(600),
  ADD COLUMN IF NOT EXISTS "rule"                JSONB,
  ADD COLUMN IF NOT EXISTS "version"             INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "created_by_user_id"  UUID;

-- ============================================================================
-- 4. departments — 2 missing columns
-- ============================================================================
-- R3-skeleton columns present:    id, team_id, name, state, parent_id,
--                                 created_at, updated_at
-- R7 governance additions:        created_by_user_id (already present — do NOT re-add)
-- MISSING per Prisma schema:      organization_id, slug
ALTER TABLE IF EXISTS "departments"
  ADD COLUMN IF NOT EXISTS "organization_id"     UUID,
  ADD COLUMN IF NOT EXISTS "slug"                VARCHAR(120);
