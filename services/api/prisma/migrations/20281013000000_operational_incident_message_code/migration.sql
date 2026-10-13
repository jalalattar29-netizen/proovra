-- OPERATIONAL INCIDENT MESSAGE CODE (2026-10-13). Additive only: two nullable
-- columns on operational_incidents. Nothing is renamed, dropped, rewritten or
-- backfilled.
--
-- WHY. A condition's title and summary were stored only as English prose, so
-- no reader could render them in another language. A writer now records the
-- stable semantic code it rendered that prose from, and the structured params
-- it interpolated (ids, counts, outcomes — technical values, never prose):
--
--   message_code     e.g. 'ops.pipeline.report_generation_failed.not_retriable'
--   message_params   JSON object of the code's declared params
--
-- Clients resolve the code through the shared catalogue
-- (packages/shared/src/operations-condition-messages.ts). title/safe_summary
-- keep being written (rendered from the same catalogue, in English), so every
-- previous-release reader is unaffected.
--
-- LEGACY ROWS. Rows written before this migration keep NULL in both columns
-- and render their stored English text; no history is rewritten. A condition
-- that is observed again is re-stamped by its writer on that observation.
--
-- SAFE BEFORE THE NEW CODE: ADD COLUMN of a nullable column without a default
-- is a catalogue-only change (no table rewrite), and previous images never read
-- or write these columns. ROLLBACK is code-first; the columns stay.

ALTER TABLE "operational_incidents"
  ADD COLUMN IF NOT EXISTS "message_code" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "message_params" JSONB;
