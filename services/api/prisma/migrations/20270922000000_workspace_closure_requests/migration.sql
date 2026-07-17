-- Lifecycle Phase 7 (2026-07-17) — workspace closure requests.
--
-- Pure-additive: CREATE TABLE IF NOT EXISTS + guarded indexes + FKs in
-- DO/duplicate_object blocks. No backfill (closure requests start empty).
-- Nothing destructive: no object removals or row mutations of any kind.

CREATE TABLE IF NOT EXISTS "workspace_closure_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
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

    CONSTRAINT "workspace_closure_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "workspace_closure_requests_team_id_status_idx"
    ON "workspace_closure_requests"("team_id", "status");

CREATE INDEX IF NOT EXISTS "workspace_closure_requests_status_cooling_off_ends_at_utc_idx"
    ON "workspace_closure_requests"("status", "cooling_off_ends_at_utc");

DO $$
BEGIN
    ALTER TABLE "workspace_closure_requests"
        ADD CONSTRAINT "workspace_closure_requests_team_id_fkey"
        FOREIGN KEY ("team_id") REFERENCES "teams"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "workspace_closure_requests"
        ADD CONSTRAINT "workspace_closure_requests_requested_by_user_id_fkey"
        FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
