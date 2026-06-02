-- Phase O — Sentry batch schema-drift repair (ADDITIVE + IDEMPOTENT).
--
-- ============================================================================
-- ROOT CAUSE
-- ============================================================================
-- 13 active Sentry issues were triaged in Phase 1 (audit). 9 of those were
-- canonical schema-drift: the `schema.prisma` declares columns that no
-- prior migration ever applied to the production DB (`prisma migrate
-- status` reports clean because it ONLY checks recorded migrations, NOT
-- schema-vs-DB equivalence). Every drifted query failed with P2022
-- "column X does not exist"; Prisma renders the column as
-- "(not available)" because it cannot reverse-map runtime SQL errors
-- to Prisma fields.
--
-- This migration is the ONE additive Phase O repair pass that closes
-- all 9 schema-drift items in a single deploy.
--
-- ============================================================================
-- HARD RULES (CONTRACT-ASSERTED BY phase-32-7-2 / phase-O guards)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP, no RENAME, no DELETE, no TRUNCATE,
--   no SET NOT NULL on pre-existing columns, no destructive type
--   conversions, no REVOKE.
-- * IDEMPOTENT. Every ADD COLUMN uses IF NOT EXISTS. Every backfill
--   UPDATE has `WHERE target IS NULL AND source IS NOT NULL`. Re-running
--   is a no-op.
-- * GUARDED. Every backfill UPDATE wraps in a PL/pgSQL DO block that
--   first verifies BOTH source and target columns exist (Phase O-Final
--   defense against `SQL 42703 column does not exist`).
-- * NULLABLE-FIRST FOR FOREIGN KEYS. New UUID columns intended as FKs
--   are added NULLABLE so backfill can populate from legacy columns
--   without violating constraints; we do NOT add the FK constraint
--   itself in this migration — Prisma's runtime equality checks do
--   not require an enforced FK at the DB level for reads to succeed.
-- * TIMESTAMP COLUMNS NEEDED BY @updatedAt USE `NOT NULL DEFAULT NOW()`.
--   The default backfills existing rows on column-add (safe); @updatedAt
--   at the Prisma level keeps the column fresh on every write.
-- * BOTH OLD AND NEW NAME COLUMNS COEXIST. For DelegatedAdminGrant
--   (`grantee_user_id` legacy → `granted_to_user_id` Prisma map) and
--   RedactionPolicyAssignment (`policy_version_id` legacy → `version_id`
--   Prisma map) we keep BOTH columns and deterministically backfill the
--   new one from the old. Dropping the legacy column is forbidden by
--   the stability rules and unnecessary for runtime correctness.
--
-- ============================================================================
-- DRIFT ITEMS COVERED (1:1 with Phase 1 audit Table 1)
-- ============================================================================
--   NODE-1R — evidence_exchange_packages.updated_at
--   NODE-1H — provider_budgets.archived_at
--   NODE-1Q — chain_transfers.updated_at
--   NODE-1N — redaction_policy_assignments.version_id (+ backfill)
--   NODE-1M — redaction_projects.closed_at_utc
--   NODE-1K — delegated_admin_grants.granted_to_user_id (+ backfill),
--             scope_target_id, created_at, updated_at
--   NODE-1E — status_components.updated_at
--   NODE-1J — subprocessors.category, country, description
--   NODE-1P — coding_schemas + coding_fields defensive R7 additive
--             columns (every R7 reviewer-workspace field re-asserted
--             with IF NOT EXISTS; root column cannot be pinpointed
--             from the Sentry payload, so the repair is defensive
--             across the whole R7 reviewer-workspace surface)
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. NODE-1R — evidence_exchange_packages.updated_at
-- ---------------------------------------------------------------------------
-- Prisma field `updatedAt @updatedAt @map("updated_at")`. The original
-- Phase 4B migration created only `created_at`; R7-catchup added other
-- lifecycle timestamps but never `updated_at`. Every `prisma.evidenceExchangePackage`
-- write (lifecycle / delivery / archive) currently fails with P2022.
-- NOT NULL DEFAULT NOW() backfills existing rows; @updatedAt keeps it
-- fresh on every subsequent write.
ALTER TABLE IF EXISTS "evidence_exchange_packages"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();


