-- =============================================================================
-- 2026-11-01 — WORKFLOW-006 / WORKFLOW-007: each review carries the due-soon
-- window its deadlines were stamped with.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. A nullable column with no default, so
-- no row is rewritten. The reconcile sweep fills it for open rows as it stamps
-- them, counting the window from that moment, so no old row can breach on deploy.
--
-- Apply BEFORE the API and worker images: their Prisma client maps the column.
-- =============================================================================

ALTER TABLE "evidence_review_workflows"
  ADD COLUMN IF NOT EXISTS "sla_due_soon_hours" INTEGER;
