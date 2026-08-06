-- ============================================================================
-- PHASE 12B CLUSTER 8 — `evidence_legal_holds` becomes the CANONICAL
-- legal-hold model. FORWARD-ONLY. ADDITIVE ONLY. NOTHING IS DROPPED.
--
-- WHY THIS TABLE
--   Three legal-hold stores existed: `evidence_legal_holds` (evidence-scoped),
--   `case_legal_holds` (case-scoped) and `legal_holds` (scope-generic). Only
--   `evidence_legal_holds` carried real referential integrity (FKs to teams,
--   evidence and users), a release note, a status enum and placed-by /
--   released-by attribution. It is extended into the canonical model rather
--   than replaced by a new polymorphic table, because a polymorphic target
--   column cannot be validated by the database and this migration must not
--   trade enforced integrity for convenience.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds the scope vocabulary + release-approval + provenance enums.
--   2. Adds EXPIRED to LegalHoldStatus (the scope-generic store had a state
--      `evidence_legal_holds` could not represent). NOT USED in this
--      migration — Postgres forbids using a newly-added enum label in the
--      transaction that added it. The backfill migration uses it.
--   3. Adds the canonical columns and makes `evidence_id` NULLABLE — required
--      ONLY because CASE and WORKSPACE scoped holds have no single evidence
--      target. Every pre-existing row keeps its evidence_id and gets
--      scope = 'EVIDENCE'.
--   4. Gives the bare `case_id` column referential integrity, plus new FKs
--      for `organization_id` and `release_approved_by_user_id`. Added
--      NOT VALID then VALIDATEd, so the long ACCESS EXCLUSIVE lock of a
--      validating FK add is avoided.
--   5. Adds a CHECK constraint keeping `scope` and the target columns
--      consistent.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It does not copy a single row out of `case_legal_holds` or
--     `legal_holds` — that is 20271107000000_legal_hold_backfill.
--   * It does not drop those tables or any column — that is
--     20271108000000_legal_hold_legacy_removal, which must run ONLY after the
--     backfill is applied AND verified.
--   * It never deletes, releases or weakens a hold. A hold that blocked
--     destruction before this migration blocks destruction after it.
--
-- ROW-COUNT EQUIVALENCE
--   count(evidence_legal_holds) is unchanged by this migration: no INSERT and
--   no DELETE is issued. The only writes are column defaults applied to
--   existing rows (scope='EVIDENCE', version=1,
--   source_store='EVIDENCE_LEGAL_HOLD', historical=false,
--   release_approval_state='NOT_REQUIRED'), which preserve the exact
--   pre-migration semantics of every row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LegalHoldScope') THEN
    CREATE TYPE "LegalHoldScope" AS ENUM ('EVIDENCE', 'CASE', 'WORKSPACE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LegalHoldReleaseApprovalState') THEN
    CREATE TYPE "LegalHoldReleaseApprovalState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LegalHoldSourceStore') THEN
    CREATE TYPE "LegalHoldSourceStore" AS ENUM ('EVIDENCE_LEGAL_HOLD', 'CASE_LEGAL_HOLD', 'LIFECYCLE_LEGAL_HOLD');
  END IF;
END
$$;

-- 2. EXPIRED joins LegalHoldStatus. Additive; existing ACTIVE / RELEASED rows
--    are untouched. Deliberately NOT referenced anywhere below — Postgres
--    refuses to use a label added in the same transaction.
ALTER TYPE "LegalHoldStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- ----------------------------------------------------------------------------
-- 3. Canonical columns
-- ----------------------------------------------------------------------------

