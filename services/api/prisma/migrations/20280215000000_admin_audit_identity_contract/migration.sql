-- PHASE 5 — the Admin audit identity and transition contract.
--
-- WHY THESE COLUMNS EXIST
--
-- `user_id` alone cannot answer "who acted". It is NULL for every automated
-- event, so a worker action and an anonymous action are indistinguishable; it
-- records no authority, so an action taken as platform staff looks the same as
-- one taken as a workspace member; and it resolves through a live join, so the
-- record becomes unreadable exactly when it matters most — after the account is
-- renamed, anonymised or deleted.
--
-- Likewise `outcome` could say only success/denied/error, which cannot express
-- the difference between "the API accepted the request", "the job is queued"
-- and "the work actually finished". An audit that calls an accepted request a
-- success is not a record of what happened.
--
-- FORWARD-ONLY AND NON-DESTRUCTIVE
--
-- Every column is nullable with no backfill. Historical rows keep NULL and are
-- rendered through the honest legacy fallback rather than being rewritten —
-- rewriting historical audit rows to improve their appearance is the one thing
-- an append-only trail must never do, and it would invalidate their hashes.
--
-- `event_version` defaults to 1 so existing rows describe themselves as the
-- pre-contract shape without an UPDATE touching a single one of them.
--
-- HASHING
--
-- These fields are bound into chain V4 (see lib/admin-audit-chain.ts). V1–V3
-- rows continue to verify with their own algorithm; the chain links across
-- versions through prev_hash, exactly as it already does for V1→V2→V3. An
-- attribution field that an attacker could edit while the rest of the row
-- stayed sealed would be worse than no field at all: it would look
-- authoritative and would not be.

ALTER TABLE "admin_audit_logs"
  ADD COLUMN IF NOT EXISTS "actor_type"      VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "actor_display"   VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "actor_authority" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "target_display"  VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "previous_state"  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "requested_state" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "resulting_state" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "reason_code"     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "event_version"   INTEGER NOT NULL DEFAULT 1;

-- Separating operator actions from automated ones is the first question asked
-- of an audit trail during an incident, so it gets an index rather than a scan.
CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_type_created_at_idx"
  ON "admin_audit_logs" ("actor_type", "created_at");
