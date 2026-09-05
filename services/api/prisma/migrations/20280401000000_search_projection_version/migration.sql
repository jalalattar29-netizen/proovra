-- Search documents record which build of the projection wrote them.
--
-- A search document is a cache of `buildEvidenceProjection`. When the
-- projection began indexing External Intake identity (Customer ID, recipient
-- name, address, phone) and the record's own identifiers, every document
-- already written became unable to answer a question about those fields — and
-- nothing could detect it, because the source row was never touched and the
-- reindex only ever looked for evidence with NO document at all.
--
-- DEFAULT 1, deliberately: every existing row predates the identity fields and
-- must be reported as stale so the reindex refreshes it. A default of the
-- current version would declare the entire production index healthy and leave
-- the defect in place behind a green number.
ALTER TABLE "evidence_search_documents"
  ADD COLUMN IF NOT EXISTS "projection_version" INTEGER NOT NULL DEFAULT 1;

-- The stale sweep asks exactly this question, per workspace, in bounded
-- batches: "which documents here are below the current version?"
--
-- `projection_version` is created immediately above, but `team_id` is not —
-- it is pre-existing, and an index naming a column this migration does not
-- create is the failure class the Phase O gate exists to prevent ("column does
-- not exist", mid-deploy, on somebody else's database). So the column is
-- verified against information_schema first and the index is created only if
-- it is really there.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'evidence_search_documents'
       AND column_name  = 'team_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS "evidence_search_documents_team_id_projection_version_idx"
      ON "evidence_search_documents" ("team_id", "projection_version");
  END IF;
END
$$;
