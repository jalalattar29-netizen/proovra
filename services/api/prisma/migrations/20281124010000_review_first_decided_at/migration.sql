-- Stage C (T-044, team remediation 2026-11-24): the first-review SLA dimension
-- completes on the review's FIRST recorded decision, not on Start. The fact gets
-- its own nullable column: additive, no default, no index, metadata-only lock.
-- The rollback image never reads or writes it.
--
-- No backfill here. Existing rows are filled from the immutable decision log by
-- the idempotent, audited repair job `ops:repair-review-sla-truth --apply`
-- (kind first_decided_at), run once after this migration.
ALTER TABLE "evidence_review_workflows" ADD COLUMN "first_decided_at_utc" TIMESTAMPTZ(6);
