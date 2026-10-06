-- DURABLE PROGRESS for a report / verification-package request.
--
-- The Artifacts & Versions tab follows a request through seven steps (accepted,
-- queued, generating report, verifying report, building the package, verifying
-- the package, complete) and must show the SAME step after a reload, in a second
-- tab, to another workspace member and after a reconnect. Nothing may advance on
-- a client timer, so the step a running request has reached must be durable.
--
-- `stage` cannot carry it: REPORT_RESERVED / REPORT_COMMITTED / PACKAGE_PUBLISHED
-- fence version reservation and the commit (the worker refuses to commit unless
-- the row is still REPORT_RESERVED), so display steps written there would break
-- the fence. Two new nullable columns hold the display step and when it was
-- reached; the worker writes them with the same claim fence as every other
-- update to the row. A failed request keeps the step it failed at, which is the
-- "exact safe stage" a failure is reported against.
--
-- Additive and expand-only: nullable, no default, no backfill, no index, no
-- rewrite. Old code ignores the columns; rollback is code-first (leave them).
ALTER TABLE "report_generation_requests" ADD COLUMN "progress_stage" VARCHAR(32);
ALTER TABLE "report_generation_requests" ADD COLUMN "progress_at_utc" TIMESTAMPTZ(6);