ALTER TABLE "evidence_legal_holds"
  ADD COLUMN IF NOT EXISTS "scope" "LegalHoldScope" NOT NULL DEFAULT 'EVIDENCE',
  ADD COLUMN IF NOT EXISTS "organization_id" UUID,
  ADD COLUMN IF NOT EXISTS "expires_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "release_approval_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "release_approval_state" "LegalHoldReleaseApprovalState" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS "release_approved_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "release_approved_at_utc" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "policy_version_attribution" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "release_policy_version_attribution" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "source_store" "LegalHoldSourceStore" NOT NULL DEFAULT 'EVIDENCE_LEGAL_HOLD',
  ADD COLUMN IF NOT EXISTS "source_row_id" UUID,
  ADD COLUMN IF NOT EXISTS "historical" BOOLEAN NOT NULL DEFAULT false;

-- `evidence_id` becomes nullable ONLY so CASE / WORKSPACE scoped holds are
-- representable. Every existing row already has a value and keeps it; the
-- CHECK constraint below forbids an EVIDENCE-scoped row from losing it.
ALTER TABLE "evidence_legal_holds"
  ALTER COLUMN "evidence_id" DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. Referential integrity
-- ----------------------------------------------------------------------------

-- case_id: pre-existing bare column. RESTRICT — deleting a Case must never
-- silently destroy a preservation control.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_case_id_fkey'
  ) THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_case_id_fkey"
      FOREIGN KEY ("case_id") REFERENCES "cases"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;

-- VALIDATE is attempted, not asserted. `case_id` predates this migration with
-- NO foreign key, so a workspace may hold rows whose case row is already gone.
-- Those dangling references are DATA WE MUST NOT DESTROY: the constraint is
-- left NOT VALID (it still enforces every future write) and
-- services/api/scripts/legal-hold-convergence-report.mjs reports them under
-- the DANGLING_CASE_REF conflict class for operator resolution.
DO $$
BEGIN
  ALTER TABLE "evidence_legal_holds" VALIDATE CONSTRAINT "evidence_legal_holds_case_id_fkey";
EXCEPTION WHEN others THEN
  RAISE NOTICE 'evidence_legal_holds_case_id_fkey left NOT VALID: pre-existing dangling case_id references. Run legal-hold-convergence-report.mjs (conflict class DANGLING_CASE_REF).';
END
$$;

