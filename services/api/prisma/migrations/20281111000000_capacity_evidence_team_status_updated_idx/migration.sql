-- =============================================================================
-- 2026-11-03 — CAPACITY: measured on the labelled capacity fixture (docs/operations/capacity-measurements.md).
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One index, built CONCURRENTLY so writes to the
-- table continue during the build. A CONCURRENTLY build cannot run inside a transaction,
-- so this file holds exactly ONE statement (Prisma runs a single-statement file without
-- wrapping it). If the build is interrupted it leaves an INVALID index of this name:
-- DROP INDEX CONCURRENTLY it and re-run; IF NOT EXISTS would otherwise keep the invalid one.
--
-- WHY: the command center reads the records signed but not timestamped, and signed with
-- no package yet, by (team_id, status) ordered by updated_at. With no such index the
-- planner scanned the whole evidence table: 3.2 s and 3.0 s for a 300,000-record
-- workspace. Measured cost of the build on 1.87 M rows: 76 s, 84 MB.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "evidence_team_id_status_updated_at_idx"
  ON "evidence" ("team_id", "status", "updated_at" DESC);
