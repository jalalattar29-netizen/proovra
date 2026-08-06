-- ============================================================================
-- Track 1B — CaseEvidenceLink becomes the CANONICAL case ↔ evidence
-- relationship authority. FORWARD-ONLY migration.
--
--   1. `case_evidence_links.team_id` becomes NULLABLE. Personal-workspace
--      cases carry `team_id = NULL` (mirroring cases.team_id /
--      evidence.team_id); the previous NOT NULL made a personal-scope link
--      unrepresentable, which is why the legacy single-attach path could
--      never dual-write a link row.
--   2. Backfill: every legacy `evidence.case_id` attachment AT A CASE THAT
--      STILL EXISTS, and that has no canonical link row for the SAME
--      (case, evidence) pair, gains one (role PRIMARY, source SYSTEM, reason
--      'backfill:evidence.caseId').
--      Idempotent: INSERT .. SELECT .. WHERE NOT EXISTS — safe to re-run.
--
--      PHASE 12 POINT 6 — the `JOIN "cases"` is load-bearing and was missing.
--      `evidence.case_id` never carried a foreign key, so a pointer at a
--      deleted Case is possible. Without the join this backfill MANUFACTURED a
--      canonical link row pointing at a case that does not exist, and the very
--      next migration — which adds the real `case_evidence_links.case_id`
--      foreign key — then refused forever, because an orphan link is an
--      integrity finding it must not delete. Proven in the Point-6
--      production-like rehearsal: one dangling pointer blocked Release B
--      outright. A dangling pointer is an UNRESOLVED association; it stays
--      visible as `orphan_case_pointer` in the Release-D contract guard rather
--      than being converted into a broken canonical row.
--
-- NOTE — `evidence.case_id` column DROP is deliberately NOT included here.
--        The column remains a legacy-compat mirror, kept in sync by the ONE
--        canonical writer (services/api/src/services/cases/
--        case-evidence-link.service.ts) until its runtime readers reach
--        zero. A LATER migration performs the drop once the COMPAT_READERS
--        list is empty.
-- ============================================================================

ALTER TABLE "case_evidence_links"
  ALTER COLUMN "team_id" DROP NOT NULL;

INSERT INTO "case_evidence_links"
  ("team_id", "case_id", "evidence_id", "role", "source", "reason",
   "linked_at_utc", "created_at", "updated_at")
SELECT
  e."team_id",
  e."case_id",
  e."id",
  'PRIMARY'::"CaseEvidenceLinkRole",
  'SYSTEM'::"CaseEvidenceLinkSource",
  'backfill:evidence.caseId',
  now(),
  now(),
  now()
FROM "evidence" e
JOIN "cases" c ON c."id" = e."case_id"
WHERE e."case_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "case_evidence_links" l
    WHERE l."case_id" = e."case_id"
      AND l."evidence_id" = e."id"
  );
