-- =============================================================================
-- 2026-11-01 — WORKFLOW-009: a message records whether its stored preview is the
-- whole message.
--
-- EXPAND / SAFE_TO_APPLY_NOW, no backfill. Raw bodies are not stored, and a retry
-- resent the preview, so a recipient could be sent "[secure-link]", a cut-off text
-- or the literal "(retry)" while the row read SENT.
--
-- The default is false on purpose. An existing row cannot prove its preview is
-- complete, so it is not resent; a new row states it when it is written. Adding a
-- column with a constant default rewrites no row.
--
-- Apply BEFORE the API image: its Prisma client maps the column.
-- =============================================================================

ALTER TABLE "communication_messages"
  ADD COLUMN IF NOT EXISTS "body_resendable" BOOLEAN NOT NULL DEFAULT false;
