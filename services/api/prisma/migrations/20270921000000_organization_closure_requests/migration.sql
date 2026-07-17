-- Lifecycle Phase 6 (2026-07-17) — organization closure requests.
--
-- Pure-additive: CREATE TABLE IF NOT EXISTS + guarded indexes + FKs in
-- DO/duplicate_object blocks. No backfill (closure requests start empty).
-- Nothing destructive: no object removals or row mutations of any kind.

CREATE TABLE IF NOT EXISTS "organization_closure_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
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

    CONSTRAINT "organization_closure_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "organization_closure_requests_organization_id_status_idx"
    ON "organization_closure_requests"("organization_id", "status");

CREATE INDEX IF NOT EXISTS "organization_closure_requests_status_cooling_off_ends_at_u_idx"
    ON "organization_closure_requests"("status", "cooling_off_ends_at_utc");

DO $$
BEGIN
    ALTER TABLE "organization_closure_requests"
        ADD CONSTRAINT "organization_closure_requests_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "organization_closure_requests"
        ADD CONSTRAINT "organization_closure_requests_requested_by_user_id_fkey"
        FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
