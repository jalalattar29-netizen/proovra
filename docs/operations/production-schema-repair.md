# Production Schema Repair — Phase O-Final

**Symptom (production runtime log):**

```
column discussion_mentions.team_id does not exist
```

**`prisma migrate status` reports OK.** The drift check sees no
pending migrations. The runtime still fails because the column the
Prisma client expects is genuinely absent from the production table.

## Root cause

The original Phase 16 migration
(`services/api/prisma/migrations/20260525100000_add_collaboration_phase16/migration.sql`,
line 142) creates the table with **`CREATE TABLE IF NOT EXISTS "discussion_mentions" (...)`**.

If production already had a `discussion_mentions` table prior to this
migration applying (left over from an earlier deploy, a hand-rolled
bootstrap, or a partially-completed previous attempt), the
`IF NOT EXISTS` clause causes Postgres to **skip the entire CREATE
TABLE block silently**. The `_prisma_migrations` row gets written
because the SQL "succeeded" from a Postgres perspective, so
`prisma migrate status` reports OK.

But the `team_id` column the Prisma schema declares
(`schema.prisma` line 4003, `teamId String? @map("team_id") @db.Uuid`)
was never actually added.

This failure mode is invisible to drift-check because drift-check
compares the migrations folder to the `_prisma_migrations` table, not
to the live table definitions.

## Same-pattern risk on adjacent tables

Every table created with `CREATE TABLE IF NOT EXISTS` in its original
migration has the same risk if production had a pre-existing table of
that name. The Phase O-Final audit script + repair migration cover the
five tables flagged by the operator brief:

| Table | At-risk column(s) | Phase that introduced |
| --- | --- | --- |
| `discussion_mentions` | `team_id` (root cause) | Phase 16 |
| `discussion_participants` | `team_id`, `user_id`, `intake_session_id`, `added_by_user_id`, `revoked_at_utc`, `revoked_by_user_id` | Phase 16 |
| `evidence_workflow_instances` | `external_contact_hash`, `created_by_user_id`, `assigned_reviewer_user_id`, `intake_session_id`, `evidence_request_id` | Phase 13 / B2 |
| `upload_sessions` | `team_id`, `is_multipart`, `expected_part_count`, `completed_part_count`, `multipart_upload_id`, `retry_count`, `failure_reason`, `stalled_at_utc`, `abandoned_at_utc`, `completed_at_utc` | Phase 30 |
| `evidence_saved_views` | `team_id`, `description`, `sort_key`, `is_default` | Phase G2 |

## Diagnostic — run BEFORE the repair migration

```bash
DATABASE_URL='postgres://...prod...' \
  node services/api/scripts/production-column-audit.mjs
```

**This script is read-only.** It uses `pg.Pool` directly (NOT
`new PrismaClient()` — Prisma 7 in this project requires the
`@prisma/adapter-pg` factory and that itself would fail against a
drifted schema). It inspects `information_schema.columns` +
`_prisma_migrations` and prints a bounded summary.

Exit codes:

- `0` — no missing columns; production matches expected.
- `2` — missing columns detected (run the repair migration).
- `3` — connection / query failure; check `DATABASE_URL`.

## Repair — additive-only migration

Migration path:

```
services/api/prisma/migrations/20261006000000_phase_o_final_production_column_repair/migration.sql
```

**Hard rules followed:**

- Every statement is `ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`.
- **No `DROP`**, **no `RENAME`**, **no `SET NOT NULL`** — purely
  additive.
- Re-running is a no-op (every statement is idempotent under repeat).
- The contract test `services/api/test/phase-o-final-schema-repair.test.ts`
  enforces this — the test fails if any destructive keyword appears.

## Running the repair

**Prerequisite: take a Neon snapshot first.** If no real snapshot
exists, STOP — do not run the migration. The `MIGRATE_BACKUP_ID` env
var is the explicit acknowledgement that a snapshot is in hand.

Required command:

```bash
MIGRATE_ALLOW_REMOTE=1 \
  MIGRATE_BACKUP_ID=<real-neon-snapshot-id> \
  node services/api/scripts/safe-migrate.mjs deploy --allow-remote
```

The double-flag (`--allow-remote` AND `MIGRATE_ALLOW_REMOTE=1`) is the
project's intentional friction against accidental remote migrations
(see `safe-migrate.mjs` line 26).

## Validation after repair

1. Re-run the audit script — must report `[result] no missing columns detected.`
2. `pnpm --filter proovra-api db:drift:check` must still exit 0.
3. Production runtime: the previously failing endpoints (anything that
   queries `discussion_mentions`, `discussion_participants`,
   `evidence_workflow_instances`, `upload_sessions`,
   `evidence_saved_views`) must serve 200 OK, not the P2022 error.
4. Confirm no new errors in `docker logs docker-proovra-api-1 --tail 200`.

## Rollback plan

Because the migration is purely additive (ADD COLUMN with default
nullable / safe default), it is safe to leave in place even if the
operator decides to revert the application code. Adding a nullable
column has no read-side cost on a Postgres table.

If a roll-back is required for some other reason:

```sql
-- ONLY if necessary, ONLY with operator approval. Adding a nullable
-- column has no real overhead so this should not be needed.
ALTER TABLE "discussion_mentions" DROP COLUMN IF EXISTS "team_id";
-- ... etc per repaired table.
```

## Why this is honest

- The repair adds the *missing* columns Prisma was already expecting.
  It does not introduce new schema concepts.
- The Prisma schema is unchanged. The migration brings production back
  into line with what the schema has always declared.
- No data is touched. No row is rewritten.
- The audit script is provably read-only (contract-test asserts no
  ALTER/INSERT/UPDATE/DELETE in real code).
