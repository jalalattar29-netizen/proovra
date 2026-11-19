-- PRO-R2-17 — append-only history of coded review values.
--
-- coding_values keeps ONE mutable row per (workflow, field): a later write
-- replaced the value, its author and its rationale, and nothing recorded what
-- was there before. Every write now also appends a row here, so two reviewers'
-- values for the same field are both retained, in order.
--
-- Expand-only: a new table, no change to an existing one. An API that
-- predates it never reads or writes it.
CREATE TABLE "coding_value_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "author_user_id" UUID,
    "rationale" VARCHAR(800),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coding_value_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coding_value_history_workflow_id_field_id_recorded_at_idx" ON "coding_value_history"("workflow_id", "field_id", "recorded_at");

CREATE INDEX "coding_value_history_team_id_idx" ON "coding_value_history"("team_id");

ALTER TABLE "coding_value_history" ADD CONSTRAINT "coding_value_history_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "coding_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
