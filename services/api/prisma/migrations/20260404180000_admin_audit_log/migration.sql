-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platform_role" VARCHAR(32);

-- CreateTable
CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "hash" VARCHAR(64) NOT NULL,
    "prev_hash" VARCHAR(64),
    "anchored_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_audit_logs_user_id_idx" ON "admin_audit_logs"("user_id");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");
