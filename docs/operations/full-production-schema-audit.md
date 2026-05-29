# Full Production Schema Audit — Phase O-Final+

A read-only diagnostic that compares the **live PROOVRA database**
against the **Prisma client's expectations** parsed from
`services/api/prisma/schema.prisma`. Detects every mismatch that can
cause runtime P2022 / P2021 errors and broken pages.

This is an **audit-first** procedure. Operators run it, read the
findings, decide on next steps — the script **never mutates the
database**.

## What the audit detects

- **Missing tables** (model exists in Prisma but no table in Postgres).
- **Missing columns** (field exists in Prisma model but no column in Postgres).
- **Naming drift** (Prisma expects `team_id`; DB has `teamId`, or vice versa).
- **Type mismatches** (column exists but the Postgres type does not match Prisma's expectation).
- **Nullability mismatches** (Prisma field is required but DB column is nullable, or vice versa).
- **Missing enum values** (Postgres enum is missing a value declared by the Prisma enum).
- **Migration history risk patterns** — every migration using
  `CREATE TABLE IF NOT EXISTS` is flagged (this is the silent-skip
  trap that produced the original `discussion_mentions.team_id`
  failure: if the table existed before the migration, the entire
  `CREATE TABLE` block is skipped — including all the columns).

Every finding is classified as:

| Risk | Meaning |
| --- | --- |
| **CRITICAL** | Prisma queries against the affected model will fail with P2022 / P2021. Examples: missing table; missing column (Prisma `findUnique`/`findMany` SELECTs *every* model field, so even an "optional" missing column breaks every query); naming drift where Prisma can't find its expected name. |
| **HIGH** | Type mismatch (reads return wrong-shape values; writes may be rejected); Prisma field required but DB nullable (reads of NULL fail); missing enum value (writes with that value fail). |
| **MEDIUM** | Default-value mismatch on a column the application depends on. |
| **LOW** | Performance-only: missing index. Or "DB is over-strict" (Prisma optional but DB NOT NULL). Or extra-on-DB columns Prisma doesn't know about. |

## Hard rules followed

- **READ-ONLY.** Every SQL query is `SELECT` only. The script's
  `safeQuery` helper refuses non-SELECT statements by construction —
  enforced by the contract test
  `services/api/test/phase-o-final-plus-full-schema-audit.test.ts`.
- **No `new PrismaClient()`.** Prisma 7 in this project requires the
  `@prisma/adapter-pg` factory. The audit must work even when the
  schema is drifted (the whole point), so it bypasses the ORM and
  uses `pg.Pool` directly — the same client family that `db.ts`
  uses.
- **No secrets in output.** The `DATABASE_URL` is redacted to
  `<host>:<port>/<db>` before any print. No password, no query
  string.
- **No row contents printed.** Only schema metadata
  (`information_schema.tables` / `information_schema.columns` /
  `pg_indexes` / `pg_enum` / `_prisma_migrations`).
- **Never auto-fixes.** Every repair statement is *proposed*, not
  applied. The operator reviews, takes a Neon snapshot, then applies
  via `safe-migrate.mjs`.

## How to run

### Locally against production (recommended for first-time triage)

```bash
cd services/api
DATABASE_URL="postgres://...prod..." node scripts/full-production-schema-audit.mjs
```

### Inside the production api container

```bash
docker exec -it docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node scripts/full-production-schema-audit.mjs
'
```

The container's `DATABASE_URL` env is used automatically — operators
do NOT need to re-pass it.

### JSON output (for machine processing or paste into incident notes)

```bash
DATABASE_URL="postgres://..." node services/api/scripts/full-production-schema-audit.mjs --json
```

### Parse-only mode (no DB connection — CI / sandbox)

```bash
node services/api/scripts/full-production-schema-audit.mjs --parse-only
```

This verifies the schema parser works without requiring a database.
Output: `{ "mode": "parse-only", "models": N, "enums": M }`.

## Exit codes

- `0` — no CRITICAL findings; production schema matches expected.
- `2` — at least one CRITICAL finding; review the proposal before
  applying.
- `3` — connection / query failure (transient — check
  `DATABASE_URL`).

## How to interpret findings

### CRITICAL — MISSING_COLUMN (the documented exemplar)

Example output:

```
  [CRITICAL] MISSING_COLUMN  discussion_mentions.team_id
    model      : DiscussionMention.teamId
    expected   : uuid (nullable)
    code usage (best-effort):
      services/api/src/routes/me-inbox.routes.ts
      services/api/src/services/collaboration/...
```

Action: the column **must** be added before Prisma can query the
model. Use the proposed `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT
EXISTS` statement.

### CRITICAL — NAMING_DRIFT (manual decision)

Example output:

```
  [CRITICAL] NAMING_DRIFT  widgets.team_id
    model      : Widget.teamId
    drift      : DB has "teamId" (snake_to_camel)
```

The script **deliberately does not auto-fix** this. Either:

1. **Fix the Prisma `@map`** in `schema.prisma` to point at the
   DB's actual column name (`@map("teamId")`), regenerate the
   client. No DB change.
2. **Rewrite the DB column** to match Prisma (add the new column,
   backfill, drop the old). Multi-step migration; risky against
   production.

Operator decision; the script flags both options in the proposal.

### HIGH — TYPE_MISMATCH

Example output:

```
  [HIGH] TYPE_MISMATCH widgets.created_at
    expected: timestamp with time zone
    actual: timestamp without time zone
```

Action: a type change is a multi-step migration (ADD new column with
correct type, backfill, swap, drop old). Operator decision; **the
script does not propose a destructive type change**.

### HIGH — NULLABLE_DB_NULLABLE_PRISMA_REQUIRED

Action: confirm the application code paths can survive NULL reads
during a backfill window. If yes, add a temporary default OR backfill
the column then `SET NOT NULL`. Multi-step; operator scope.

### LOW — NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL

The DB is over-strict but reads work fine. Usually no action needed.

### LOW — MISSING_INDEX

Operator-tunable. Not runtime-required.

## Migration history risk patterns

The audit also scans **every migration** in
`services/api/prisma/migrations` for the
`CREATE TABLE IF NOT EXISTS` pattern. This is the failure mode that
produced the original `discussion_mentions.team_id` drift: when a
production database had a pre-existing table of the same name, the
`IF NOT EXISTS` caused the entire `CREATE TABLE` block to be silently
skipped, leaving the table without any of the migration's columns.

The audit lists every such migration + table so operators can
correlate. Tables flagged here are at **elevated risk** of column
drift even when the per-column audit doesn't currently flag anything.

## Safe repair workflow

1. **Run the audit locally.**

   ```bash
   DATABASE_URL="postgres://...prod..." node services/api/scripts/full-production-schema-audit.mjs
   ```

2. **Review every CRITICAL finding.** Decide which are auto-repairable
   (MISSING_COLUMN with a clear expected type) vs. manual-decision
   (NAMING_DRIFT, TYPE_MISMATCH).

3. **Take a Neon snapshot.** In the Neon console: project →
   Branches → Take snapshot. Capture the snapshot ID.

   **If you cannot take a snapshot, STOP.** Do not run the repair
   migration.

4. **Author an additive-only repair migration.** Use the proposal as
   a starting point. Hard rules:
   - Every statement must be `ADD COLUMN IF NOT EXISTS` or
     `CREATE INDEX IF NOT EXISTS`.
   - No `DROP`, no `RENAME`, no `SET NOT NULL`, no `TRUNCATE`, no
     `DELETE`.
   - Idempotent on re-run.
   - Every statement includes a comment explaining why.

5. **Apply via safe-migrate.**

   ```bash
   MIGRATE_ALLOW_REMOTE=1 \
     MIGRATE_BACKUP_ID=<real-neon-snapshot-id> \
     node services/api/scripts/safe-migrate.mjs deploy --allow-remote
   ```

6. **Re-run the audit.** It must report `[result] no CRITICAL
   findings detected.`

7. **Verify the runtime.** Tail the api container; the
   previously-failing requests must serve 2xx, not P2022.

## Rollback notes

- Additive migrations (ADD COLUMN with nullable default) are
  generally safe to leave in place even if the application is
  rolled back. Adding a nullable column has no read-side cost.
- If a rollback is truly required, drop the added columns
  individually:

  ```sql
  -- ONLY with operator approval, AFTER confirming the application
  -- is rolled back to a code version that does not query the column.
  ALTER TABLE "discussion_mentions" DROP COLUMN IF EXISTS "team_id";
  ```

  This is destructive and should be reviewed against the snapshot
  ID captured before the original repair.

## Examples of naming drift (real-world)

These are the patterns the audit flags as `NAMING_DRIFT`:

| Prisma expects | DB has | Cause |
| --- | --- | --- |
| `team_id` | `teamId` | Migration authored before `@map` was added to the model. |
| `created_at_utc` | `createdAtUtc` | Inconsistent timestamp suffix convention across phases. |
| `user_id` | `userId` | Legacy bootstrap script used camelCase. |
| `metadata_json` | `metadataJson` | JSON column named with TypeScript convention. |

In every case the audit **lists the alternative** and **lets the
operator choose** — fix Prisma's `@map`, or rewrite the DB. The
script never silently picks one.

## What the audit does NOT do

- ❌ Does NOT mutate the database. Read-only.
- ❌ Does NOT silently auto-fix anything.
- ❌ Does NOT add `team_id` to every table just because one table
  needed it.
- ❌ Does NOT trust `prisma migrate status` alone. The whole point is
  to verify against live `information_schema` columns.
- ❌ Does NOT trust `_prisma_migrations` alone. The audit reads both
  but compares against the live schema.
- ❌ Does NOT log `DATABASE_URL`. Only the redacted
  `<host>:<port>/<db>` triple is printed.