-- organization_id: brand-new column, always NULL at this point, so VALIDATE
-- is unconditional.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_organization_id_fkey'
  ) THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
    ALTER TABLE "evidence_legal_holds" VALIDATE CONSTRAINT "evidence_legal_holds_organization_id_fkey";
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_release_approved_by_user_id_fkey'
  ) THEN
    ALTER TABLE "evidence_legal_holds"
      ADD CONSTRAINT "evidence_legal_holds_release_approved_by_user_id_fkey"
      FOREIGN KEY ("release_approved_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
    ALTER TABLE "evidence_legal_holds" VALIDATE CONSTRAINT "evidence_legal_holds_release_approved_by_user_id_fkey";
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 5. Scope / target consistency CHECK
--
--   EVIDENCE  → evidence_id NOT NULL  (+ case_id NULL, IF the data allows —
--               see the measurement below)
--   CASE      → case_id NOT NULL and evidence_id NULL
--   WORKSPACE → team_id NOT NULL (the authoritative workspace target, stated
--               explicitly rather than merely inherited from the column's
--               NOT NULL + Team FK) and NEITHER row target set. A WORKSPACE
--               hold identified only by two NULLs is not acceptable: the
--               constraint must name what the hold actually targets.
--
-- HISTORICAL rows are exempt: an orphaned hold whose target row no longer
-- exists is PRESERVED (never dropped) with its targets nulled. That exemption
-- carries a runtime obligation, discharged in
-- services/api/src/services/governance/effective-legal-hold.ts: an ACTIVE
-- historical row FAILS CLOSED and blocks every record in its workspace,
-- because an unresolvable target cannot be proven not to cover a record.
--
-- THE EVIDENCE + case_id QUESTION — ANSWERED FROM THE DEPLOYED RUNTIME,
-- NOT FROM A POINT-IN-TIME ROW COUNT.
--   `case_id` predates this migration as a CONTEXTUAL TAG on an evidence hold
--   ("hold placed on this record, arising from that case"). The canonical
--   model reserves case_id for scope='CASE', so the strict rule would be
--   EVIDENCE ⇒ case_id IS NULL.
--
--   PHASE 12 POINT 6 — this block used to MEASURE the table and install the
--   strict form whenever it happened to find zero tagged rows. That was a
--   latent production outage. This migration is an EXPAND step: it runs
--   BEFORE the code that stops writing the tag. The runtime deployed at that
--   moment (`placeLegalHold` in services/api/src/services/governance.service.ts
--   at the pre-cutover build) passes `caseId: input.caseId ?? null` straight
--   into an EVIDENCE-scoped `evidenceLegalHold.create`. On any workspace that
--   simply had no tagged row yet, the strict CHECK would install and the very
--   next case-contextual legal hold placed by the still-deployed build would
--   be REJECTED by the database — a preservation control failing closed at the
--   moment an operator tries to place it.
--
--   So the EXPAND step installs the RELAXED branch UNCONDITIONALLY. It is the
--   only form the currently-deployed runtime is guaranteed to satisfy, and it
--   still enforces every invariant that matters here: an EVIDENCE hold must
--   name its evidence, a CASE hold must name its case and no evidence, and a
--   WORKSPACE hold must name its workspace and no row target.
--
--   Tightening to `EVIDENCE ⇒ case_id IS NULL` is a CONTRACT step, performed
--   by 20271118000000_legal_hold_strict_scope_target AFTER the runtime cutover
--   has shipped and the population has drained. That migration measures the
--   tag population itself and refuses rather than blanking it, so governance
--   context is never destroyed to make a constraint pass. Until then the
--   count is surfaced by legal-hold-convergence-report.mjs as conflict class
--   EVIDENCE_WITH_CASE_TAG.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  tagged_evidence_rows int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evidence_legal_holds_scope_target_chk'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO tagged_evidence_rows
  FROM "evidence_legal_holds"
  WHERE "scope" = 'EVIDENCE' AND "case_id" IS NOT NULL;

  RAISE NOTICE 'evidence_legal_holds: installing the EXPAND-SAFE scope/target CHECK (relaxed EVIDENCE branch). % EVIDENCE-scoped row(s) currently carry a contextual case_id tag; the tag is PRESERVED and the strict form is deferred to 20271118000000_legal_hold_strict_scope_target (post-cutover).', tagged_evidence_rows;

  ALTER TABLE "evidence_legal_holds"
    ADD CONSTRAINT "evidence_legal_holds_scope_target_chk" CHECK (
      "historical" = true
      OR ("scope" = 'EVIDENCE' AND "evidence_id" IS NOT NULL)
      OR ("scope" = 'CASE' AND "case_id" IS NOT NULL AND "evidence_id" IS NULL)
      OR ("scope" = 'WORKSPACE' AND "team_id" IS NOT NULL AND "evidence_id" IS NULL AND "case_id" IS NULL)
    ) NOT VALID;
  ALTER TABLE "evidence_legal_holds" VALIDATE CONSTRAINT "evidence_legal_holds_scope_target_chk";
END
$$;

-- ----------------------------------------------------------------------------
-- 6. Indexes
--
-- The (source_store, source_row_id) unique index is the deterministic
-- idempotency key of the backfill. Postgres treats NULLs as distinct, so
-- natively-authored rows (source_row_id NULL) are unconstrained while every
-- converted row can be inserted at most once.
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "evidence_legal_holds_source_store_source_row_id_key"
  ON "evidence_legal_holds" ("source_store", "source_row_id");

CREATE INDEX IF NOT EXISTS "evidence_legal_holds_case_id_status_idx"
  ON "evidence_legal_holds" ("case_id", "status");

CREATE INDEX IF NOT EXISTS "evidence_legal_holds_team_id_scope_status_idx"
  ON "evidence_legal_holds" ("team_id", "scope", "status");
