-- BILLING PAYPAL INTEGRITY (2026-09-28). Additive only: new nullable or
-- defaulted columns, one new table, two new indexes. No existing row is
-- rewritten or backfilled, and no type, constraint or column is changed.
--
-- 1. payments: WHAT a payment paid for (product), the checkout attempt that
--    produced it and the provider resource it belongs to. Credit recovery
--    reads EVIDENCE_CREDIT rows only, so a plan or storage renewal can never
--    be granted as a credit because its amount happens to match.
-- 2. subscriptions: first provider-confirmed activation; a LOCAL abandonment
--    time kept apart from the provider ordering column; whether a scheduled
--    plan change still awaits the buyer's approval, and when it was asked.
-- 3. workspace_storage_addons: the base subscription an add-on depends on,
--    recorded at activation, so an unrelated cancelled plan row can no longer
--    create a cancellation obligation for valid storage.
-- 4. billing_review_items: auditable record of provider charges PROOVRA could
--    not turn into an entitlement (superseded duplicate subscriptions,
--    ungrantable storage activations, refunds of consumed credits, disputes).
-- 5. evidence_credit_ledger_entries: at most one refund REVERSAL per provider
--    payment (partial unique index; the REVERSAL enum value already exists).

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "product" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "checkout_attempt_id" UUID,
  ADD COLUMN IF NOT EXISTS "provider_resource_id" VARCHAR(128);

CREATE INDEX IF NOT EXISTS "payments_user_id_product_status_idx"
  ON "payments"("user_id", "product", "status");

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "pending_plan_awaiting_approval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pending_plan_requested_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "activated_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "locally_terminated_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "depends_on_subscription_id" UUID;

CREATE TABLE "billing_review_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_resource_id" VARCHAR(128) NOT NULL,
  "product" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(64) NOT NULL,
  "provider_action" VARCHAR(48) NOT NULL DEFAULT 'NONE',
  "refund_review_required" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  "detail" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "billing_review_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "billing_review_items_provider_provider_resource_id_reason_key"
  ON "billing_review_items"("provider", "provider_resource_id", "reason");

CREATE INDEX IF NOT EXISTS "billing_review_items_user_id_status_idx"
  ON "billing_review_items"("user_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_review_items_user_id_fkey'
  ) THEN
    ALTER TABLE "billing_review_items"
      ADD CONSTRAINT "billing_review_items_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_credit_ledger_refund_reversal_provider_ref_key"
  ON "evidence_credit_ledger_entries" ("provider", "provider_ref")
  WHERE "entry_type" = 'REVERSAL' AND "evidence_id" IS NULL
    AND "provider" IS NOT NULL AND "provider_ref" IS NOT NULL;
