CREATE TABLE IF NOT EXISTS "evidence_parts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "part_index" INTEGER NOT NULL,
  "storage_bucket" VARCHAR(255) NOT NULL,
  "storage_key" VARCHAR(512) NOT NULL,
  "size_bytes" BIGINT,
  "mime_type" VARCHAR(128),
  "sha256" VARCHAR(64),
  "duration_ms" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "evidence_parts_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_parts_evidence_id_part_index_key" ON "evidence_parts"("evidence_id","part_index");
CREATE INDEX IF NOT EXISTS "evidence_parts_evidence_id_idx" ON "evidence_parts"("evidence_id");
