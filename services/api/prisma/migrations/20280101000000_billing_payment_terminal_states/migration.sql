-- BILLING SURFACE CORRECTION (2026-08-29) — give a pending payment somewhere to end.
--
-- WHY THIS MIGRATION EXISTS
-- ---------------------------------------------------------------------------
-- `PaymentStatus` could say PENDING, SUCCEEDED, FAILED or REFUNDED. A checkout
-- the customer abandoned, or one whose Stripe Checkout Session timed out, is
-- none of those: no money was attempted, so FAILED is a lie, and it is never
-- coming, so PENDING is a lie that lasts for ever. The Billing page showed
-- months-old rows reading "Pending" with no way to tell whether a charge was
-- still on its way.
--
-- `provider_state_at_utc` is the ordering guard, named and shaped exactly like
-- `subscriptions.provider_state_at_utc`: an observation older than the state
-- already recorded is discarded rather than applied, so a slow reconciliation
-- poll cannot overwrite a newer webhook and an out-of-order webhook cannot move
-- a settled payment backwards.
--
-- EXPAND-SAFE
-- ---------------------------------------------------------------------------
-- Both changes are purely additive. No existing row changes status, no column
-- is dropped or narrowed, and nothing here reads or rewrites payment history.
-- Adding an enum value is allowed inside a transaction on PostgreSQL 12+ so
-- long as the new value is not USED in the same transaction, and nothing here
-- uses it.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "provider_state_at_utc" TIMESTAMPTZ(6);
