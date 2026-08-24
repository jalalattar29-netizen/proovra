-- EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — part 2 of 2: the backfill.
--
-- Converges `evidence.lifecycle_state` with the timestamps that were, until
-- now, the de-facto product-state authority. Deterministic, idempotent, and
-- ordered from the most terminal signal to the least so no row can be claimed
-- twice.
--
-- PRECEDENCE
-- ---------------------------------------------------------------------------
--   1. already DESTROYED                       -> DESTROYED   (left alone)
--   2. deleted_at IS NOT NULL                  -> TRASHED
--   3. archived_at IS NOT NULL                 -> ARCHIVED
--   4. everything else                         -> LEFT ALONE
--
-- DESTRUCTION IS NEVER INFERRED
-- ---------------------------------------------------------------------------
-- `deleted_at` maps to TRASHED and to nothing else. It has never been proof
-- that bytes were removed: the purge worker set it 90 days BEFORE it deleted
-- anything, and the two paths that did emit destruction certificates deleted
-- no bytes at all. Reading it as destruction would manufacture a tombstone for
-- every recoverable record in every workspace's trash — the exact false record
-- this convergence exists to remove. Only an existing DESTROYED state counts,
-- and it counts because some path already asserted it; part 3 of the program
-- makes sure no future path can assert it without verified deletion.
--
-- WHY STEP 4 IS "LEFT ALONE" AND NOT "-> ACTIVE"
-- ---------------------------------------------------------------------------
-- The convergence plan says "else -> ACTIVE". Applied literally that would
-- overwrite UNDER_REVIEW, ON_HOLD, RETENTION_LOCKED and PENDING_DESTRUCTION —
-- governance-internal postures that NO other column records, so the write
-- would not be a convergence but a silent loss of governance state, and an
-- ON_HOLD record would come back as an ordinary active one.
--
-- Those postures are not product states and never were: the canonical
-- authority resolves a record carrying one of them to the ACTIVE product state
-- via its timestamps, which is precisely the answer "-> ACTIVE" was reaching
-- for. Leaving the column alone reaches it without destroying the governance
-- reading. Rows that are genuinely ACTIVE are already ACTIVE (the column
-- defaults to it), so step 4 has nothing to write in the ordinary case.
--
-- IDEMPOTENCE
-- ---------------------------------------------------------------------------
-- Every statement is a no-op on a second run: step 2 excludes rows already
-- TRASHED, step 3 excludes rows already ARCHIVED, and both exclude DESTROYED.

-- 2. Trashed: a trash event happened and the record was not already destroyed.
UPDATE "evidence"
   SET "lifecycle_state" = 'TRASHED'
 WHERE "deleted_at" IS NOT NULL
   AND "lifecycle_state" NOT IN ('DESTROYED', 'TRASHED');

-- 3. Archived: no trash event, an archive event, not already destroyed.
UPDATE "evidence"
   SET "lifecycle_state" = 'ARCHIVED'
 WHERE "deleted_at" IS NULL
   AND "archived_at" IS NOT NULL
   AND "lifecycle_state" NOT IN ('DESTROYED', 'ARCHIVED');

-- 4. Nothing. See the header.
