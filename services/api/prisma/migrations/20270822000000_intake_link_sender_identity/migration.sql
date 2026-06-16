-- Intake-link enterprise messaging — sender identity columns.
--
-- Adds the two columns the operator chooses when creating a link:
--   - sender_display_mode: PROOVRA | WORKSPACE | CUSTOM (default PROOVRA)
--   - sender_display_name: free text, ONLY populated for CUSTOM mode,
--                          validated by shared.validateCustomSenderDisplayName
--
-- Backfill: every existing row gets sender_display_mode = 'PROOVRA' via
-- the DEFAULT clause; sender_display_name stays NULL. The resolver in
-- shared/intake-link-messaging.resolveIntakeSenderDisplay handles
-- WORKSPACE/CUSTOM modes; existing rows continue to render as
-- "PROOVRA secure intake" without any code change.
ALTER TABLE "workflow_intake_links"
  ADD COLUMN "sender_display_mode" VARCHAR(40) NOT NULL DEFAULT 'PROOVRA',
  ADD COLUMN "sender_display_name" VARCHAR(80);