-- ---------------------------------------------------------------------------
-- 2. NODE-1Q — chain_transfers.updated_at
-- ---------------------------------------------------------------------------
-- Prisma field `updatedAt @updatedAt @map("updated_at")`. Same shape as
-- NODE-1R: original 4B migration omitted it; R7-catchup added responded_at_utc
-- and completed_at_utc but never updated_at. The readiness route reads
-- ChainTransfer and triggers P2022 on every poll.
ALTER TABLE IF EXISTS "chain_transfers"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();


-- ---------------------------------------------------------------------------
-- 3. NODE-1E — status_components.updated_at
-- ---------------------------------------------------------------------------
-- Prisma field `updatedAt @updatedAt @map("updated_at")`. Original 4A
-- trust migration created only `created_at` and `last_updated_at_utc`;
-- R7-trust-schema-fix promoted `last_updated_at_utc` to NOT NULL but never
-- added `updated_at`. Trust Center `statusComponent.upsert` fails on
-- every page-load with the canonical Sentry message verbatim
-- ("column updated_at does not exist").
ALTER TABLE IF EXISTS "status_components"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();


-- ---------------------------------------------------------------------------
-- 4. NODE-1H — provider_budgets.archived_at
-- ---------------------------------------------------------------------------
-- Prisma field `archivedAt @map("archived_at")` (NULLABLE in the model).
-- Original Phase 3B intelligence migration omitted it; R7-intelligence-schema-fix
-- only added `state`. The intelligence routes' budget projection reads
-- `archivedAt` for lifecycle display and fails with P2022.
ALTER TABLE IF EXISTS "provider_budgets"
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6);


-- ---------------------------------------------------------------------------
-- 5. NODE-1M — redaction_projects.closed_at_utc
-- ---------------------------------------------------------------------------
-- Prisma field `closedAtUtc @map("closed_at_utc")` (NULLABLE in the
-- model). Original Phase 3A redaction-platform migration omitted it
-- (only `archived_at` exists, which is no longer in the schema).
-- GET /v1/redaction/projects reads `closedAtUtc` for the lifecycle
-- column and triggers P2022.
ALTER TABLE IF EXISTS "redaction_projects"
  ADD COLUMN IF NOT EXISTS "closed_at_utc" TIMESTAMPTZ(6);


-- ---------------------------------------------------------------------------
-- 6. NODE-1J — subprocessors.category / country / description
-- ---------------------------------------------------------------------------
-- Prisma fields:
--   category  String  @default("PROVIDER") @db.VarChar(80)
--   country   String? @db.VarChar(80)
--   description String? @db.VarChar(800)
-- Original 4A trust migration omitted all three; R7-trust-schema-fix
-- attempted to set the default for `category` but never added the
-- column; R3-model-catchup's `CREATE TABLE IF NOT EXISTS` was a no-op
-- because 4A had already created the table.
-- `category` is NOT NULL DEFAULT 'PROVIDER' — the default backfills
-- existing rows so the NOT NULL constraint is satisfied on add.
ALTER TABLE IF EXISTS "subprocessors"
  ADD COLUMN IF NOT EXISTS "category"    VARCHAR(80) NOT NULL DEFAULT 'PROVIDER',
  ADD COLUMN IF NOT EXISTS "country"     VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "description" VARCHAR(800);


