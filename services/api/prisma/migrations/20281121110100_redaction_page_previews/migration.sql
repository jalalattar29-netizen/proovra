-- PRO-R3-04 — rendered page previews for the PDF redaction editor.
--
-- The editor drew regions on a blank frame: nothing rendered the page. One
-- row per (project, page) is the durable authority of the worker's
-- `redaction-page-preview` job (QUEUED -> RENDERING -> READY | FAILED); the
-- stored object is a derived working image of the page, read only by people
-- who may author regions on that project.
--
-- Expand-only: a new table, no change to an existing one. An API or worker
-- that predates it never reads or writes it.
CREATE TABLE "redaction_page_previews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "page_index" INTEGER NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    "render_started_at" TIMESTAMPTZ(6),
    "storage_bucket" VARCHAR(255),
    "storage_key" VARCHAR(600),
    "byte_size" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "failure_reason" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "redaction_page_previews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "redaction_page_previews_project_id_page_index_key" ON "redaction_page_previews"("project_id", "page_index");

CREATE INDEX "redaction_page_previews_team_id_idx" ON "redaction_page_previews"("team_id");

CREATE INDEX "redaction_page_previews_evidence_id_idx" ON "redaction_page_previews"("evidence_id");

CREATE INDEX "redaction_page_previews_state_updated_at_idx" ON "redaction_page_previews"("state", "updated_at");

ALTER TABLE "redaction_page_previews" ADD CONSTRAINT "redaction_page_previews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "redaction_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
