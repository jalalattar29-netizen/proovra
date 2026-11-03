-- =============================================================================
-- 2026-11-03 — CAPACITY: measured on the labelled capacity fixture (docs/operations/capacity-measurements.md).
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One index, built CONCURRENTLY so writes to the
-- table continue during the build. A CONCURRENTLY build cannot run inside a transaction,
-- so this file holds exactly ONE statement (Prisma runs a single-statement file without
-- wrapping it). If the build is interrupted it leaves an INVALID index of this name:
-- DROP INDEX CONCURRENTLY it and re-run; IF NOT EXISTS would otherwise keep the invalid one.
--
-- WHY: the command center lists disclosure changes since a date by team. No index led
-- to a parallel sequential scan of every evidence row: 3.9 s. Partial over the rows
-- that carry a change, so the index holds only those (8 kB on the fixture). A raw-schema
-- object: Prisma cannot declare the predicate, like evidence_destruction_partial_idx.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "evidence_team_id_disclosure_changed_idx"
  ON "evidence" ("team_id", "verification_disclosure_changed_at_utc" DESC)
  WHERE "verification_disclosure_changed_at_utc" IS NOT NULL;
