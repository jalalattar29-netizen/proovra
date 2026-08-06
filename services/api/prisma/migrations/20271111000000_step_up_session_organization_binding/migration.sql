-- PHASE 12B B3 — bind every step-up challenge to the session that started it
-- and to the Organization it was minted against.
--
-- WHY
--   Before this change an APPROVED step-up challenge was effectively a bearer
--   token: it was bound to (team, user, purpose, resource, expiry) but NOT to
--   the session. A stolen cookie replayed from another device could spend an
--   elevation the legitimate operator had just approved on their own device.
--   The Organization was only implied transitively through team_id.
--
-- SHAPE
--   Both columns are NULLABLE and additive. Rows created before this migration
--   cannot be backfilled with a session hash (the session may no longer exist),
--   so the service layer enforces "must match WHEN PRESENT". Every challenge
--   created after this migration is written with both columns populated, and
--   because the maximum challenge TTL is one hour, the unbound window closes on
--   its own shortly after deploy — no backfill job is required.
--
-- FORWARD-ONLY. No data is rewritten and no existing column is altered, so this
-- is safe to apply while the previous API build is still serving traffic.

ALTER TABLE "step_up_challenges"
  ADD COLUMN IF NOT EXISTS "session_id_hash" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;

-- Supports the consume-path lookup (challenge by id + team) staying index-only
-- while additionally filtering on the session binding, and lets a security
-- investigation enumerate every elevation minted from one compromised session.
CREATE INDEX IF NOT EXISTS "step_up_challenges_session_id_hash_idx"
  ON "step_up_challenges" ("session_id_hash");

CREATE INDEX IF NOT EXISTS "step_up_challenges_organization_id_status_idx"
  ON "step_up_challenges" ("organization_id", "status");
