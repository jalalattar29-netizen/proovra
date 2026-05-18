-- Phase 8.5 — notification hardening
--
-- Adds one nullable JSONB column: template_context_json. Used by the
-- retry worker / manual resend to re-render the original template
-- without reaching back into mutable workspace state.
--
-- Privacy: the orchestrator validates the JSON payload at write time
-- against the renderer's TemplateContext shape. Reviewer notes, raw
-- token hashes, IPs, and other workspace internals are NEVER permitted
-- in this column.
--
-- Forward-only, additive. Rollback:
--   ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS template_context_json;

ALTER TABLE "notification_deliveries"
ADD COLUMN "template_context_json" JSONB;
