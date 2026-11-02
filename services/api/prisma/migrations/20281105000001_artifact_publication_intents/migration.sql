-- REPORT-006: an issued object is written to Object-Locked storage before the row
-- that references it commits. A commit that fails, or a crash between the two,
-- leaves a locked object nothing lists. The intent is written first, so such an
-- object can be counted against the report and package rows.

CREATE TABLE "artifact_publication_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "evidence_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "family" VARCHAR(32) NOT NULL,
    "storage_bucket" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "created_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_publication_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "artifact_publication_intents_bucket_key_key"
    ON "artifact_publication_intents" ("storage_bucket", "storage_key");
CREATE INDEX "artifact_publication_intents_created_at_idx"
    ON "artifact_publication_intents" ("created_at_utc");
CREATE INDEX "artifact_publication_intents_evidence_idx"
    ON "artifact_publication_intents" ("evidence_id");
