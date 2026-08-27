-- BILLING RECONCILIATION (2026-08-27) — the provider-state ordering field.
--
-- WHY THIS COLUMN EXISTS
-- ---------------------------------------------------------------------------
-- Reconciliation learns provider facts by polling. A poll that starts before a
-- webhook lands can finish after it, so without an ordering signal a stale
-- "still active" reply could resurrect a subscription the provider had already
-- cancelled — and a stale "cancelled" could tear down one the customer had
-- just renewed.
--
-- `updated_at` cannot decide this: it records when WE last wrote the row, not
-- when the PROVIDER's state was true. `provider_state_at_utc` records the
-- provider's own authoritative timestamp for the state that produced the last
-- write, so an observation older than it is discarded rather than applied.
--
-- WHY IT EXTENDS THE EXISTING AUTHORITY
-- ---------------------------------------------------------------------------
-- This is one nullable column on each of the two tables that already own
-- provider subscription state. It creates no second ledger and no second state
-- machine: payment idempotency continues to come from the existing
-- `payments (provider, provider_payment_id)` unique constraint, and credit
-- idempotency from the existing partial unique index on PURCHASE ledger rows.
--
-- EXPAND-SAFE
-- ---------------------------------------------------------------------------
-- Nullable, no default, no backfill, no rewrite. NULL means "no provider time
-- recorded yet", which the ordering guard treats as "accept and record" — so
-- every existing row reconciles normally on its first pass instead of being
-- frozen out. Old API and Worker builds neither read nor write it, so a
-- rolling deployment in either order is safe.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_state_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "provider_state_at_utc" TIMESTAMPTZ(6);
