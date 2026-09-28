-- BILLING CHECKOUT ATTEMPTS (2026-09-28). Additive only: one new table and two
-- new enums. No existing row, column, constraint or type is changed.
--
-- A PayPal plan or evidence-credit checkout is recorded here BEFORE the
-- provider is called; the row id is the PayPal-Request-Id and is carried in
-- the provider custom_id, so a lost create response still correlates. The row
-- is not an entitlement or payment authority.

CREATE TYPE "BillingCheckoutProduct" AS ENUM ('PLAN', 'EVIDENCE_CREDIT');

CREATE TYPE "BillingCheckoutAttemptStatus" AS ENUM (
  'PENDING',
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'ABANDONED'
);

CREATE TABLE "billing_checkout_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "product" "BillingCheckoutProduct" NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "plan_key" "PlanType",
  "amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(8) NOT NULL,
  "status" "BillingCheckoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "checkout_state" VARCHAR(48) NOT NULL,
  "provider_resource_id" VARCHAR(128),
  "provider_payment_ref" VARCHAR(128),
  "provider_state_at_utc" TIMESTAMPTZ(6),
  "completed_at_utc" TIMESTAMPTZ(6),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "billing_checkout_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_checkout_attempts_provider_provider_resource_id_key"
  ON "billing_checkout_attempts"("provider", "provider_resource_id");

CREATE INDEX "billing_checkout_attempts_user_id_status_created_at_idx"
  ON "billing_checkout_attempts"("user_id", "status", "created_at");

ALTER TABLE "billing_checkout_attempts"
  ADD CONSTRAINT "billing_checkout_attempts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
