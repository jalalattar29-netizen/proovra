-- PHASE R8.1.6 — pending-digest idempotency log.
--
-- Used by the worker's `runMfaRecoveryDigest` scheduler to avoid
-- emailing org owners/admins more than once per day per team.
-- Append-only — no existing table modified.

CREATE TABLE "mfa_recovery_digest_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "sent_date" VARCHAR(10) NOT NULL,
    "sent_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "mfa_recovery_digest_logs_pkey" PRIMARY KEY ("id")
);

-- One digest per team per UTC day.
CREATE UNIQUE INDEX "mfa_recovery_digest_logs_team_id_sent_date_key"
    ON "mfa_recovery_digest_logs" ("team_id", "sent_date");

CREATE INDEX "mfa_recovery_digest_logs_sent_at_utc_idx"
    ON "mfa_recovery_digest_logs" ("sent_at_utc");

ALTER TABLE "mfa_recovery_digest_logs"
    ADD CONSTRAINT "mfa_recovery_digest_logs_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
