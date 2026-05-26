-- =============================================================================
-- Phase E3.3 — Async Delivery & Retry Runtime
--
-- Closes DEF-023. Adds:
--
--   * RETRY_SCHEDULED + RETRY_EXHAUSTED to the delivery status CHECK
--     constraint (E3.2 shipped only PENDING / DELIVERING / SUCCEEDED /
--     FAILED / SKIPPED — the retry-state vocabulary lands here).
--
--   * 3 destination-health columns on automation_webhook_destinations:
--       - consecutive_failure_count (INT, default 0): incremented on
--         every failed delivery; reset to 0 on every success.
--       - auto_disabled_at (TIMESTAMPTZ, nullable): set when the
--         runtime auto-disables the destination after N consecutive
--         failures.
--       - disabled_reason (VARCHAR 200, nullable): operator-safe
--         classification (e.g. "auto_disabled:consecutive_failures").
--
-- Hard rules:
--   - No new tables (the E3.2 schema already supports retry via the
--     existing `attempt_count` + `next_attempt_at` columns).
--   - All additions are additive / non-breaking.
-- =============================================================================

-- Extend the delivery-status allowlist to include the retry states.
-- The CHECK constraint is DROP'd + recreated rather than ALTER'd so
-- the migration is portable across PG versions.
ALTER TABLE "automation_webhook_deliveries"
  DROP CONSTRAINT "automation_webhook_deliveries_status_allowlist";

ALTER TABLE "automation_webhook_deliveries"
  ADD CONSTRAINT "automation_webhook_deliveries_status_allowlist"
  CHECK ("status" IN (
    'PENDING',
    'DELIVERING',
    'SUCCEEDED',
    'FAILED',
    'SKIPPED',
    'RETRY_SCHEDULED',
    'RETRY_EXHAUSTED'
  ));

-- Destination-health columns.
ALTER TABLE "automation_webhook_destinations"
  ADD COLUMN "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "auto_disabled_at" TIMESTAMPTZ(6),
  ADD COLUMN "disabled_reason" VARCHAR(200);

-- Index to find destinations that need ops attention (auto-disabled
-- or with high consecutive-failure counts).
CREATE INDEX "automation_webhook_destinations_team_consec_fail_idx"
  ON "automation_webhook_destinations"("team_id", "consecutive_failure_count");

-- Index for the cron sweeper: find RETRY_SCHEDULED rows whose
-- next_attempt_at has passed. The composite index supports the
-- typical sweeper query: `WHERE status = 'RETRY_SCHEDULED' AND
-- next_attempt_at <= NOW() ORDER BY next_attempt_at LIMIT N`.
CREATE INDEX "automation_webhook_deliveries_status_nextattempt_idx"
  ON "automation_webhook_deliveries"("status", "next_attempt_at")
  WHERE "status" = 'RETRY_SCHEDULED';
