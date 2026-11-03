-- =============================================================================
-- 2026-11-03 — CAPACITY: measured on the labelled capacity fixture (docs/operations/capacity-measurements.md).
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One index, built CONCURRENTLY so writes to the
-- table continue during the build. A CONCURRENTLY build cannot run inside a transaction,
-- so this file holds exactly ONE statement (Prisma runs a single-statement file without
-- wrapping it). If the build is interrupted it leaves an INVALID index of this name:
-- DROP INDEX CONCURRENTLY it and re-run; IF NOT EXISTS would otherwise keep the invalid one.
--
-- WHY: records linked to more than one case are found by grouping a workspace's links
-- by evidence id. Without (team_id, evidence_id) that walked the whole evidence_id index
-- of every workspace (1 M entries, 3.4 to 4.4 s); with it, 0.36 s. Build: 9 s, 50 MB.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_evidence_links_team_id_evidence_id_idx"
  ON "case_evidence_links" ("team_id", "evidence_id");
