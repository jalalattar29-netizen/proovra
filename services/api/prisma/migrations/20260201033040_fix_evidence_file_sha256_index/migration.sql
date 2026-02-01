-- This migration is intentionally idempotent for Prisma shadow DB.
-- The index may already exist depending on prior migrations.
DROP INDEX IF EXISTS "evidence_file_sha256_idx";
CREATE INDEX "evidence_file_sha256_idx" ON "evidence"("file_sha256");
