-- Phase 2 — API key dual-active rotation.
--
-- Adds three nullable columns to `api_credentials` so a rotated credential
-- can keep accepting its previous raw key for a short grace window. After
-- the window expires, the verify path rejects the previous hash. Columns
-- are nullable so credentials that have never been rotated read as
-- "no previous key in flight" (the canonical empty state).
--
-- Columns:
--   previous_key_hash         VARCHAR(128)  — HMAC of the prior raw key,
--                                              same scheme as key_hash.
--   previous_key_prefix       VARCHAR(32)   — operator-visible prefix of
--                                              the prior key, for audit /
--                                              display only.
--   previous_valid_until_utc  TIMESTAMPTZ   — inclusive cutoff after which
--                                              the verify path stops
--                                              accepting the previous key.
--
-- Indexes:
--   ix_api_credentials_previous_valid_until_utc — supports a future cron
--     sweeper that lazily clears expired previous_* triples; cheap because
--     most rows are NULL.
--   ux_api_credentials_previous_key_hash         — partial unique index on
--     the previous hash where it is NOT NULL. Mirrors the live `key_hash`
--     uniqueness invariant so two credentials cannot share the same prior
--     hash.
--
-- Hard rules satisfied:
--   * ADDITIVE ONLY — three nullable columns + two new indexes; no
--     column drops, renames, or backfills.
--   * IDEMPOTENT — every DDL uses IF NOT EXISTS so re-runs on a partially
--     applied DB are clean no-ops.
--   * NO LOCK ESCALATION — columns are added without DEFAULT so the
--     statement does not rewrite the table on Postgres 11+.
--   * INDEX names mirror the canonical drift-repair-friendly format
--     (lowercase, table-prefixed) used by the Phase O repair migrations.

SELECT 'Phase 2 dual-active rotation: additive nullable columns + 2 indexes on api_credentials.' AS phase2_rotation_readiness;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE "api_credentials"
  ADD COLUMN IF NOT EXISTS "previous_key_hash" VARCHAR(128);

ALTER TABLE "api_credentials"
  ADD COLUMN IF NOT EXISTS "previous_key_prefix" VARCHAR(32);

ALTER TABLE "api_credentials"
  ADD COLUMN IF NOT EXISTS "previous_valid_until_utc" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- 2. Index — sweep helper on the validity-window column.
--    Most rows are NULL so the index is small.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "api_credentials_previous_valid_until_utc_idx"
  ON "api_credentials" ("previous_valid_until_utc");

-- ---------------------------------------------------------------------------
-- 3. Unique partial index — prevents two credentials from sharing the same
--    "previous" hash. Mirrors the existing UNIQUE constraint on key_hash.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "api_credentials_previous_key_hash_uq"
  ON "api_credentials" ("previous_key_hash")
  WHERE "previous_key_hash" IS NOT NULL;
