-- BILLING (2026-09-28). Additive only; no row is rewritten.
--
-- 1. Stripe storage add-on checkouts get durable attempts too.
-- 2. A subscription records the currency and unit amount its PROVIDER bills,
--    so Billing and plan changes stop assuming the display currency.

ALTER TYPE "BillingCheckoutProduct" ADD VALUE IF NOT EXISTS 'STORAGE_ADDON';

ALTER TABLE "billing_checkout_attempts"
  ADD COLUMN IF NOT EXISTS "storage_addon_key" "StorageAddonKey";

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "billed_currency" VARCHAR(8),
  ADD COLUMN IF NOT EXISTS "billed_unit_amount_cents" INTEGER;
