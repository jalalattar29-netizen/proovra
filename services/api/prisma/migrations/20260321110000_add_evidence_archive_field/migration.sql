-- Add archived_at column to evidence table for archive functionality
-- This allows soft-archiving evidence without deletion, especially important for locked evidence.
-- - null = active evidence
-- - not null = archived evidence (hidden by default from list view)

ALTER TABLE "public"."evidence"
ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- Add indexes for efficient filtering
CREATE INDEX "evidence_archived_at_idx" ON "public"."evidence"("archived_at");
CREATE INDEX "evidence_owner_id_archived_at_idx" ON "public"."evidence"("owner_user_id", "archived_at");
