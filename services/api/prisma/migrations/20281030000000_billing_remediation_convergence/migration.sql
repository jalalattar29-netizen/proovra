-- =============================================================================
-- 2026-10-30 — billing remediation: convergence state.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Nullable columns, columns with a
-- constant default, and two new tables. No existing row is rewritten, and an
-- image that predates this migration neither reads nor writes any of it, so it
-- is safe before the code and after a rollback.
--
-- 1. subscriptions: the Stripe schedule behind a scheduled downgrade, and the
--    durable retry of a superseded duplicate's provider cancellation.
-- 2. payments: money returned so far and dispute state, beside the untouched
--    original amount.
-- 3. payment_adjustments: one row per provider refund or reversal, so repeated
--    partial refunds are additive and a redelivery is a no-op.
-- 4. billing_provider_binding_checks: a stored reference the provider does not
--    know, with its backoff. It revokes nothing.
-- =============================================================================

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_schedule_id" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "superseded_by_subscription_id" UUID,
  ADD COLUMN IF NOT EXISTS "supersession_cancel_state" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "supersession_cancel_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "supersession_cancel_next_retry_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "refunded_amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "dispute_status" VARCHAR(32);

CREATE TABLE "payment_adjustments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "payment_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_adjustment_id" VARCHAR(191) NOT NULL,
  "kind" VARCHAR(24) NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(8) NOT NULL,
  "observed_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_adjustments_payment_id_fkey" FOREIGN KEY ("payment_id")
    REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_adjustments_provider_provider_adjustment_id_key"
  ON "payment_adjustments"("provider", "provider_adjustment_id");
CREATE INDEX IF NOT EXISTS "payment_adjustments_payment_id_idx"
  ON "payment_adjustments"("payment_id");

CREATE TABLE "billing_provider_binding_checks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "resource_kind" VARCHAR(24) NOT NULL,
  "provider_resource_id" VARCHAR(191) NOT NULL,
  "state" VARCHAR(24) NOT NULL DEFAULT 'UNRESOLVED',
  "consecutive_misses" INTEGER NOT NULL DEFAULT 1,
  "first_missing_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "last_missing_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "next_check_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "billing_provider_binding_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_provider_binding_checks_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "billing_provider_binding_checks_provider_provider_resource__key"
  ON "billing_provider_binding_checks"("provider", "provider_resource_id");
CREATE INDEX IF NOT EXISTS "billing_provider_binding_checks_state_next_check_at_utc_idx"
  ON "billing_provider_binding_checks"("state", "next_check_at_utc");
CREATE INDEX IF NOT EXISTS "billing_provider_binding_checks_user_id_state_idx"
  ON "billing_provider_binding_checks"("user_id", "state");
