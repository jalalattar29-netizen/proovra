-- Phase E10.1 — DEF-038 closure. Stripe webhook event idempotency.
--
-- Adds the `stripe_webhook_events` table with a UNIQUE constraint on
-- `stripe_event_id`. The `POST /stripe` handler inserts the row at
-- the top of every request; the duplicate insert path raises a unique
-- violation which the handler translates into a safe no-op 200.
--
-- Bounded shape:
--   - No FKs (Stripe events are not tied to any local row).
--   - `processing_status` is a free-form short string (RECEIVED /
--     PROCESSED / FAILED) — kept simple rather than a CHECK
--     constraint so the handler can evolve internal status without
--     a migration.
--   - Indexes support the two operator query patterns:
--     - "what events have I received and processed today?"
--       (eventType, receivedAt)
--     - "what is currently in a non-final state?" (processingStatus)
--   - Row retention is open-ended (companion to DEF-024 / DEF-031 /
--     DEF-032 — addressed by a future retention worker).

CREATE TABLE "stripe_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stripe_event_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(120) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "processing_status" VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
    "error_reason" VARCHAR(400),

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- The idempotency keystone. A duplicate webhook delivery from Stripe
-- raises a unique violation on this index; the handler catches it and
-- treats the event as already-seen.
CREATE UNIQUE INDEX "stripe_webhook_events_stripe_event_id_key" ON "stripe_webhook_events"("stripe_event_id");

CREATE INDEX "stripe_webhook_events_event_type_received_at_idx" ON "stripe_webhook_events"("event_type", "received_at");
CREATE INDEX "stripe_webhook_events_processing_status_idx" ON "stripe_webhook_events"("processing_status");
