-- =============================================================================
-- 2026-11-18 — WS-REL / PRO-W2-09: a running governance reconciliation sweep
-- states that it is alive.
--
-- A RUNNING row held its kind's lock for a fixed 60 minutes from start, with
-- no renewal: a worker stopped mid-run blocked that sweep on every replica for
-- up to an hour, and a run that legitimately took longer was force-failed and
-- joined by a second one. The holder now touches `heartbeat_at_utc` while its
-- body runs, and staleness is judged on the latest heartbeat.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no default, no backfill.
-- A row an older image writes keeps NULL and is judged by the old 60-minute
-- rule from `started_at_utc`; an older image never reads the column.
-- Rollback: leave the column.
-- =============================================================================

ALTER TABLE "governance_reconciliation_runs"
  ADD COLUMN "heartbeat_at_utc" TIMESTAMPTZ(6);
