-- Phase 2 Drift Repair — Domain 1: Trust / Status / Subprocessors
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- Phase 2 four-stream inventory + synthesis (Stream A: Trust). Master Drift
-- Matrix rows 1-15. Confirms 15 Prisma-declared columns across 6 tables that
-- have no production materialization. Every column maps to a live service
-- read/write callsite that would otherwise return Prisma P2022 → HTTP 503
-- SCHEMA_NOT_READY per services/api/src/server.ts:665-686.
--
-- ============================================================================
-- TABLES REPAIRED (6) — 15 new columns total
-- ============================================================================
--   * trust_center_article_versions  (+1 column: published_at_utc)
--   * subprocessor_versions          (+2 columns: team_id, effective_at_utc)
--   * status_incidents               (+4 columns: external_ref, component_keys,
--                                                postmortem_url, updated_at)
--   * status_incident_updates        (+1 column: team_id)
--   * maintenance_windows            (+5 columns: team_id, state, description,
--                                                component_keys, updated_at)
--   * security_claim_checks          (+2 columns: created_at, updated_at)
--
-- ============================================================================
-- HARD RULES (Phase 2 non-negotiables)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT
--   / DROP TYPE / DROP SCHEMA. No DROP NOT NULL. No SET NOT NULL on any
--   pre-existing column. No RENAME of any kind. No destructive enum rewrite.
--   No DELETE / TRUNCATE / UPDATE on existing rows.
-- * IDEMPOTENT. Safe to re-run — every column add is `ADD COLUMN IF NOT
--   EXISTS`.
-- * NULLABLE-FIRST. `NOT NULL DEFAULT NOW()` is reserved for columns whose
--   Prisma model declares `@default(now())` or `@updatedAt`; the default
--   atomically backfills existing rows during the ADD COLUMN itself.
-- * NO PRISMA SCHEMA CHANGES. The schema already declares every column with
--   the correct `@map(...)`; this migration teaches the database to match.
--
-- ============================================================================
-- TABLE 1 — trust_center_article_versions (1 column)
-- ============================================================================
-- Prisma model: TrustCenterArticleVersion (publishedAtUtc @map("published_at_utc"))
-- Service callsite: services/api/src/services/trust/trust-center.service.ts
--                   :listTrustArticleVersions (orderBy publishedAtUtc).
-- Nullable: a version may be drafted without publication.

ALTER TABLE IF EXISTS "trust_center_article_versions"
  ADD COLUMN IF NOT EXISTS "published_at_utc" TIMESTAMPTZ(6);

-- ============================================================================
-- TABLE 2 — subprocessor_versions (2 columns)
-- ============================================================================
-- Prisma model: SubprocessorVersion (teamId @map("team_id"),
--                                    effectiveAtUtc @map("effective_at_utc"))
-- Service callsite: services/api/src/services/trust/subprocessor.service.ts
--                   :upsertSubprocessor (writes teamId + effectiveAtUtc).
-- Both nullable: teamId is optional collaboration link; effectiveAtUtc is
-- optional until the version is activated.

ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "effective_at_utc" TIMESTAMPTZ(6);

-- ============================================================================
-- TABLE 3 — status_incidents (4 columns)
-- ============================================================================
-- Prisma model: StatusIncident (externalRef, componentKeys, postmortemUrl,
--                               updatedAt @updatedAt).
-- Service callsite: services/api/src/services/trust/status-page.service.ts.
-- `updated_at` is `@updatedAt` → NOT NULL DEFAULT NOW() so the ADD COLUMN
-- itself populates existing rows and future Prisma writes are non-null.
-- External integrations (Better Stack) write external_ref + postmortem_url
-- via the Status Page sync path.

ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR(200);

ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "component_keys" JSONB;

ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "postmortem_url" VARCHAR(600);

ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 4 — status_incident_updates (1 column)
-- ============================================================================
-- Prisma model: StatusIncidentUpdate (teamId @map("team_id")).
-- Service callsite: services/api/src/services/trust/status-page.service.ts
--                   lines 150, 186 (team-scoped incident update reads).

ALTER TABLE IF EXISTS "status_incident_updates"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

-- ============================================================================
-- TABLE 5 — maintenance_windows (5 columns)
-- ============================================================================
-- Prisma model: MaintenanceWindow (teamId, state, description, componentKeys,
--                                  updatedAt @updatedAt).
-- Service callsite: services/api/src/services/trust/status-page.service.ts
--                   :listMaintenance / :upsertMaintenance.
-- `updated_at` is `@updatedAt` → NOT NULL DEFAULT NOW() so the ADD COLUMN
-- itself populates existing rows.

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20);

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "description" VARCHAR(600);

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "component_keys" JSONB;

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 6 — security_claim_checks (2 columns)
-- ============================================================================
-- Prisma model: SecurityClaimCheck (createdAt @default(now()),
--                                   updatedAt @updatedAt).
-- Service callsite: services/api/src/services/trust/security-claim-check.service.ts.
-- Both are time-stamps with deterministic defaults → NOT NULL DEFAULT NOW()
-- atomically backfills the existing rows during the ADD COLUMN itself.

ALTER TABLE IF EXISTS "security_claim_checks"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "security_claim_checks"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
