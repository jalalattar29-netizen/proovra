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
-- ON DELETE CASCADE / ON UPDATE RESTRICT:
--   A report version is immutable, so ON UPDATE RESTRICT can never fire in normal
--   operation and refuses a stray version renumber. ON DELETE CASCADE is the
--   forensically correct and operationally safe policy: a package cannot outlive
--   the report it certifies, and cascade removes any ordering hazard with the
--   destruction executor (which already deletes packages before reports) and with
--   evidence-level cascade deletes. It NEVER rewrites report or package BYTES —
--   it only removes a package row when its exact report version is removed.

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
      ON UPDATE RESTRICT ON DELETE CASCADE;
  END IF;
END $$;
