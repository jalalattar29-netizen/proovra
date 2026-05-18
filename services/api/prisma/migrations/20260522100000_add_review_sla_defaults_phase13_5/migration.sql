-- Phase 13.5 — Workspace-policy review SLA default foundation
--
-- Forward-only additive migration:
--   * Three optional integer-hour columns on workspace_governance_policies.
--   * Null defaults preserve existing creation behavior exactly.
--
-- Rollback:
--   ALTER TABLE workspace_governance_policies
--     DROP COLUMN IF EXISTS default_review_due_hours,
--     DROP COLUMN IF EXISTS default_first_response_due_hours,
--     DROP COLUMN IF EXISTS default_escalation_due_hours;

ALTER TABLE "workspace_governance_policies"
  ADD COLUMN IF NOT EXISTS "default_review_due_hours" INTEGER,
  ADD COLUMN IF NOT EXISTS "default_first_response_due_hours" INTEGER,
  ADD COLUMN IF NOT EXISTS "default_escalation_due_hours" INTEGER;
