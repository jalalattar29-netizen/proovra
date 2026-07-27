-- PHASE 11 — authoritative tenant columns on admin_audit_logs for DB-level
-- scope filtering (additive, nullable; NOT part of the hash chain).
ALTER TABLE "admin_audit_logs" ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "admin_audit_logs" ADD COLUMN IF NOT EXISTS "workspace_id" UUID;
CREATE INDEX IF NOT EXISTS "admin_audit_logs_workspace_id_created_at_idx" ON "admin_audit_logs" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_organization_id_created_at_idx" ON "admin_audit_logs" ("organization_id", "created_at");
