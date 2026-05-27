# Migration discipline (Phase 2.5C)

This document is the **authoritative operational runbook** for
Prisma migrations on PROOVRA. It is the result of the Phase 2.5C
hardening pass that followed the Phase 2.5B incident (a migration
command pointed at a Neon production-like database because the
active `DATABASE_URL` was inherited from `.env`).

If you are about to run any `prisma migrate` command, read this
document first.

---

## TL;DR — three rules

1. **Never invoke `prisma migrate` directly.** Always go through
   `pnpm prisma:migrate` (deploy), `pnpm prisma:migrate:dev` (dev
   add), or `pnpm prisma:migrate:status` (status). These route
   through `services/api/scripts/safe-migrate.mjs` which refuses
   non-local hosts by default.
2. **Look at the banner before pressing enter.** The wrapper
   prints `host`, `database`, and `classification: LOCAL | REMOTE |
   UNKNOWN` in a header box BEFORE any SQL runs. If you don't see
   that banner, you bypassed the wrapper.
3. **Remote migrations require BOTH the flag AND the env var.**
   `--allow-remote` alone is not enough; `MIGRATE_ALLOW_REMOTE=1`
   alone is not enough. Both are required. This is intentional.

---

## The Phase 2.5B incident — what we are guarding against

During Phase 2.5B we attempted to add two new tables
(`NotificationPreference` and `AccountLifecycleRequest`). The
migration command was:

```
pnpm exec prisma migrate deploy
```

Output:

```
Datasource "db": PostgreSQL database "neondb", schema "public"
  at "ep-long-hat-ag5kk101-pooler.c-2.eu-central-1.aws.neon.tech"
```

That is a Neon production-like host, not the local audit DB. The
migration FAILED before applying any SQL (a pre-existing migration
in a failed state on that DB blocked subsequent migrations), so no
data was modified — but the attempt itself was a clear Phase 0
violation.

The root cause: the repo-root `.env` carried the production-like
`DATABASE_URL`. `prisma.config.ts` loaded that .env. The CLI
proceeded without any host-level check.

The Phase 2.5C wrapper is the structural fix.

---

## The migration safety wrapper

**File:** `services/api/scripts/safe-migrate.mjs`

What it does:

1. Loads `services/api/.env` and the repo-root `.env` via the
   same loader the prisma config uses.
2. Parses `DATABASE_URL` to extract host, port, database.
3. Classifies the host:
   - **`local`** — `localhost`, `127.0.0.1`, `::1`,
     `host.docker.internal`, `postgres`, `proovra_postgres`.
   - **`remote`** — matches one of the explicit cloud-pattern
     regexes (`*.neon.tech`, `*.amazonaws.com`, `*.pooler.*`,
     etc.).
   - **`unknown`** — anything else.
4. Prints a banner showing the resolved target + classification
   + flag/env state.
5. If classification is **not local**, refuses unless BOTH:
   - the `--allow-remote` flag is passed
   - the env var `MIGRATE_ALLOW_REMOTE=1` is set
6. Delegates to `pnpm exec prisma migrate <subcommand> ...args`
   and forwards stdio + exit code.

Exit codes:

