-- =============================================================================
-- 2026-11-18 — PRO-BL1-01 (WS-BILL, RG-01): durable business-intent identity
-- for provider mutations on a base subscription.
--
-- Cancel, restart and plan-change calls used an idempotency key bucketed by
-- UTC hour. Cancel -> restart -> cancel (or downgrade -> withdraw ->
-- downgrade) inside one hour re-sent the first request's key with the same
-- body, so Stripe/PayPal replayed the stored first answer without executing,
-- and the second intent was recorded as done while the provider still renewed.
--
-- One outstanding provider intent per subscription is now persisted BEFORE the
-- provider call:
--
--   provider_intent_key     the idempotency key of the intent in flight
--                           (kind, subscription, target and a random nonce).
--                           A retry of the SAME intent whose answer was lost
--                           reuses it; a new intent (after a reversal, a
--                           refusal or a confirmation) mints a new one.
--   provider_intent_at_utc  when that intent was minted; an intent older than
--                           the providers' idempotency retention is not reused.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Nullable columns, no index, no row rewritten. An
-- older API image never reads or writes them (it keeps its own hour keys).
-- Rollback: leave the columns.
-- =============================================================================

ALTER TABLE "subscriptions"
  ADD COLUMN "provider_intent_key" VARCHAR(200),
  ADD COLUMN "provider_intent_at_utc" TIMESTAMPTZ(6);
