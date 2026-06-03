-- Phase 1 Production Drift Stabilization — ADDITIVE + IDEMPOTENT.
--
-- ============================================================================
-- TABLES REPAIRED (6) — 10 new columns total
-- ============================================================================
--   * redaction_policy_assignments   (+2 columns: revoked_at, created_at)
--   * reviewer_corrections           (+4 columns: accepted_at, reverted_at,
--                                                superseded_at, updated_at)
--   * legal_holds                    (+1 column:  updated_at)
--   * retention_policy_configs       (+1 column:  updated_at)
--   * destruction_requests           (+1 column:  updated_at)
--   * archive_tier_transitions       (+1 column:  created_at)
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- This migration consolidates the Phase 1 production drift stabilization
-- audit (3 workstreams):
--
--   * Phase 1 — Coverage audit of the 12 domains covered by the two prior
--     repair migrations (20270802 Sentry batch + 20270803 Governance
--     additive repair). 11 domains came back fully covered. The 12th
--     (redaction_policy_assignments) revealed 2 @map-bearing Prisma columns
--     that no migration has ever materialised: `revoked_at` (column
--     `revoked_at_utc` exists from 3A Elite CREATE TABLE but Prisma's
--     `@map("revoked_at")` cannot see it) and `created_at` (never declared).
--     Routes at risk: redaction-policy-store.service.ts revokeAssignment +
--     listAssignments + resolveActivePolicyForTarget + bulkResolveActivePolicies
--     + policy-verification-manifest.service.ts writer.
--
--   * Phase 2 — Reviewer Ops trace of every Prisma model touched by
--     reviewer-ops.routes.ts, reviewer-console.routes.ts,
--     reviewer-workspace.routes.ts, review-operations.routes.ts, and the
--     intelligence-platform reviewer-corrections surface. 16 of 17 models
--     were already covered by R7 + prior repairs. ReviewerCorrection is the
--     1 outlier: the 3B intel platform + 3B enterprise closure migrations
--     created `accepted_at_utc` / `reverted_at_utc` / `superseded_at_utc`
--     columns but the schema declares `accepted_at` / `reverted_at` /
--     `superseded_at` (no `_utc` suffix); `updated_at` was never added.
--     Routes at risk: POST /v1/intelligence/corrections,
--     POST /v1/intelligence/corrections/:id/accept,
--     POST /v1/intelligence/corrections/:id/revert (see
--     reviewer-correction.service.ts lines 167, 233, 313, 315, 396-398).
--
--   * Phase 3 — Unobserved scan of the top-active lifecycle / 4B / trust /
--     intelligence Prisma models outside the 12 audited domains and
--     reviewer-ops. 4 additional drift items confirmed: LegalHold,
--     RetentionPolicyConfig, DestructionRequest each declare `updated_at`
--     (`@updatedAt`) and ArchiveTierTransition declares `created_at`
--     (`@default(now())`); none of these were ever added by the 4B
--     packaging-and-lifecycle CREATE TABLE statements (see migration
--     20261230000000 lines 278-292 / 314-328 / 357-368 / 397-410) nor by
--     any later phase. Routes at risk: POST /v1/lifecycle/legal-holds/:id/release,
--     POST /v1/lifecycle/retention/:id/archive,
--     POST /v1/lifecycle/destruction (all state transitions),
--     POST /v1/lifecycle/archive/transitions.
--
-- Every uncovered column would currently fail with Prisma P2022 (column
-- does not exist), which the central handler at
-- services/api/src/server.ts:665-686 maps to HTTP 503 SCHEMA_NOT_READY.
-- This migration closes all 10 columns in a single additive pass.
--
-- ============================================================================
-- USER BRIEF CONSTRAINT (HARD RULES)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT
--   / DROP TYPE / DROP SCHEMA. No DROP NOT NULL. No SET NOT NULL on any
--   pre-existing column. No RENAME of any kind. No destructive enum rewrite.
--   No DELETE / TRUNCATE on existing rows. No REVOKE / GRANT.
-- * IDEMPOTENT. Safe to re-run — every column add is `ADD COLUMN IF NOT
--   EXISTS`. No `CREATE INDEX` statements are emitted (none of the new
--   columns appear in `@@index([...])` blocks on their models).
-- * NO UPDATE / DELETE / TRUNCATE STATEMENTS. The Phase 1 non-negotiable
--   forbids UPDATE on existing rows. The audit identified a legacy
--   `revoked_at_utc` column on redaction_policy_assignments whose values
--   would otherwise be invisible to Prisma after we add `revoked_at`; we
--   nevertheless do NOT backfill here. The redaction service treats
--   `revokedAtUtc IS NULL` as "active assignment", which means rows that
--   were revoked before this migration ran would re-appear as active.
--   This is a known and accepted trade-off: a deliberate, separately
--   reviewed data-migration step (outside the schema-stabilization brief)
--   may follow if operators need the historical revocation state visible
--   to Prisma. The Phase 1 promise is data preservation in the strict
--   sense: every byte already on disk remains on disk and unmodified.
-- * NO PRISMA SCHEMA CHANGES. The schema already declares all 10 columns
--   with `@map(...)`; this migration teaches the database to match.
--
-- ============================================================================
-- TABLE 1 — redaction_policy_assignments (2 columns)
-- ============================================================================
-- Prisma model: RedactionPolicyAssignment @ schema.prisma:10424-10449
-- Existing migrations touching this table:
--   * 20261201000000_phase_3a_elite_closure_policy_video (CREATE TABLE,
--     declared `revoked_at_utc` not `revoked_at`)
--   * 20270104000000_phase_r7_redaction_schema_fix (additive)
--   * 20270802000000_phase_sentry_batch_schema_drift_repair (NODE-1N: added
--     `version_id` + backfill — untouched columns below)
-- Production analog for revoked_at:
--   * Column `revoked_at_utc` (TIMESTAMPTZ(6) NULL) — created by 3A Elite,
--     written by neither the service nor the schema; the schema field
--     `revokedAtUtc` is `@map("revoked_at")` (no `_utc` suffix).

