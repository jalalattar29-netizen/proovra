ALTER TABLE "evidence"
ADD COLUMN "intake_plan_json" JSONB;

ALTER TABLE "evidence_parts"
ADD COLUMN "private_role" VARCHAR(120);

ALTER TABLE "evidence_parts"
ADD COLUMN "private_note" VARCHAR(1000);

ALTER TABLE "evidence_parts"
ADD COLUMN "checklist_step_id" VARCHAR(120);

ALTER TABLE "evidence_parts"
ADD COLUMN "source_label" VARCHAR(120);

ALTER TABLE "evidence_parts"
ADD COLUMN "client_signals" JSONB;
