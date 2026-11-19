-- =============================================================================
-- PRO-P1-06 (WS-SHELL remediation) — Operations idempotency keys are RESERVED
-- before the effect, under a unique index, instead of being stamped after it.
--
-- A workflow action and a bulk run used to look their key up, run the effect,
-- then write the key: two concurrent requests with one key both found nothing
-- and both ran. The key is now inserted first; the loser of the race hits this
-- index and replays the winner's outcome.
--
-- EXPAND / SAFE_TO_APPLY_NOW. Two nullable columns and two unique indexes. NULL
-- is not equal to NULL in a Postgres unique index, so every existing row (all
-- NULL) and every row an older image writes (no value) is admitted. An older
-- image never reads the columns. Rollback: leave them (an older image keeps its
-- after-the-effect marker in metadata_json / result_json, which is still read).
-- =============================================================================

ALTER TABLE "operational_workflow_events"
  ADD COLUMN "idempotency_token" VARCHAR(200);

CREATE UNIQUE INDEX "operational_workflow_events_team_id_idempotency_token_key"
  ON "operational_workflow_events" ("team_id", "idempotency_token");

ALTER TABLE "bulk_operational_action_runs"
  ADD COLUMN "idempotency_token" VARCHAR(200);

CREATE UNIQUE INDEX "bulk_operational_action_runs_team_id_idempotency_token_key"
  ON "bulk_operational_action_runs" ("team_id", "idempotency_token");