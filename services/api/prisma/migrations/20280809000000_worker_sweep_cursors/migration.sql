-- WORKER SWEEP CURSORS (2026-09-29, ET-Q-05). Additive only: one new table.
--
-- The trash-grace reconciler re-read the same oldest 200 TRASHED rows every
-- tick; once 200 of them were blocked (hold, retention, Object Lock, approval
-- pending) no eligible record behind them was ever reached. A keyset cursor
-- per sweep lets each tick continue past the rows the previous one examined.
-- The worker reads it fail-open (no table => start at the beginning), so this
-- is safe before or after the worker image.

CREATE TABLE IF NOT EXISTS "worker_sweep_cursors" (
  "key"        VARCHAR(64) NOT NULL,
  "cursor_at"  TIMESTAMPTZ(6),
  "cursor_id"  UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "worker_sweep_cursors_pkey" PRIMARY KEY ("key")
);
