-- EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — part 1 of 2: the vocabulary.
--
-- ADDITIVE ONLY. One new enum member, one new nullable column, one new index.
-- No existing column changes type or nullability; no existing row is read or
-- rewritten here. The backfill is a SEPARATE migration, and that separation is
-- required, not stylistic: PostgreSQL refuses to USE an enum value that was
-- added by the same transaction, and Prisma wraps each migration in one. An
-- ALTER TYPE ... ADD VALUE followed by an UPDATE naming that value in the same
-- file fails with "unsafe use of new value of enum type".
--
-- WHY `TRASHED` EXISTS
-- ---------------------------------------------------------------------------
-- The product had four user-visible lifecycle states and a schema that could
-- name three. "In the trash" was therefore represented by a TIMESTAMP
-- (`deleted_at`), and every reader — the library scope filter, the details
-- tab, the bulk toolbar, the purge worker, three destruction paths — derived
-- the state from that timestamp independently. They did not agree:
--
--   * the purge worker read `deleted_at IS NOT NULL` as "queued for physical
--     deletion" and hard-deleted the row;
--   * the governance orchestrator read the same record as destructible and
--     emitted a destruction certificate for it WITHOUT deleting any bytes;
--   * the frontend read the retention columns and refused to trash a retained
--     record at all — conflating a recoverable soft-trash with an irreversible
--     physical destruction.
--
-- A timestamp cannot arbitrate between those readings, because a timestamp is
-- an EVENT, not a state. `lifecycle_state` is the state. After the backfill
-- every runtime reader resolves the product state from it, and `deleted_at`
-- keeps only the meaning it can actually carry: WHEN the record was trashed.
--
-- WHY `destroyed_at_utc` EXISTS
-- ---------------------------------------------------------------------------
-- There was no column that recorded WHEN physical destruction happened, so
-- "destroyed" and "scheduled for destruction" were indistinguishable after the
-- fact. The canonical executor writes this column only AFTER it has deleted
-- the objects and re-read the store to confirm they are gone, so a non-null
-- value is a positive record that the bytes no longer exist. Nothing else may
-- write it — a source-contract gate enforces that.
--
-- INDEX
-- ---------------------------------------------------------------------------
-- The trash-grace reconciler scans "TRASHED rows whose grace deadline has
-- passed" on a schedule. The two existing single-column indexes force a bitmap
-- AND over a table where the overwhelming majority of rows are ACTIVE; the
-- composite serves the scan directly. Declared in the Prisma datamodel, so it
-- is datamodel-owned and needs no raw-schema-ownership registration.

ALTER TYPE "EvidenceLifecycleState" ADD VALUE IF NOT EXISTS 'TRASHED';

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "destroyed_at_utc" TIMESTAMPTZ(6);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "destruction_claimed_at_utc" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "evidence_lifecycle_state_delete_scheduled_for_utc_idx"
  ON "evidence" ("lifecycle_state", "delete_scheduled_for_utc");
