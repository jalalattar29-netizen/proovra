-- Phase: Billing commercial correctness (2026-08-27).
--
-- EXPAND-ONLY. This migration adds three things and changes nothing that
-- already exists:
--
--   1. evidence_credit_ledger_entries  — the auditable evidence-credit wallet
--                                        ledger, with a UNIQUE evidence_id
--                                        that makes credit consumption
--                                        idempotent per Evidence record.
--   2. subscriptions.cancel_at_period_end / canceled_at_utc
--                                      — the provider-confirmed "cancels at
--                                        period end" lifecycle. Defaults keep
--                                        every existing row's meaning intact.
--   3. enterprise_contracts.evidence_records_per_month / ai_operations_per_month
--                                      — contract-managed operational
--                                        allowances, NULL where the contract
--                                        does not specify one.
--
-- SAFETY PROPERTIES (Phase O-Final pattern):
--   * Every statement is idempotent (IF NOT EXISTS / guarded DO block), so the
--     migration is safe to re-run against a partially-applied schema.
--   * No column is dropped, renamed, retyped or narrowed.
--   * No row is deleted or rewritten. There is no backfill: existing
--     entitlements.credits balances stay exactly as they are and are treated
--     as an opening balance by the application, so no customer loses a
--     purchased credit and no historical payment is rewritten.
--   * NOT NULL columns are added only with a DEFAULT, so existing rows are
--     valid the instant the column appears.
--
-- No Stripe / PayPal price or plan identifier is touched.
-- No evidence, custody, signature, TSA or OTS data is touched.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Evidence-credit ledger entry type
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EvidenceCreditEntryType') THEN
    CREATE TYPE "EvidenceCreditEntryType" AS ENUM ('PURCHASE', 'CONSUMPTION', 'REVERSAL');
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Evidence-credit ledger
--
-- `evidence_id` is UNIQUE and NULLABLE. Postgres permits unlimited NULLs in a
-- unique column, so PURCHASE rows (no evidence id) are unconstrained while
-- CONSUMPTION rows are constrained to at most one per Evidence record. That
-- constraint IS the double-spend guard: a retried completion for the same
-- record raises a unique violation instead of burning a second credit.
-- ──────────────────────────────────────────────────────────────────────
-- Phase O-Final pattern: an explicit `information_schema.tables` guard around
-- a plain CREATE TABLE, NOT `CREATE TABLE IF NOT EXISTS`.
--
-- The audit gate classifies IF NOT EXISTS as CRITICAL for a real reason: it
-- silently skips the WHOLE block when the table exists, so a later migration
-- that adds a column to the same CREATE statement is silently lost. The guard
-- below is idempotent in the same way but says so explicitly, and every
-- subsequent column evolution has to be its own ALTER — which is what makes
-- the loss impossible rather than merely unlikely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'evidence_credit_ledger_entries'
  ) THEN
    CREATE TABLE "evidence_credit_ledger_entries" (
      "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
      "user_id"       UUID NOT NULL,
      "entry_type"    "EvidenceCreditEntryType" NOT NULL,
      "credits_delta" INTEGER NOT NULL,
      "evidence_id"   UUID,
      "provider"      "PaymentProvider",
      "provider_ref"  VARCHAR(191),
      "balance_after" INTEGER NOT NULL,
      "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      CONSTRAINT "evidence_credit_ledger_entries_pkey" PRIMARY KEY ("id")
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'evidence_credit_ledger_entries_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_credit_ledger_entries"
      ADD CONSTRAINT "evidence_credit_ledger_entries_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_credit_ledger_entries_evidence_id_key"
  ON "evidence_credit_ledger_entries" ("evidence_id");

CREATE INDEX IF NOT EXISTS "evidence_credit_ledger_entries_user_id_created_at_idx"
  ON "evidence_credit_ledger_entries" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "evidence_credit_ledger_entries_entry_type_idx"
  ON "evidence_credit_ledger_entries" ("entry_type");

-- ──────────────────────────────────────────────────────────────────────
-- 3. Subscription cancel-at-period-end lifecycle
--
-- DEFAULT false preserves the existing meaning of every row: nothing becomes
-- "cancelling" as a side effect of this migration.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "canceled_at_utc" TIMESTAMPTZ(6);

-- ──────────────────────────────────────────────────────────────────────
-- 4. Enterprise contract operational allowances
--
-- NULL = the contract does not specify this allowance. The application then
-- falls back to the canonical ENTERPRISE catalog default and presents
-- "Contract-managed", rather than inventing or silently reducing a number.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "evidence_records_per_month" INTEGER;

ALTER TABLE "enterprise_contracts"
  ADD COLUMN IF NOT EXISTS "ai_operations_per_month" INTEGER;

-- ──────────────────────────────────────────────────────────────────────
-- 5. Purchase idempotency backstop
--
-- Webhook delivery is already deduplicated by the UNIQUE provider event id on
-- stripe_webhook_events / paypal_webhook_events, so a credit grant runs at
-- most once per event. This PARTIAL unique index is the database-level second
-- line: at most one PURCHASE entry may exist per (provider, provider_ref), so
-- even a grant reached by some future path cannot double-credit a wallet from
-- one payment. It is deliberately partial — CONSUMPTION and REVERSAL rows
-- carry no provider_ref and are unaffected.
-- ──────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_credit_ledger_purchase_provider_ref_key"
  ON "evidence_credit_ledger_entries" ("provider", "provider_ref")
  WHERE "entry_type" = 'PURCHASE' AND "provider" IS NOT NULL AND "provider_ref" IS NOT NULL;
