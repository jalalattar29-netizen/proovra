-- =============================================================================
-- 2026-11-21 — MATRIX-M626 (owner decision I): a SEALED record stored with
-- team_id NULL is destroyed only with its own owner's explicit approval.
--
-- `resolveDestructionApproval` exempted every team-less record from the
-- approval requirement ("teamId == null needs no review"), so the trash-grace
-- reconciler, the purge job and the executor could destroy a sealed legacy
-- personal record without anyone approving it. The approval requirement is now
-- decided by canonical ownership: a workspace record needs its workspace's
-- review (Enterprise: the governed two-person path), and a sealed team-less
-- record needs its owner's approval. `destruction_reviews.team_id` is NOT NULL
-- and no workspace is fabricated for a legacy record, so the owner's approval
-- lives here: one row per record per trash cycle, written only by the owner's
-- own call for that one record (never bulk-written, nothing backfilled).
--
-- UNSEALED abandoned uploads (CREATED / UPLOADING) keep their own lifecycle and
-- never read this table.
--
-- EXPAND / SAFE_TO_APPLY_NOW. A new table, no change to any existing table,
-- no backfill. An older image never reads or writes it (it then keeps the old
-- exemption until the new image runs). Rollback: leave the table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "evidence_owner_destruction_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "evidence_deleted_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "approved_at_utc" TIMESTAMPTZ(6) NOT NULL,
  "withdrawn_at_utc" TIMESTAMPTZ(6),
  "request_id" VARCHAR(128),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "evidence_owner_destruction_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_owner_destruction_approvals_cycle_key"
  ON "evidence_owner_destruction_approvals" ("evidence_id", "evidence_deleted_at_utc");

CREATE INDEX IF NOT EXISTS "evidence_owner_destruction_approvals_owner_user_id_idx"
  ON "evidence_owner_destruction_approvals" ("owner_user_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_owner_destruction_approvals_evidence_id_fkey'
  ) THEN
    ALTER TABLE "evidence_owner_destruction_approvals"
      ADD CONSTRAINT "evidence_owner_destruction_approvals_evidence_id_fkey"
      FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_owner_destruction_approvals_owner_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_owner_destruction_approvals"
      ADD CONSTRAINT "evidence_owner_destruction_approvals_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