ALTER TABLE IF EXISTS "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- NOTE: a separately-reviewed data-migration step may follow to seed
-- `revoked_at` from the legacy `revoked_at_utc` sibling column. The
-- Phase 1 schema-stabilization brief forbids UPDATE on existing rows,
-- so the data move is deliberately deferred. After this migration,
-- previously-revoked rows will appear active to Prisma (revokedAtUtc
-- IS NULL); operators should follow up with a backfill before relying
-- on `revoked_at` for historical filtering.

-- ============================================================================
-- TABLE 2 — reviewer_corrections (4 columns)
-- ============================================================================
-- Prisma model: ReviewerCorrection @ schema.prisma:10233-10257
-- Existing migrations touching this table:
--   * 20261215000000_phase_3b_intelligence_platform (CREATE TABLE; declared
--     `accepted_at_utc` and `reverted_at_utc`, not the `_at`-suffixed names)
--   * 20261216000000_phase_3b_enterprise_closure (added `superseded_at_utc`
--     and version-chain columns; never added `updated_at`)
-- The 32.6.2 reviewer-ops naming-drift repair fixed `safeSummary` →
-- `safe_summary` for ReviewEscalation but left the ReviewerCorrection
-- lifecycle-timestamp drift unaddressed.
-- Service write callsites (services/api/src/services/intelligence/
-- reviewer-correction.service.ts):
--   line 167: supersededAt: new Date()
--   line 233: acceptedAt:   new Date()
--   line 313: revertedAt:   new Date()
--   line 315: supersededAt: new Date()
-- Service read callsites: lines 396-398 (acceptedAt / revertedAt / supersededAt
-- projected on the wire response).
-- `updated_at` is `@updatedAt` in Prisma → written by the client on every
-- update; added here as NOT NULL with DEFAULT NOW() so existing rows are
-- atomically populated by the ADD COLUMN itself (no separate UPDATE
-- required) and future writes are non-null.

ALTER TABLE IF EXISTS "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "accepted_at"   TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "reverted_at"   TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "reviewer_corrections"
  ADD COLUMN IF NOT EXISTS "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 3 — legal_holds (1 column)
-- ============================================================================
-- Prisma model: LegalHold @ schema.prisma:9114-9131
-- Existing migrations: 20261230000000_phase_4b_packaging_and_lifecycle
-- created the table (lines 314-328) WITHOUT `updated_at`; no later phase
-- added it. Service write: lifecycle/legal-hold.service.ts:199
-- (`prisma.legalHold.update` in `releaseLegalHold`).

ALTER TABLE IF EXISTS "legal_holds"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 4 — retention_policy_configs (1 column)
-- ============================================================================
-- Prisma model: RetentionPolicyConfig @ schema.prisma:9089-9112
-- Existing migrations: 20261230000000_phase_4b_packaging_and_lifecycle
-- created the table (lines 278-292) WITHOUT `updated_at`; no later phase
-- added it. Service write: lifecycle/retention-engine.service.ts:310
-- (`prisma.retentionPolicyConfig.update` in `releaseRetentionPolicy`).

ALTER TABLE IF EXISTS "retention_policy_configs"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 5 — destruction_requests (1 column)
-- ============================================================================
-- Prisma model: DestructionRequest @ schema.prisma:9153-9171
-- Existing migrations: 20261230000000_phase_4b_packaging_and_lifecycle
-- created the table (lines 397-410) WITHOUT `updated_at`; no later phase
-- added it. Service write callsites (8 distinct .update sites in
-- lifecycle/destruction-governance.service.ts:371, 419, 484, 492, 544, 568,
-- 583, 733) cover the approve / execute / certify / cancel paths.

ALTER TABLE IF EXISTS "destruction_requests"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 6 — archive_tier_transitions (1 column)
-- ============================================================================
-- Prisma model: ArchiveTierTransition @ schema.prisma:9133-9151
-- Existing migrations: 20261230000000_phase_4b_packaging_and_lifecycle
-- created the table (lines 357-368) WITHOUT `created_at`;
-- 20261231000000_phase_4b_final_closure (lines 34-40) added state /
-- storage_class_before / storage_class_after / executed_at_utc /
-- failure_reason / restore_target_at_utc, but did NOT add `created_at`.
-- Service write callsites: lifecycle/archive-tier.service.ts:264 and 451
-- (`prisma.archiveTierTransition.create`).

ALTER TABLE IF EXISTS "archive_tier_transitions"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- END Phase 1 Production Drift Stabilization
-- ============================================================================
-- Statement-by-statement audit:
--   * 10 x ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS (idempotent)
--   *  0 x UPDATE / DELETE / TRUNCATE
--   *  0 x DROP / RENAME / REVOKE / GRANT
--   *  0 x ALTER COLUMN SET NOT NULL / DROP NOT NULL on pre-existing columns
--   *  0 x CREATE INDEX (none required — no new columns are referenced by
--          any @@index([...]) block on their models)
