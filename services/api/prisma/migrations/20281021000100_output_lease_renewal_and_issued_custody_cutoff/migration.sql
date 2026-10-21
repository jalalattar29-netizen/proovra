-- F-05 / F-06 (independent forward audit, 2026-10-21) — TWO NULLABLE COLUMNS.
-- EXPAND ONLY.
--
-- report_generation_requests.lease_renewed_at_utc (F-06): a report / package
-- run renews its claim's lease with a fenced heartbeat. The claim lease was a
-- fixed 15 minutes from claimed_at_utc with no renewal, so the stranded-request
-- reconciler released the claim of a run that was still working (a large
-- package), its fenced commit rolled back, and every retry repeated it until
-- the claim ceiling made the request terminal. A claim is live while
-- claimed_at_utc OR lease_renewed_at_utc is within the lease; claimed_at_utc
-- stays the fence. NULL on every existing row (= not renewed: the old rule).
--
-- reports.issuance_custody_through_sequence (F-05): the last custody sequence
-- of a report's issuance (its commit transaction's own events included). A
-- package built later for that version carries exactly the chain through it —
-- a cut by SEQUENCE. It was chosen by event TIME (atUtc <= generated_at_utc),
-- and atUtc is not monotonic in sequence, so one later event dated before the
-- issuance pulled every event recorded after it into the package. NULL on rows
-- issued before it (they keep the earlier rule).
--
-- SAFE BEFORE THE NEW CODE: nothing reads or writes either column until the new
-- images run. No row is rewritten. Idempotent. ROLLBACK: drop the columns.

ALTER TABLE "report_generation_requests" ADD COLUMN IF NOT EXISTS "lease_renewed_at_utc" TIMESTAMPTZ(6);
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "issuance_custody_through_sequence" INTEGER;
