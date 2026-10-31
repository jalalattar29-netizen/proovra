-- =============================================================================
-- 2026-11-01 — one Stripe customer per owner, environment and recurring currency.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Applied with its predecessor, which
-- created this table, so the table is expected to be empty. No row is rewritten:
-- a row that does exist keeps a NULL currency, which no checkout reads.
--
-- 1. currency: Stripe locks a customer to one recurring currency, so one binding
--    per owner forced every checkout in another currency to create a customer.
-- 2. creation_key, creation_started_at_utc, nullable provider_customer_id: the
--    binding is written before the provider call, so a lost response continues
--    the same creation instead of starting another.
-- =============================================================================

ALTER TABLE "billing_provider_customers"
  ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3),
  ADD COLUMN IF NOT EXISTS "creation_key" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "creation_started_at_utc" TIMESTAMPTZ(6),
  ALTER COLUMN "provider_customer_id" DROP NOT NULL;

CREATE UNIQUE INDEX "billing_provider_customers_owner_currency_key"
  ON "billing_provider_customers" ("user_id", "provider", "environment", "currency");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'billing_provider_customers_owner_currency_key'
  ) THEN
    RAISE EXCEPTION
      'stripe customer per currency refused: the owner and currency key is missing, so retiring the owner key would leave no per-owner uniqueness';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS "billing_provider_customers_user_id_provider_environment_key"';
END $$;
