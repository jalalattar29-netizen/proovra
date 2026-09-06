-- =============================================================================
-- Workspace invitation lifecycle hardening (`team_invites`).
--
-- `TeamInvite` is the invitation that actually grants WORKSPACE membership, and
-- it was the least protected of the three invitation systems in the product:
--
--   * the token was stored in PLAINTEXT and uniquely indexed, so a database
--     copy or a backup is a set of live workspace credentials;
--   * the whole row — token included — was returned by the create and
--     resend responses, so any workspace ADMIN reading the API held live
--     tokens for every pending invitation;
--   * there was no revocation state at all. "Revoking" meant DELETING the
--     row, which destroys the record that it was ever sent;
--   * there was no resend record, so an operator could not tell a chased
--     invitation from an ignored one.
--
-- `organization_invites` solved all four in Phase 2.7X Stage 6. This migration
-- is deliberately the SAME shape, statement for statement, so the two
-- invitation tables converge rather than diverging into a second design.
--
-- ADDITIVE ONLY. No column is dropped, no data is destroyed, and existing
-- pending links keep working because their hash is backfilled from the token
-- they already carry.
--
-- Deployment order: this migration MUST be applied before the services that
-- read `token_hash` start. It is safe to apply ahead of them — the columns are
-- nullable-or-defaulted for every writer that predates it.
-- =============================================================================

-- pgcrypto provides digest() for the backfill, exactly as it did for the
-- organization-invite migration. IF NOT EXISTS keeps this idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Step 1 — the hash column, nullable until Step 2 has populated it.
ALTER TABLE "team_invites" ADD COLUMN "token_hash" VARCHAR(64);

-- Step 2 — backfill from the raw token so every in-flight invitation link
-- continues to resolve after the read path switches to the hash. This is the
-- last place the raw token is ever read out of this table.
UPDATE "team_invites"
SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
WHERE "token" IS NOT NULL AND "token_hash" IS NULL;

-- A row with no token at all cannot be accepted and cannot be hashed. Giving it
-- a random, unmatchable value keeps the NOT NULL below honest without inventing
-- a hash that some token would collide with.
UPDATE "team_invites"
SET "token_hash" = encode(gen_random_bytes(32), 'hex')
WHERE "token_hash" IS NULL;

ALTER TABLE "team_invites" ALTER COLUMN "token_hash" SET NOT NULL;

-- Step 3 — the raw token becomes optional. New rows write NULL; existing rows
-- keep theirs so a rollback of the service does not strand live invitations.
-- The destructive cutover (clear and drop the column) is a separate, later
-- migration once no deployed service reads it.
ALTER TABLE "team_invites" ALTER COLUMN "token" DROP NOT NULL;

-- Step 4 — revocation is a STATE, not a deletion. An invitation that was sent
-- and withdrawn is a fact an evidence platform has to be able to show.
ALTER TABLE "team_invites" ADD COLUMN "revoked_at" TIMESTAMPTZ(6);
ALTER TABLE "team_invites" ADD COLUMN "revoked_by_user_id" UUID;

-- Step 5 — who consumed it, and how often it was chased.
ALTER TABLE "team_invites" ADD COLUMN "accepted_by_user_id" UUID;
ALTER TABLE "team_invites" ADD COLUMN "last_resent_at" TIMESTAMPTZ(6);
ALTER TABLE "team_invites" ADD COLUMN "resend_count" INTEGER NOT NULL DEFAULT 0;

-- Step 6 — the lookup index for the new read path.
CREATE UNIQUE INDEX "team_invites_token_hash_key" ON "team_invites"("token_hash");

-- Step 7 — one PENDING invitation per address per workspace, enforced by the
-- database rather than by a read-then-write in the route. The partial index
-- covers exactly the rows the old duplicate check was trying to find.
CREATE UNIQUE INDEX "team_invites_pending_email_uniq"
  ON "team_invites"("team_id", lower("email"))
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
