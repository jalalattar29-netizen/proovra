-- =============================================================================
-- 2026-11-19 — billing holds (WS-BILL, review HIGH-MONEY-DISCLOSURE): the
-- durable proof that a cancellation was asked for by the CUSTOMER through
-- PROOVRA's own cancel path.
--
-- The sweep step that ends a cancelled PayPal plan once its kept paid period
-- is over lowered every CANCELED PayPal row to FREE, whatever cancelled it and
-- whatever BILLING_AUTO_PLAN_LOWERING said — including rows the same sweep had
-- just held. `canceled_at_utc` cannot tell the two apart: it is written by the
-- cancel route AND by every provider fact that reports a cancellation.
--
--   customer_cancel_requested_at_utc
--       written ONLY by the customer cancel service, in the transaction that
--       records the provider's confirmation; cleared by a confirmed restart.
--       NULL = no customer cancellation recorded through PROOVRA.
--
-- With the switch off, the sweep ends a cancelled plan only for a row carrying
-- this fact; every other ended row is held (AUTOMATIC_PLAN_LOWERING_HELD).
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no index, no row rewritten.
-- An older API image never reads or writes it. Rollback: leave the column.
-- =============================================================================

ALTER TABLE "subscriptions"
  ADD COLUMN "customer_cancel_requested_at_utc" TIMESTAMPTZ(6);
