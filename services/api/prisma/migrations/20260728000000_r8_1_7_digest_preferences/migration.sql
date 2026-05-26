-- PHASE R8.1.7 — admin digest preferences + per-admin digest log.
--
-- Append-only:
--   - mfa_admin_digest_preferences (per-user-per-team digest opt-out)
--   - mfa_recovery_admin_digest_logs (per-admin-per-day idempotency)
-- No existing table modified.

-- =============================================================================
-- mfa_admin_digest_preferences
-- =============================================================================

CREATE TABLE "mfa_admin_digest_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID,
    "digest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "suppress_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "mfa_admin_digest_preferences_pkey" PRIMARY KEY ("id")
);

-- Postgres UNIQUE constraints with NULL columns treat NULLs as
-- distinct by default. That gives us the semantics we want — at
-- most one row per (user, team) AND at most one global (user,
-- NULL) row per user. Note: technically `UNIQUE (userId, teamId)`
-- in Postgres allows multiple NULLs; we enforce one-global-row
-- semantics at the service layer via upsert-by-conditional-find.
CREATE UNIQUE INDEX "mfa_admin_digest_preferences_user_id_team_id_key"
    ON "mfa_admin_digest_preferences" ("user_id", "team_id");
CREATE INDEX "mfa_admin_digest_preferences_user_id_idx"
    ON "mfa_admin_digest_preferences" ("user_id");

ALTER TABLE "mfa_admin_digest_preferences"
    ADD CONSTRAINT "mfa_admin_digest_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mfa_admin_digest_preferences"
    ADD CONSTRAINT "mfa_admin_digest_preferences_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- mfa_recovery_admin_digest_logs
-- =============================================================================

CREATE TABLE "mfa_recovery_admin_digest_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "sent_date" VARCHAR(10) NOT NULL,
    "sent_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "team_count" INTEGER NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mfa_recovery_admin_digest_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_admin_digest_logs_user_id_sent_date_key"
    ON "mfa_recovery_admin_digest_logs" ("user_id", "sent_date");
CREATE INDEX "mfa_recovery_admin_digest_logs_sent_at_utc_idx"
    ON "mfa_recovery_admin_digest_logs" ("sent_at_utc");

ALTER TABLE "mfa_recovery_admin_digest_logs"
    ADD CONSTRAINT "mfa_recovery_admin_digest_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
