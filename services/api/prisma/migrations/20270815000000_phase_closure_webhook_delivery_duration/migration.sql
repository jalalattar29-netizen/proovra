-- Phase Closure — Webhook delivery response duration.
--
-- Adds a single nullable column to `integration_webhook_deliveries` so
-- the dispatcher can record the measured wall-clock duration of each
-- outbound HTTP attempt. The value is captured around the SAME single
-- `httpClient(...)` call in `attemptDeliveryInner` and persisted in
-- whichever terminal status update fires (SENT / FAILED / RETRY_SCHEDULED).
--
-- Honest framing:
--   * The column is NULL for rows whose terminal status was reached
--     WITHOUT ever issuing the outbound fetch — e.g. the row was marked
--     FAILED inside attemptDeliveryInner because the secret could not
--     be decrypted (signing_key_unavailable). The dispatcher must not
--     fabricate a duration in those cases.
--   * The value is wall-clock milliseconds measured with
--     `process.hrtime.bigint()` around the single fetch invocation,
--     bracket-style: end - start. We never accept a negative measurement.
--   * The column is NOT indexed. The only consumer today is the
--     last-24h average computed in `integration-health.service.ts`,
--     which already filters on `(team_id, created_at)`, both of which
--     are covered by existing indexes on the table. Adding an index
--     for AVG() would be premature.
--
-- Hard rules satisfied:
--   * ADDITIVE ONLY — one nullable INTEGER column; no drops, no renames,
--     no backfills. Rows written before this migration land read as
--     NULL, which is honest — we did not measure them.
--   * IDEMPOTENT — `ADD COLUMN IF NOT EXISTS` so re-runs on a partially
--     applied DB are clean no-ops.
--   * NO LOCK ESCALATION — the column has no DEFAULT, so the statement
--     does not rewrite the table on Postgres 11+.

SELECT 'Phase closure webhook delivery duration: one additive nullable integer column on integration_webhook_deliveries.' AS phase_closure_latency_readiness;

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------

ALTER TABLE "integration_webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "response_duration_ms" INTEGER;
