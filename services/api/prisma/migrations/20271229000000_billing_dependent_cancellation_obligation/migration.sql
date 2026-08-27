-- BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27)
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A recurring Storage add-on is its OWN provider subscription. When a customer
-- cancels PRO or TEAM, the base subscription is cancelled at the provider and
-- each dependent add-on must then be stopped by a SEPARATE remote call. Those
-- calls cannot be atomic with the first one.
--
-- Until now a failed dependent call left NOTHING behind: the failure lived in
-- an in-memory counter that died with the HTTP response. The add-on kept
-- renewing, no retry existed, no alert existed, and no query could find it.
-- A single provider blip therefore charged a customer indefinitely for storage
-- they had cancelled.
--
-- These columns make the OBLIGATION durable. They extend the existing add-on
-- authority rather than opening a parallel ledger, because the obligation is a
-- property of the add-on itself — and keeping it on the row is what lets one
-- indexed query find every unresolved one.
--
-- EXPAND-SAFE
-- ---------------------------------------------------------------------------
-- One new enum, seven nullable columns, two defaulted columns. No column is
-- dropped, renamed, retyped or narrowed; no row is rewritten; NO BACKFILL.
-- Every existing add-on becomes `NONE` / attempt count 0, which is exactly what
-- it is: nobody has asked for it to be cancelled. Guessing an obligation for a
-- historical row would invent a customer intention that was never expressed.
--
-- A legacy ONE_TIME add-on is not a provider subscription and never leaves
-- NONE — the default is the whole of its participation.
--
-- Old API and Worker images neither read nor write any of this, so a rolling
-- deployment in either order is safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'DependentCancellationState'
  ) THEN
    CREATE TYPE "DependentCancellationState" AS ENUM (
      'NONE',
      'PENDING',
      'RETRY_SCHEDULED',
      'ACTION_REQUIRED',
      'CONFIRMED',
      'MANUAL_INTERVENTION'
    );
  END IF;
END
$$;

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_state" "DependentCancellationState" NOT NULL DEFAULT 'NONE';

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_requested_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_failed_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_confirmed_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_next_retry_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_reason_code" VARCHAR(64);

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_triggered_by_subscription_id" UUID;

ALTER TABLE "workspace_storage_addons"
  ADD COLUMN IF NOT EXISTS "dependent_cancellation_lease_until_utc" TIMESTAMPTZ(6);

-- THE UNRESOLVED-OBLIGATION INDEX.
--
-- The retry worker and the reconciliation sweep both ask the same question —
-- "which add-ons are still owed a cancellation, and which are due now?" — and
-- both must answer it without scanning the table. The predicate excludes the
-- two resolved states, so the index stays proportional to the work outstanding
-- rather than to the number of add-ons ever sold, which on a healthy system is
-- zero rows.
--
-- PARTIAL, therefore raw-SQL-owned: Prisma has no syntax for an index
-- predicate, and declaring the columns without it would claim an object the
-- datamodel cannot see. Registered in docs/architecture/raw-schema-ownership.json.
CREATE INDEX IF NOT EXISTS "workspace_storage_addons_dependent_cancellation_open_idx"
  ON "workspace_storage_addons" ("dependent_cancellation_next_retry_at_utc")
  WHERE "dependent_cancellation_state" IN ('PENDING', 'RETRY_SCHEDULED', 'ACTION_REQUIRED', 'MANUAL_INTERVENTION');