| code | meaning |
|---|---|
| 0 | success (prisma's own exit forwarded) |
| 1 | prisma itself reported a failure |
| 2 | DATABASE_URL is not set (fail-closed) |
| 3 | REFUSED — non-local host without dual override |

The wrapper is exercised on every CI run via the
`schema-reproducibility.yml` workflow, which deliberately invokes
it with a fake Neon URL and asserts exit code 3. If a future PR
removes or weakens the wrapper, that CI step fails.

---

## The drift detection script

**File:** `services/api/scripts/drift-check.mjs`

Wraps `prisma migrate status` with structured output and exit
codes that let CI branch on the failure mode:

| code | meaning |
|---|---|
| 0 | applied + healthy; no drift |
| 4 | one or more FAILED migrations present |
| 5 | one or more PENDING migrations not yet applied |
| 6 | DRIFT detected (schema vs DB out of sync) |
| 7 | prisma itself exited non-zero for an unrelated reason |

The CI workflow `schema-reproducibility.yml` runs this on the
freshly-migrated DB and fails if exit code is non-zero. This
catches:

- Forgotten migrations (developer added a schema change but didn't
  generate the SQL file).
- Hand-edited migrations that drifted from `schema.prisma`.
- Migrations that applied partially.

---

## The supported commands (use these; nothing else)

```
# Deploy already-authored migrations to the current DATABASE_URL.
# Refuses non-local hosts by default.
pnpm --filter proovra-api prisma:migrate

# Create a new migration in development.
pnpm --filter proovra-api prisma:migrate:dev --name describe_change

# Check migration status (read-only).
pnpm --filter proovra-api prisma:migrate:status
# or equivalently
pnpm --filter proovra-api db:drift-check

# Generate the prisma client (no DB access).
pnpm --filter proovra-api prisma:generate
```

Escape hatch (DOCUMENTED, DO NOT USE WITHOUT EXPLICIT REASON):

```
pnpm --filter proovra-api prisma:migrate:raw
```

This bypasses the safety wrapper entirely. It exists only because
some emergency-recovery scenarios may require it. Every invocation
of `prisma:migrate:raw` must be paired with a comment in the
incident log explaining why the wrapper was skipped.

---

## Running migrations remotely (the only safe path)

When you genuinely need to apply migrations to a non-local DB
(staging, sandbox, etc.):

1. Verify you have an authorised reason. Check the deploy ticket
   or change record.
2. Run `pnpm --filter proovra-api db:drift-check` against the
   target FIRST. If exit code is non-zero, STOP and resolve the
   existing drift before adding more migrations.
3. Take a backup of the target DB. (Snapshot, `pg_dump`, or your
   provider's point-in-time recovery feature — whichever is the
   organisation standard.) Record the backup id in the incident
   log.
4. Run the migration through the wrapper with both overrides:

   ```
   MIGRATE_ALLOW_REMOTE=1 pnpm --filter proovra-api prisma:migrate --allow-remote
   ```

   The wrapper will print a loud "EXPLICIT REMOTE MIGRATION
   OVERRIDE" banner. This text should appear in your terminal
   scrollback and any CI log.
5. Run `pnpm --filter proovra-api db:drift-check` again to confirm
   the apply was clean.
6. Verify the API boots against the new schema (`pnpm start` +
   `/health`).

---

## Rollback discipline

**Prisma does NOT auto-rollback migrations.** Do not pretend it
does. The rollback path depends on the failure mode:

### Migration failed mid-apply (rare)

Prisma marks the migration as failed in the `_prisma_migrations`
table. Subsequent `migrate deploy` calls refuse to proceed until
the failure is resolved.

Steps:

1. Run `pnpm --filter proovra-api db:drift-check` — it surfaces
   the failed migration's name.
2. Restore from the pre-migration backup.
3. Resolve the failed migration entry:

   ```
   pnpm exec prisma migrate resolve --rolled-back <migration_name>
   ```

   This tells prisma to forget the failed apply. Run it ONLY
   after the DB has been restored.
4. Fix the migration SQL.
5. Re-apply via the wrapper.

### Migration applied but the application can't boot against it

If the schema is structurally fine but the API rejects it
(SCHEMA_DRIFT_CRITICAL from the runtime validator):

1. The Phase 0 runtime validator catalog at
   `services/api/src/runtime/schema-validation.ts` is the source
   of truth for what the API expects.
2. The mismatch is either in `schema.prisma` (the migration
   created a different shape than the model expects) or in the
   catalog (a recent code change references a column/enum the
   migration didn't add).
3. Add a follow-up migration that closes the gap. Do NOT bypass
   the validator with `SCHEMA_VALIDATION_FAIL_FAST=false` —
   that's hiding the bug.

### Migration applied but business logic regressed

This is a code rollback, not a migration rollback. Deploy the
previous code revision; the migration can stay applied if it's
forward-compatible (additive). If the migration is destructive
(dropped a column or table the previous code depends on), you
need to restore from backup AND resolve the migration.

---

## Release checklist (before merging a PR with schema changes)

- [ ] The new migration SQL is in `services/api/prisma/migrations/`.
- [ ] `pnpm --filter proovra-api prisma:generate` succeeds.
- [ ] `pnpm --filter proovra-api typecheck` succeeds.
- [ ] `pnpm --filter proovra-api db:drift-check` on local DB exits 0.
- [ ] CI `schema-reproducibility` job is green on the PR (this
      proves clean-DB-from-scratch + safety-wrapper-still-refuses-Neon).
- [ ] If the migration touches existing tables / columns: review
      whether the change is forward-compatible. If destructive,
      coordinate with deploy ordering.
- [ ] If the migration adds critical objects: update the runtime
      validator catalog at
      `services/api/src/runtime/schema-validation.ts`.

---

## Don't (anti-patterns)

- ❌ Run `prisma migrate` directly. Always use `pnpm prisma:migrate`.
- ❌ Set `MIGRATE_ALLOW_REMOTE=1` in `.env` "to avoid the prompt".
  The wrapper requires BOTH the flag and the env var precisely so
  this shortcut doesn't work.
- ❌ Use `prisma db push` against any non-local DB. `db push` is
  a schema-syncing tool that bypasses migration history; it's
  fine for local prototyping but DESTROYS migration discipline.
  No script in `package.json` invokes `db push`; do not add one.
- ❌ Hand-edit `_prisma_migrations` rows. If you need to mark a
  migration as rolled-back, use `prisma migrate resolve`.
- ❌ Disable the runtime validator
  (`SCHEMA_VALIDATION_FAIL_FAST=false`). It exists to catch the
  exact class of bug that lets bad migrations into production.
- ❌ Merge a PR with a migration without the
  `schema-reproducibility` job green.

---

## Open questions / future hardening

- **Pre-flight check baked into prisma.config.ts.** The wrapper
  lives outside Prisma; a misconfigured shell shortcut could
  still invoke `prisma migrate` directly. Investigate adding an
  `onMigrate` or `beforeQuery` hook in the prisma config so the
  same host check fires even on direct invocation.
- **Backup automation.** This document refers to backups as an
  operator responsibility. A future phase should add a small
  pg_dump-based wrapper that the safety script invokes
  automatically before remote migrations.
- **Validator catalog extension for new tables.** The Phase 0
  catalog currently only knows about objects that existed at
  Phase 0. New tables added in later phases (e.g. Phase 2.5B's
  bulk audit metadata) are NOT in the catalog. They're silently
  ignored — which is safer than wrongly-asserting, but means we
  rely on integration tests for new-table guarantees.
- **CI gate for breaking migrations.** The `schema-reproducibility`
  job verifies clean-from-scratch works. It does NOT verify that
  an existing DB can be safely upgraded. A future job should
  apply migrations to a snapshot of a known-good prior state and
  verify the upgrade path works.

---

## Files referenced

- `services/api/scripts/safe-migrate.mjs` — the wrapper.
- `services/api/scripts/drift-check.mjs` — the drift detector.
- `services/api/package.json` — `prisma:migrate*` script
  routing.
- `.github/workflows/schema-reproducibility.yml` — CI gates.
- `services/api/prisma.config.ts` — env loader.
- `services/api/src/runtime/schema-validation.ts` — runtime
  validator catalog.
- `docs/product/PHASE_2_5B_LIFECYCLE_AND_BULK.md` — the Phase
  2.5B incident this discipline was built in response to.
