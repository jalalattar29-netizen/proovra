-- =============================================================================
-- 2026-11-01 — record when a password was proven together with its mailbox.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. One nullable column on users. NULL
-- means no proof is recorded: nothing about an existing password can be known
-- after the fact, so no row is stamped here. Only the first ownership of a
-- customer organization reads it; every other sign-in and read is unchanged.
-- =============================================================================

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "credential_proven_at_utc" TIMESTAMPTZ(6);

-- PROV-001 — every first owner is now invited, so the workspace name an operator
-- states waits on the organization with the seat count until acceptance.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "pending_enterprise_workspace_name" VARCHAR(120);
