-- =============================================================================
-- EVIDENCE COMPLETION FAN-OUT BACKFILL (2026-09-30, ET-ACQ-03). BACKFILL.
--
-- Every record signed before the marker existed has had its one chance at the
-- completion fan-out; whether it ran cannot be known now, and re-running it for
-- history would re-emit old webhooks and scans. Such rows are marked done at
-- their signing time, so only records finalized from here on are re-driven.
--
-- Idempotent: conditioned on the marker being unset; a re-run is a no-op.
-- =============================================================================

UPDATE "evidence"
   SET "completion_fanout_done_at_utc" = "signed_at_utc"
 WHERE "signed_at_utc" IS NOT NULL
   AND "completion_fanout_done_at_utc" IS NULL;
