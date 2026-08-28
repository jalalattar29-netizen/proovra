-- BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the scheduled plan change.
--
-- WHY THESE COLUMNS EXIST
-- ---------------------------------------------------------------------------
-- FREE, PRO and TEAM are now three tiers of the SAME Personal Workspace, so a
-- customer can move between them in both directions. Moving UP takes effect at
-- once: they pay the difference and get the capacity immediately. Moving DOWN
-- must not, and for a reason that has nothing to do with implementation
-- convenience — they have already paid for the current period, and a downgrade
-- that took capacity away the moment it was requested would be taking back
-- something already bought.
--
-- A period-end downgrade therefore has a state between the request and the
-- effect: the subscription is still TEAM, and it is going to be PRO on a known
-- date. The row had nowhere to say that. `plan` is the plan in force, and
-- writing the future one into it would make every reader — enforcement, the
-- usage meters, the plan card — apply the downgrade immediately, which is the
-- exact thing period-end scheduling exists to prevent.
--
-- WHAT WRITES THEM
-- ---------------------------------------------------------------------------
-- Only after the PROVIDER confirms the schedule. `pending_plan` is never an
-- intention we hold locally and hope to deliver; it is the provider's own
-- accepted schedule, recorded so the product can tell the customer what will
-- happen and when. When the change takes effect the provider says so, the
-- webhook applies it through the one plan writer, and both columns are cleared.
--
-- EXPAND-SAFE
-- ---------------------------------------------------------------------------
-- Two nullable columns, no default, no backfill, no rewrite. NULL means "no
-- change scheduled", which is what every existing row means today. Old API and
-- Worker builds neither read nor write them, so a rolling deployment in either
-- order is safe, and a rollback loses a schedule the provider still holds
-- rather than corrupting a plan anyone is on.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "pending_plan" "PlanType";

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "pending_plan_effective_at_utc" TIMESTAMPTZ(6);
