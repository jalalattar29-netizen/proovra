-- Nullable actor + public flag. New rows use user_id NULL with is_public true.
-- Legacy rows may keep user_id '__public_verify__' so existing chain hashes stay valid.

ALTER TABLE "admin_audit_logs" ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "admin_audit_logs" ALTER COLUMN "user_id" DROP NOT NULL;

UPDATE "admin_audit_logs" SET "is_public" = true WHERE "user_id" = '__public_verify__';
