-- =============================================================================
-- 2026-11-18 — PRO-K1-01 (WS-REACH): a stored SIU export bundle is released by
-- what it CONTAINS, not by case reach alone.
--
--   includes_pii           TRUE when the bundle's siu-summary.json carries the
--                          unredacted claimant name/contact; FALSE when built
--                          from the redacted projection. NULL = a bundle stored
--                          before this column existed: unknown, so the download
--                          treats it as PII-bearing (the safer disclosure rule).
--   included_evidence_ids  JSON array of the record ids whose report/package the
--                          bundle carries. NULL = legacy: unknown population, so
--                          only the generator may download it again.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Nullable columns only; no backfill and no stored
-- artifact is rewritten (issued artifacts are immutable). An older API image
-- never reads or writes them. Rollback: leave the columns.
-- =============================================================================

ALTER TABLE "case_siu_exports"
  ADD COLUMN "includes_pii" BOOLEAN,
  ADD COLUMN "included_evidence_ids" JSONB;
