-- Phase R7 Intelligence Schema Fix — additive, no NOT NULL promotions.
-- Aligns ProviderBudget Prisma model with the actual fields that
-- services/api/src/services/intelligence/provider-budget.service.ts reads/filters.
--
-- Phase 3B / Intelligence capabilities preserved (no NOT NULL transitions in this migration):
--   * Azure / Deepgram / OpenAI / Rekognition provider abstraction (unchanged at the
--     adapter layer; ProviderBudget.provider remains nullable for tenant-wide budgets)
--   * Correction lifecycle (ReviewerCorrection table unchanged)
--   * Executive trends (executive-metrics.service unchanged; consumes ProviderUsageEvent)
--   * Scoped budget enforcement (scope_target_id remains; gate filters by scope+target)
--   * Provider failure transparency (provider_health_records unchanged; provider error
--     payloads still surface via cost / executive / audit-transparency federators)
--   * Verification manifests (intelligence-verification-manifest.service unchanged)
--   * Report integration (intelligence-report-references unchanged)
--   * Audit transparency (audit-transparency-federator unchanged)
--   * Cost controls (provider-usage-event + provider-budget-alert unchanged; the new
--     `state` column STRENGTHENS gate enforcement — operators can DISABLE a budget
--     without deleting it, the gate respects state="ACTIVE" filter)
--
-- No DROP COLUMN. One additive column on provider_budgets.

BEGIN;

-- ---------------------------------------------------------------------------
-- ProviderBudget: additive `state` column.
-- WHY additive:
--   * The budget gate (decideBudgetGate) filters `where: { state: "ACTIVE" }` so
--     paused budgets do not block paid provider calls indefinitely. Without this
--     column the filter would fail at runtime; the service has read/filtered on
--     state since Phase 3B.
--   * The budget projection emits "DISABLED" / "EXHAUSTED" / "ACTIVE"; the
--     EXHAUSTED transition is computed dynamically from consumed >= hard, but
--     DISABLED / ACTIVE need to be persisted so operators can pause/resume.
-- DEFAULT: 'ACTIVE' — every legacy row continues to enforce its budget (no silent
-- bypass on rollout; preserves cost-control posture).
-- ENFORCEMENT unchanged: hardLimitUsdMicros + scopeTargetId scoping unchanged;
-- this column adds a lifecycle dimension on top of the existing limits.
-- ---------------------------------------------------------------------------

ALTER TABLE "provider_budgets"
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';

COMMIT;
