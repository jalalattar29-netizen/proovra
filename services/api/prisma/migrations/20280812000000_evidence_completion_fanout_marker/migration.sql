-- =============================================================================
-- EVIDENCE COMPLETION FAN-OUT MARKER (2026-09-30, ET-ACQ-03). EXPAND.
--
-- The one-time completion fan-out (the evidence.completed webhook, the malware
-- scan, the finalization fan-out) ran once, after the finalize commit, and only
-- on the first finalize. A failure between the commit and the fan-out (the
-- retention or lock-snapshot step, a crash) skipped it permanently: a retry
-- took the already-finalized path, which returned before it.
--
-- Two nullable columns carry it durably: claimed (a lease, so exactly one
-- finalize runs it and a crashed claim is re-driven) and done.
--
-- Additive only: nothing rewritten here (the backfill is its own migration).
-- =============================================================================

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "completion_fanout_claimed_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "completion_fanout_done_at_utc" TIMESTAMPTZ(6);
