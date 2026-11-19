-- =============================================================================
-- 2026-11-19 — WS-SCHED / PRO-W1-06 (DEC-04): an artifact run RESERVES the
-- bytes it is about to publish, before any byte goes under Object Lock.
--
-- `storage_reserved_bytes` on the request row a run holds is that reservation.
-- It is LIVE only while the request's claim is live (state PROCESSING and
-- claimed_at_utc / lease_renewed_at_utc inside the claim lease), so it expires
-- with the claim and needs no clock of its own. Both usage meters (API
-- workspace-usage, worker getWorkspaceUsage) add the live reservations of a
-- workspace. NULL means "nothing reserved": every request of an older worker,
-- every run exempt from the storage gate, and every settled request.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no default rewrite, no
-- backfill, no index (the meters reach it through
-- report_generation_requests_team_state_idx). An older image never reads or
-- writes it. Rollback: leave the column; NULL is the old behaviour.
-- =============================================================================

ALTER TABLE "report_generation_requests"
  ADD COLUMN "storage_reserved_bytes" BIGINT;
