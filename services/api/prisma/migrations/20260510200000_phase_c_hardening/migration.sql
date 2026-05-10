-- Phase C forensic hardening migration.
--
-- Additive: two new columns on evidence to make multipart hash semantics
-- explicit (Phase C #4). No existing rows touched, no values renamed.
--
-- Rollback risk: low. To reverse:
--   ALTER TABLE evidence DROP COLUMN multipart_manifest_sha256;
--   ALTER TABLE evidence DROP COLUMN hash_semantics;
--
-- Production deploy: pnpm --filter proovra-api prisma:migrate

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "multipart_manifest_sha256" VARCHAR(64);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "hash_semantics" VARCHAR(32);
