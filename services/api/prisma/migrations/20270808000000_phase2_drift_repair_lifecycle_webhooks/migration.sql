-- Phase 2 Drift Repair — Domain 7: Exchange / Packages / Webhooks
--
-- ============================================================================
-- AUDIT SOURCE
-- ============================================================================
-- Phase 2 four-stream inventory + synthesis (Stream D: Exchange / Lifecycle
-- Webhooks). Master Drift Matrix rows 47-51 (5 ADDITIVE_SAFE items across
-- the lifecycle webhook delivery surface).
--
-- ============================================================================
-- TABLES REPAIRED (2) — 5 new columns total
-- ============================================================================
--   * webhook_endpoints     (+1 column:  updated_at)
--   * webhook_deliveries    (+4 columns: updated_at, created_at,
--                                        next_retry_at, next_attempt_at_utc)
--
-- ============================================================================
-- HARD RULES (Phase 2 non-negotiables)
-- ============================================================================
-- * ADDITIVE-ONLY. No DROP / RENAME / DELETE / TRUNCATE / UPDATE on existing
--   rows. No SET NOT NULL or DROP NOT NULL on pre-existing columns.
-- * IDEMPOTENT. Every column add is `ADD COLUMN IF NOT EXISTS`.
-- * NULLABLE-FIRST. NOT NULL DEFAULT NOW() used only where Prisma declares
--   `@default(now())` (created_at) or `@updatedAt` (updated_at).
--
-- ============================================================================
-- TABLE 1 — webhook_endpoints (1 column)
-- ============================================================================
-- Prisma model: LifecycleWebhookEndpoint (updatedAt @updatedAt).
-- Service callsite: lifecycle webhook routes (endpoint CRUD).
-- `updated_at` is `@updatedAt` → NOT NULL DEFAULT NOW() so the ADD COLUMN
-- itself populates existing rows and future Prisma writes are non-null.

ALTER TABLE IF EXISTS "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

-- ============================================================================
-- TABLE 2 — webhook_deliveries (4 columns)
-- ============================================================================
-- Prisma model: LifecycleWebhookDelivery (updatedAt @updatedAt,
--                                         createdAt @default(now()),
--                                         nextRetryAt, nextAttemptAtUtc).
-- Service callsite: lifecycle webhook dispatcher (retry-loop + delivery log).
-- `created_at` + `updated_at` use Prisma defaults → NOT NULL DEFAULT NOW()
-- atomically backfills existing rows. `next_retry_at` + `next_attempt_at_utc`
-- are nullable schedule pointers populated only when a retry is queued.

ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "next_attempt_at_utc" TIMESTAMPTZ(6);
