-- Lifecycle Phase 5 (2026-07-17) — personal account closure requests.
--
-- Pure-additive: CREATE TABLE IF NOT EXISTS + guarded indexes + FK in a
-- DO/duplicate_object block. No backfill (closure requests start empty).
-- Nothing destructive: no object removals or row mutations of any kind.

CREATE TABLE IF NOT EXISTS "account_closure_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
    "reason" VARCHAR(500),
    "blockers_json" TEXT,
    "requested_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cooling_off_ends_at_utc" TIMESTAMPTZ(6),
    "cancelled_at_utc" TIMESTAMPTZ(6),
    "started_at_utc" TIMESTAMPTZ(6),
    "completed_at_utc" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_closure_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "account_closure_requests_user_id_status_idx"
    ON "account_closure_requests"("user_id", "status");

CREATE INDEX IF NOT EXISTS "account_closure_requests_status_cooling_off_ends_at_utc_idx"
    ON "account_closure_requests"("status", "cooling_off_ends_at_utc");

DO $$
BEGIN
    ALTER TABLE "account_closure_requests"
        ADD CONSTRAINT "account_closure_requests_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
