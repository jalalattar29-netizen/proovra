-- =============================================================================
-- VERIFICATION SHARE TOKENS (2026-09-30, ET-PKG-07). EXPAND.
--
-- Public verification was reachable at /verify/<evidence id>: the primary key,
-- which also appears in reports, packages, storage keys and internal URLs —
-- published by default, with no expiry, no rotation and no way to withdraw one
-- recipient's access without unpublishing the record for everyone.
--
-- 1. verification_share_tokens — one row per public link. Only the SHA-256 of
--    the token is stored (token_hash, unique): a database read cannot recover a
--    link. Each row is scoped to one evidence record and one projection, and
--    carries its audience, purpose, creator, optional expiry, optional use
--    limit, revocation (when, by whom, why), the link it replaced when rotated,
--    and last-used metadata.
--
-- 2. evidence.legacy_verify_uuid_until_utc — until when a record published
--    BEFORE tokens existed may still be verified by its id (the bounded
--    transition). NULL = never by id. Set once, by the backfill migration that
--    follows; an owner can end it earlier.
--
-- Additive only: nothing is rewritten here. Plain CREATE TABLE (not IF NOT
-- EXISTS, which would silently skip the block over a table of another shape).
-- =============================================================================

CREATE TABLE "verification_share_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "team_id" UUID,
  "token_hash" VARCHAR(64) NOT NULL,
  "purpose" VARCHAR(24) NOT NULL,
  "projection" VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  "audience" VARCHAR(120),
  "report_version" INTEGER,
  "created_by_user_id" UUID,
  "created_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at_utc" TIMESTAMPTZ(6),
  "revoked_at_utc" TIMESTAMPTZ(6),
  "revoked_by_user_id" UUID,
  "revocation_reason" VARCHAR(64),
  "rotated_from_id" UUID,
  "max_uses" INTEGER,
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "last_used_at_utc" TIMESTAMPTZ(6),
  CONSTRAINT "verification_share_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_share_tokens_evidence_id_fkey"
    FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "verification_share_tokens_token_hash_key"
  ON "verification_share_tokens" ("token_hash");

CREATE INDEX "verification_share_tokens_evidence_id_created_at_utc_idx"
  ON "verification_share_tokens" ("evidence_id", "created_at_utc");

CREATE INDEX "verification_share_tokens_team_id_idx"
  ON "verification_share_tokens" ("team_id");

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "legacy_verify_uuid_until_utc" TIMESTAMPTZ(6);
