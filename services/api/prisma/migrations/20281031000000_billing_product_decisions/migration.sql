-- =============================================================================
-- 2026-10-31 — billing product decisions: dependent storage and customer reuse.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Nullable columns and one new table.
-- No existing row is rewritten. An image that predates this migration neither
-- reads nor writes any of it, so it is safe before the code and after a
-- rollback.
--
-- 1. subscriptions.addon_end_consent_*: the plan a customer agreed to move to
--    knowing their Team storage would stop renewing. Only a downgrade carrying
--    this is allowed to end add-ons, so a change scheduled before this release
--    never ends one.
-- 2. workspace_storage_addons.depends_on_plan_grant_id: the internal plan grant
--    that made this add-on purchasable, recorded at activation.
-- 3. billing_provider_customers: the verified provider customer of one billing
--    owner, per provider environment.
-- =============================================================================

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "addon_end_consent_plan" "PlanType",
  ADD COLUMN IF NOT EXISTS "addon_end_consent_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "depends_on_plan_grant_id" UUID;

CREATE INDEX IF NOT EXISTS "workspace_storage_addons_depends_on_plan_grant_id_idx"
  ON "workspace_storage_addons" ("depends_on_plan_grant_id");

CREATE TABLE "billing_provider_customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "environment" VARCHAR(8) NOT NULL,
  "provider_customer_id" VARCHAR(191) NOT NULL,
  "state" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "source" VARCHAR(24) NOT NULL,
  "replaced_provider_customer_id" VARCHAR(191),
  "verified_at_utc" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "billing_provider_customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_provider_customers_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "billing_provider_customers_user_id_provider_environment_key"
  ON "billing_provider_customers" ("user_id", "provider", "environment");

CREATE UNIQUE INDEX "billing_provider_customers_customer_key"
  ON "billing_provider_customers" ("provider", "environment", "provider_customer_id");
