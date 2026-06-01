-- Phase 10 — PayPal webhook payload-hash idempotency strengthening.
--
-- Adds `payload_hash` column to `paypal_webhook_events`. The handler
-- now computes sha256(rawBody) and compares against the stored hash
-- so that a duplicate delivery with an identical payload is treated
-- as a true dedup hit (200, no business-logic re-run). If the same
-- event_id arrives with a different hash the handler treats it as a
-- replay-retry and lets processing proceed (the per-side-effect
-- writers — recordPayment / upsertSubscription / activateTeamPlan —
-- are themselves idempotent on their own keys).
--
-- This is additive: the column is NULLABLE so rows written before
-- this migration remain valid. New writes always populate it.
--
-- Hardening rules (Phase O):
--   * ALTER inside a DO block with information_schema column guard.
--   * Additive-only — no NOT NULL, no UPDATE, no backfill.
--   * Statement terminates with semicolon (audit
--     INDEX_COLUMN_RISK regex requirement).

BEGIN;

-- =============================================================================
-- paypal_webhook_events.payload_hash
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='paypal_webhook_events')
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='paypal_webhook_events' AND column_name='payload_hash'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE "paypal_webhook_events"
        ADD COLUMN "payload_hash" VARCHAR(128);
    $sql$;
  END IF;
END $$;

COMMIT;
