-- PRO-X1-04 (DEC-29) — an extension session minted from a web session records
-- the authorizing (parent) session's hashed id, so ending the parent (web
-- sign-out) also ends the extension authority it issued. Expand-only: a
-- nullable column and an index; older API builds never read or write it, and
-- rows written before this migration simply have no parent.
ALTER TABLE "authenticated_sessions" ADD COLUMN IF NOT EXISTS "parent_session_id_hash" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "authenticated_sessions_user_id_parent_session_id_hash_idx"
  ON "authenticated_sessions" ("user_id", "parent_session_id_hash");
