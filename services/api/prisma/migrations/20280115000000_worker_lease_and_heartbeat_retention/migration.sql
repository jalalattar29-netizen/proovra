-- Worker lease (current state) + a retention index for the heartbeat history.
--
-- WHY
-- ---------------------------------------------------------------------------
-- `worker_telemetry_snapshots` is append-only: one row per worker per
-- heartbeat interval, forever. At the shipped 60s interval that is 1,440 rows
-- per worker per day and nothing ever removed them. Every consumer of that
-- table reads only the LATEST row per worker or per kind, so the history was
-- being paid for and not used.
--
-- This migration adds `worker_leases`: one row per worker instance, updated
-- in place. Its size is the size of the fleet, not a function of uptime. It
-- also carries the thing the append-only table could not express at all — a
-- clean shutdown — so a drained worker can be told apart from a killed one.
--
-- The history table is KEPT and bounded by retention rather than dropped,
-- because it is read by the operations dashboard and the trust probes and
-- removing it here would be a silent capability change. The index added
-- below is what makes the retention sweep a range scan instead of a
-- sequential one: every existing index on that table leads with another
-- column, so none of them can serve `WHERE heartbeat_at_utc < $cutoff`.
--
-- FORWARD-ONLY. Nothing is dropped, nothing is backfilled, no existing row is
-- modified. An older API/worker keeps working against the untouched history
-- table while this is applied.

CREATE TYPE "WorkerLeaseState" AS ENUM ('STARTING', 'LIVE', 'DRAINING', 'STOPPED');

CREATE TABLE "worker_leases" (
    "worker_id" VARCHAR(120) NOT NULL,
    "worker_kind" "WorkerTelemetryKind" NOT NULL,
    "state" "WorkerLeaseState" NOT NULL,
    "started_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "stopped_at_utc" TIMESTAMPTZ(6),
    "shutdown_reason" VARCHAR(80),
    "build_revision" VARCHAR(64),
    "queue_subscriptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "heartbeat_interval_seconds" INTEGER,
    "processed_count" INTEGER,
    "failed_count" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("worker_id")
);

-- The canonical liveness read.
CREATE INDEX "worker_leases_state_last_seen_at_utc_idx"
    ON "worker_leases" ("state", "last_seen_at_utc" DESC);

-- Retention sweep predicate for the history table.
--
-- GUARDED, because this indexes a column this migration does not create.
-- The repository has been bitten by exactly that shape before (an index over
-- a column an earlier migration was assumed to have added, failing the deploy
-- with "column does not exist"), so the safety gate requires the existence
-- check to be explicit rather than assumed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'worker_telemetry_snapshots'
       AND column_name = 'heartbeat_at_utc'
  ) THEN
    CREATE INDEX IF NOT EXISTS "worker_telemetry_snapshots_heartbeat_at_utc_idx"
        ON "worker_telemetry_snapshots" ("heartbeat_at_utc");
  END IF;
END
$$;
