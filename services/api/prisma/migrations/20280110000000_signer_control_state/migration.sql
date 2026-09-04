-- Persistent signer lifecycle control state.
--
-- RETIRE and REVOKE previously wrote no state at all: the service validated a
-- reason, bumped a counter, emitted a security event and returned ok. The read
-- model recomputes active signers from environment variables on every request,
-- so a "revoked" signer reappeared ACTIVE on the next page load and kept
-- signing. This table is the durable overlay that makes those two operations
-- mean something across restarts and deploys.
--
-- Forward-only. Holds no key material, no KMS credential, no secret.
--
-- Plain CREATE TABLE, not CREATE TABLE IF NOT EXISTS: Prisma applies a
-- migration exactly once and records it, so the guard buys nothing — while
-- IF NOT EXISTS would silently succeed against a table of a DIFFERENT shape
-- and hide the drift it was supposed to surface. The repo gate classifies it
-- CRITICAL for that reason.

CREATE TABLE "signer_control_state" (
  "signer_id"             VARCHAR(400) NOT NULL,
  "status"                VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "state_version"         INTEGER      NOT NULL DEFAULT 1,
  "first_seen_at_utc"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "status_changed_at_utc" TIMESTAMPTZ(6),
  "actor_user_id"         UUID,
  "reason"                VARCHAR(400),
  "transition_source"     VARCHAR(64),
  "created_at_utc"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at_utc"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "signer_control_state_pkey" PRIMARY KEY ("signer_id"),
  CONSTRAINT "signer_control_state_status_check"
    CHECK ("status" IN ('ACTIVE', 'RETIRED', 'REVOKED'))
);

CREATE INDEX "signer_control_state_status_idx"
  ON "signer_control_state" ("status");
