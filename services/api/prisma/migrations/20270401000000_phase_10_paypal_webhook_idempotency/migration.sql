-- Phase 10 — PayPal webhook idempotency.
--
-- Adds the `paypal_webhook_events` table with a UNIQUE constraint on
-- `paypal_event_id`. The `POST /paypal` handler inserts the row at
-- the top of every request; the duplicate insert path raises a unique
-- violation which the handler translates into a safe no-op 200.
--
-- This is the direct mirror of the `stripe_webhook_events` table
-- (Phase E10.1 / DEF-038) — same shape, same retention policy, same
-- index pattern. The handler uses the unique index as the idempotency
-- keystone.
--
-- Bounded shape:
--   - No FKs (PayPal events are not tied to any local row).
--   - `processing_status` is a free-form short string (RECEIVED /
--     PROCESSED / FAILED) — kept simple rather than a CHECK
--     constraint so the handler can evolve internal status without
--     a migration.
--   - Indexes support the two operator query patterns:
--     - "what events have I received and processed today?"
--       (event_type, received_at)
--     - "what is currently in a non-final state?" (processing_status)
--   - Row retention is open-ended (companion to DEF-024 / DEF-031 /
--     DEF-032 — addressed by a future retention worker).
--
-- Hardening rules (Phase O):
--   * CREATE TABLE inside a DO block with pg_tables existence check.
--   * Every CREATE INDEX guarded by pg_tables + per-column check.
--   * Additive-only — no ALTER, no UPDATE, no SET NOT NULL.
--   * All statements terminate with semicolons (audit
--     INDEX_COLUMN_RISK regex requirement).

BEGIN;

-- =============================================================================
-- paypal_webhook_events
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='paypal_webhook_events') THEN
    EXECUTE $sql$
      CREATE TABLE "paypal_webhook_events" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "paypal_event_id" VARCHAR(128) NOT NULL,
        "event_type" VARCHAR(120) NOT NULL,
        "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processed_at" TIMESTAMPTZ(6),
        "processing_status" VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
        "error_reason" VARCHAR(400),

        CONSTRAINT "paypal_webhook_events_pkey" PRIMARY KEY ("id")
      );
    $sql$;
  END IF;
END $$;

-- The idempotency keystone. A duplicate webhook delivery from PayPal
-- raises a unique violation on this index; the handler catches it and
-- treats the event as already-seen.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='paypal_webhook_events')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='paypal_webhook_events' AND column_name='paypal_event_id') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "paypal_webhook_events_paypal_event_id_key" ON "paypal_webhook_events" ("paypal_event_id")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='paypal_webhook_events')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='paypal_webhook_events' AND column_name='event_type')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='paypal_webhook_events' AND column_name='received_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "paypal_webhook_events_event_type_received_at_idx" ON "paypal_webhook_events" ("event_type", "received_at")';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='paypal_webhook_events')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='paypal_webhook_events' AND column_name='processing_status') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "paypal_webhook_events_processing_status_idx" ON "paypal_webhook_events" ("processing_status")';
  END IF;
END $$;

COMMIT;
