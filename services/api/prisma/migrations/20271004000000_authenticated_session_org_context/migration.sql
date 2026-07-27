-- PHASE 10 §2 (2026-07-23) — AUTHENTICATED SESSION ORGANIZATION CONTEXT.
--
-- `authenticated_sessions.team_id` is the issue-time workspace; it does NOT
-- identify the ORGANIZATION context a global session currently occupies. This
-- adds `organization_context_id` — the ONE Organization whose context the
-- session currently holds — so the Organization-scoped concurrent-session limit
-- counts DISTINCT active sessionIds per (user, organization), idempotently
-- across workspace switches inside the same Organization. NULL for Personal /
-- OWNED / no context. ON DELETE SET NULL. Additive + safe. NOT APPLIED.

ALTER TABLE "authenticated_sessions"
  ADD COLUMN IF NOT EXISTS "organization_context_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticated_sessions_organization_context_id_fkey'
  ) THEN
    ALTER TABLE "authenticated_sessions"
      ADD CONSTRAINT "authenticated_sessions_organization_context_id_fkey"
      FOREIGN KEY ("organization_context_id") REFERENCES "organizations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "authenticated_sessions_user_org_active_idx"
  ON "authenticated_sessions"("user_id", "organization_context_id", "revoked_at_utc", "expires_at_utc");
