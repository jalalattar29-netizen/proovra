-- =============================================================================
-- 2028-11-21 — RG-05 (PRO-AI1-04 / PRO-AI1Z-01): automatic cloud OCR and
-- transcription write the text they paid for into the canonical extracted-text
-- table, ONCE PER SOURCE PART.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column and one partial unique
-- index. Existing rows keep source_part_id NULL and are outside the index, so
-- nothing about them changes. An older image never reads or writes the column.
--
-- The index is the claim: an extraction of part P by provider X holds a
-- PENDING row (and later the COMPLETED row) for (evidence, P, X); a retried or
-- concurrent execution of the same request finds it and makes no provider call
-- and spends no plan operation. A FAILED row leaves the index, so a genuine
-- failure can be retried.
--
-- Rollback: drop the index, then the column (no other object depends on them).
-- =============================================================================

ALTER TABLE "evidence_extracted_texts"
  ADD COLUMN "source_part_id" UUID NULL;

CREATE UNIQUE INDEX "evidence_extracted_texts_part_claim_uniq"
  ON "evidence_extracted_texts" ("evidence_id", "source_part_id", "provider")
  WHERE "source_part_id" IS NOT NULL AND "status" IN ('PENDING', 'COMPLETED');
