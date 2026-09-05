-- ──────────────────────────────────────────────────────────────────────
-- A GRANTED CREDIT IS NOT A PURCHASED ONE.
--
-- The evidence-credit wallet had exactly three movements — PURCHASE,
-- CONSUMPTION, REVERSAL — and one way for credits to arrive: a completed
-- Stripe or PayPal payment. Support remediation, goodwill and controlled
-- internal testing had no mechanism at all, so the only way to grant a credit
-- was to write a PURCHASE row: a ledger entry asserting a payment that never
-- happened, in the one table whose whole purpose is to prove where every
-- credit came from. The customer's own billing history reads that table.
--
-- ADMIN_GRANT is the truthful fourth movement. It carries no provider and no
-- provider_ref, because there is no payment to identify.
-- ──────────────────────────────────────────────────────────────────────
ALTER TYPE "EvidenceCreditEntryType" ADD VALUE IF NOT EXISTS 'ADMIN_GRANT';

-- The grant's own reference, and the idempotency key the retry check reads.
ALTER TABLE "evidence_credit_ledger_entries"
  ADD COLUMN IF NOT EXISTS "grant_ref" VARCHAR(191);

-- ──────────────────────────────────────────────────────────────────────
-- THE IDEMPOTENCY GUARANTEE, AT THE DATABASE.
--
-- Same shape as the PURCHASE guard above it: a re-delivered or retried grant
-- cannot double-credit a wallet, because the second INSERT cannot exist. The
-- application checks first and returns the prior balance; this is the line
-- that holds when two requests race.
--
-- The predicate is `grant_ref IS NOT NULL` rather than
-- `entry_type = 'ADMIN_GRANT'` DELIBERATELY. PostgreSQL refuses to use a newly
-- added enum value inside the transaction that added it, so naming ADMIN_GRANT
-- here would fail this migration on a fresh database. Only grant rows carry a
-- grant_ref, so the two predicates select the same rows anyway.
-- ──────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_credit_ledger_grant_ref_key"
  ON "evidence_credit_ledger_entries" ("grant_ref")
  WHERE "grant_ref" IS NOT NULL;
