-- Ensure the evidence_file_sha256_idx index is consistent and safe.
-- This migration is intentionally idempotent for shadow DB usage.
DROP INDEX IF EXISTS "evidence_file_sha256_idx";
CREATE INDEX "evidence_file_sha256_idx" ON "evidence"("file_sha256");
