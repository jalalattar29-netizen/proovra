-- RGA-05 — DATABASE-ENFORCED package -> report-version pairing.
--
-- A verification package certifies and embeds exactly ONE report version. That
-- pairing (verification_packages.report_version = reports.version for the same
-- evidence) was enforced only in application code. For a forensic artifact that
-- is insufficient: a defect, a manual repair or a future code path could persist
-- a package that references a report version which does not exist for its
-- evidence, or a different version than it embeds, and nothing at the database
-- would refuse it. This migration makes the pairing a database invariant.
--
-- WHY A COMPOSITE FOREIGN KEY (the direct form the audit asked for):
--   reports already carries UNIQUE (evidence_id, version), so a composite FK on
--   verification_packages (evidence_id, report_version) can reference it exactly.
--   Legacy packages written before the report_version column carry NULL there;
--   MATCH SIMPLE (the default) does not enforce a row whose referencing columns
--   include a NULL, so those historical rows are preserved untouched.
--
-- ON DELETE RESTRICT / ON UPDATE RESTRICT (forensic fail-closed):
--   A report version is immutable, so ON UPDATE RESTRICT can never fire in normal
--   operation and refuses a stray version renumber. ON DELETE RESTRICT is the
--   forensically correct policy for an evidence platform: an ordinary, accidental
--   or unauthorized deletion of a report row while its verification package still
--   exists is REFUSED, so a package can never be silently vacuumed by removing the
--   report it certifies. This is safe against every real deletion path:
--     * lawful destruction (packages/shared-runtime evidence-destruction/executor)
--       deletes verification_packages BEFORE reports in one governed transaction,
--       so the package reference is already gone when the report row is deleted;
--     * the evidence row is TOMBSTONED (lifecycle_state=DESTROYED), never
--       hard-deleted, and reports->evidence carries NO ON DELETE CASCADE, so an
--       evidence delete never cascade-deletes a report out from under a package;
--     * the executor is the ONLY path that deletes a report row (verified by repo
--       grep: no other report.delete/deleteMany exists).
--   The constraint rewrites no report or package BYTES.

-- 1. PREFLIGHT — FAIL CLOSED. Refuse to apply if any package already references a
--    report version that does not exist for its evidence. No destructive
--    auto-correction: an operator reconciles the data first. (On a clean
--    database this inspects zero rows and passes.)
DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM verification_packages vp
  WHERE vp.report_version IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM reports r
      WHERE r.evidence_id = vp.evidence_id
        AND r.version = vp.report_version
    );

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'RGA-05 preflight: % verification_packages row(s) reference a (evidence_id, report_version) with no matching reports row. Reconcile these before applying this migration; it performs no automatic correction and rewrites no bytes.',
      orphan_count;
  END IF;
END $$;

-- 2. THE INVARIANT. Added idempotently so a re-run is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verification_packages_report_pair_fkey'
  ) THEN
    ALTER TABLE "verification_packages"
      ADD CONSTRAINT "verification_packages_report_pair_fkey"
      FOREIGN KEY ("evidence_id", "report_version")
      REFERENCES "reports" ("evidence_id", "version")
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;
