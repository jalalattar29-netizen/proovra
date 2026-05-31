-- Phase R7 Intelligence Schema Fix — HARDENED for partial-state safety.
-- Additive, no NOT NULL promotions on existing rows beyond DEFAULT.
-- Aligns ProviderBudget Prisma model with the actual fields that
-- services/api/src/services/intelligence/provider-budget.service.ts reads/filters.
--
-- Hardening rules applied:
--   * ALTER TABLE → IF EXISTS guard
--   * ADD COLUMN  → IF NOT EXISTS guard with NOT NULL DEFAULT (safe — DEFAULT
--     populates existing rows atomically; rerun is a Postgres-native no-op)
--
-- Capabilities preserved: Azure / Deepgram / OpenAI / Rekognition adapter,
-- correction lifecycle, executive trends, scoped budget enforcement, provider
-- failure transparency, verification manifests, report integration, audit
-- transparency, cost controls.

BEGIN;

-- ProviderBudget: additive `state` column (default 'ACTIVE').
ALTER TABLE IF EXISTS "provider_budgets"
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';

COMMIT;