-- ---------------------------------------------------------------------------
-- 7. NODE-1N — redaction_policy_assignments.version_id (+ deterministic backfill)
-- ---------------------------------------------------------------------------
-- Prisma model: `policyVersionId String @map("version_id") @db.Uuid` —
-- the DB column the model expects is `version_id`. Original Phase 3A
-- Elite migration created `policy_version_id` instead and was never
-- aliased; R7-redaction-schema-fix added rationale + assigned_at_utc
-- but never renamed the column.
-- ADD nullable so backfill can populate before any FK constraint matters.
-- Backfill is deterministic 1:1 from the legacy `policy_version_id`
-- column. Both columns coexist; DROP is forbidden by stability rules.
ALTER TABLE IF EXISTS "redaction_policy_assignments"
  ADD COLUMN IF NOT EXISTS "version_id" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='redaction_policy_assignments'
       AND column_name='policy_version_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='redaction_policy_assignments'
       AND column_name='version_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "redaction_policy_assignments"
         SET "version_id" = "policy_version_id"
       WHERE "version_id" IS NULL
         AND "policy_version_id" IS NOT NULL
    $upd$;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 8. NODE-1K — delegated_admin_grants.granted_to_user_id (+ scope_target_id,
--               created_at, updated_at)
-- ---------------------------------------------------------------------------
-- Prisma model: `granteeUserId String @map("granted_to_user_id") @db.Uuid`
-- — the DB column the model expects is `granted_to_user_id`. Original
-- Phase 4A trust migration created `grantee_user_id` and omitted
-- `scope_target_id`, `created_at`, `updated_at`. R7-governance-schema-fix
-- only promoted `granted_at_utc` to NOT NULL.
-- Strategy:
--   * granted_to_user_id  — add nullable, backfill from grantee_user_id
--                            (1:1 deterministic), keep both columns.
--   * scope_target_id     — add nullable (Prisma field already nullable).
--   * created_at, updated_at — add NOT NULL DEFAULT NOW(); default
--                              backfills existing rows; @updatedAt
--                              keeps updated_at fresh on writes.
ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "granted_to_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "scope_target_id"    UUID,
  ADD COLUMN IF NOT EXISTS "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='delegated_admin_grants'
       AND column_name='grantee_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='delegated_admin_grants'
       AND column_name='granted_to_user_id'
  ) THEN
    EXECUTE $upd$
      UPDATE "delegated_admin_grants"
         SET "granted_to_user_id" = "grantee_user_id"
       WHERE "granted_to_user_id" IS NULL
         AND "grantee_user_id" IS NOT NULL
    $upd$;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 9. NODE-1P — coding_schemas + coding_fields defensive R7 surface re-assert
-- ---------------------------------------------------------------------------
-- POST /v1/coding/schemas/seed-defaults fails on production with an
-- unspecified column. R7-reviewer-workspace-schema-fix claims to have
-- added every column, but the audit could not pinpoint which one is
-- actually missing in production from the Sentry payload alone. The
-- defensive repair is to re-assert every Prisma-declared R7-additive
-- column on both tables with IF NOT EXISTS — pure no-op for any column
-- that already exists.
--
-- coding_schemas: status, label, category, published_at, archived_at,
--                 created_by_user_id, updated_at
-- coding_fields:  options, help_text, order_index, updated_at
ALTER TABLE IF EXISTS "coding_schemas"
  ADD COLUMN IF NOT EXISTS "status"             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "label"              VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "category"           VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "published_at"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "archived_at"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "coding_fields"
  ADD COLUMN IF NOT EXISTS "options"     JSONB,
  ADD COLUMN IF NOT EXISTS "help_text"   VARCHAR(800),
  ADD COLUMN IF NOT EXISTS "order_index" INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();


-- ---------------------------------------------------------------------------
-- End of migration. No indexes are added here — every drifted column
-- above is consumed by existing Prisma queries that match by primary
-- key or by already-indexed columns (teamId scope). Re-running this
-- migration is a no-op; deployment is safe even if production has
-- already received some of these columns via hand-rolled DDL.
-- ---------------------------------------------------------------------------
