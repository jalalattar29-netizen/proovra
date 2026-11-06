-- =============================================================================
-- 2026-11-06 — GOV-012: whether a held record's bytes may be released to the
-- workspace's own authenticated people is an explicit, owner-only setting.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One column with a default that keeps today's
-- behaviour (BLOCK: every byte release of a held record is refused). No row's
-- behaviour changes until a workspace owner opts in. An older image never reads
-- the column. Rollback: leave the column (BLOCK is the old behaviour).
-- =============================================================================

ALTER TABLE "workspace_governance_policies"
  ADD COLUMN "legal_hold_disclosure" VARCHAR(32) NOT NULL DEFAULT 'BLOCK';

ALTER TABLE "workspace_governance_policies"
  ADD CONSTRAINT "workspace_governance_policies_legal_hold_disclosure_check"
  CHECK ("legal_hold_disclosure" IN ('BLOCK', 'ALLOW_AUTHENTICATED_RECORDED'));