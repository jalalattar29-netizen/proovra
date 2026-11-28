# PR #13 — release sequence (merge · migration · deployment · optional reconciliation)

Status: merge authorized by the owner on 2026-11-28; **the production migration, the
deployment dispatch after it and the reconciliation are NOT authorized here** and are
run by the owner. Every command below was checked against the scripts in this commit,
not their older comments:

| Script (in the API image at `/app/services/api`) | Reads | Exit codes |
|---|---|---|
| `scripts/drift-check.mjs` — `prisma migrate status`, read-only | `DATABASE_URL` | 0 in sync · 4 FAILED migration · 5 PENDING migrations · 6 drift · 7 prisma failed otherwise (e.g. unreachable) · **8 a non-local host without BOTH `MIGRATE_ALLOW_REMOTE=1` and `--allow-remote` (nothing read)** · 2 no target · 3 explicit `--database-url` on a non-local host · 12 no Prisma CLI |
| `scripts/safe-migrate.mjs deploy` — `prisma migrate deploy` | `DATABASE_URL` | 0 applied · 3 non-local host without both acknowledgements · 11 no `MIGRATE_BACKUP_ID` (≥ 4 chars) · 2 no `DATABASE_URL` · 12 no Prisma CLI · otherwise prisma's own exit |
| `scripts/runtime-schema-gate.mjs` — catalog check inside `BEGIN READ ONLY` | `DATABASE_URL` (environment only) | 0 every object this image needs is present · 12 missing / unreadable |

Verified locally on 2026-11-28 against an unreachable non-local placeholder host:
drift-check without acknowledgements → 8; with both → it reached Prisma (7, unreachable);
safe-migrate without acknowledgements → 3; with them but no backup id → 11.

## Facts the sequence rests on

- **Images exist only after the merge.** `deploy-images` runs on `main` and pushes
  `ghcr.io/<owner>/proovra-{api,worker}:sha-<first 7>` with the label
  `org.opencontainers.image.revision=<full SHA>`. There is no supported image of the PR
  head, so the migration cannot run before the merge.
- **The automatic release can start before the migration.** `backend-release` runs on
  `workflow_run` of `deploy-images` (success, `main`) and proceeds once the required CI
  is green on that SHA (schema-reproducibility takes about 90 minutes). It does **not**
  wait for migrations: nothing in the workflow checks for them.
- **What it does when the column is missing** (`scripts/release/host-release.sh` →
  `scripts/deploy-prod-pull.sh`): disk headroom → rollback point → **database backup
  (proven)** → `deploy-prod-pull.sh --plan` → `git checkout --detach <SHA>` on the host →
  pull both images and prove their revision label → **runtime schema gate from the new
  image** → only then worker, API. With the migration unapplied the gate exits 12, the
  deploy stops ("apply the migrations first. Nothing was restarted"), the host result is
  `REFUSED_BEFORE_CHANGE` (exit 10) and the commit status `release/backend` is
  `failure "deploy failed before any service changed: …; still <previous>"`. The running
  API and worker are untouched.
- **No automatic retry.** A later automatic event for the same SHA is
  `HELD_AFTER_FAILURE`. The supported continuation is a `backend-release` dispatch with
  `mode=release`, `sha=<the merge SHA>` (it must still be `main` HEAD).
- **Which database Prisma uses.** The compose service `proovra-api` gets
  `DATABASE_URL: ${DATABASE_URL}` interpolated from the host's
  `/opt/proovra/app/.env`; the image carries no `.env`. `prisma.config.ts` uses
  `DATABASE_URL` (not `DIRECT_URL`), and so do all three scripts. The banners print the
  host and database name (never the password): check them before going on.
- **Which migrations are pending.** `prisma migrate deploy` applies every folder in the
  image's `prisma/migrations/` missing from production's `_prisma_migrations`, in name
  order. This PR adds exactly one, `20281127120000_review_remediation_policy` (additive:
  two nullable `review_escalations` columns, four `workspace_governance_policies`
  columns, three `NOT NULL DEFAULT false` and one nullable; no backfill, no rewrite on
  PostgreSQL 11+). The release records say production last applied
  `20281124010000_review_first_decided_at`, the newest migration on `main` before this
  PR. That is a record, not a query: **step B2 lists what is actually pending**, and any
  name other than `20281127120000_review_remediation_policy` stops the procedure.

## A. Merge (done by Claude under the owner's authorization)
1. All six PR workflows green on the final head; `main` fast-forwarded to it (the tested
   SHA is the released SHA).
2. `main` CI → `deploy-images`: confirm `build-and-push` ran (not skipped) and that both
   GHCR tags carry the merge SHA as their revision label.
3. `backend-release` starts by itself once the required checks are green. **Expected
   outcome: refused before any change by the schema gate**, unless B is already done.
   Its log prints `PROOVRA_RELEASE backup=<dump file>`; the proof is
   `/opt/proovra/app/.deploy-state/backup-proof-<first 12 of SHA>.txt`.

## B. Production migration (owner, on the host, from the NEW image)

```bash
cd /opt/proovra/app
```
```bash
export GHCR_OWNER=<repository owner, lowercase> RELEASE_SHA=<40-hex merge SHA> IMAGE_TAG=sha-<first 7 of it>
```
The compose file does not parse without `GHCR_OWNER` and `IMAGE_TAG`. After a refused
release the host checkout is already at `RELEASE_SHA` and both images are pulled; if B
runs first, do `git fetch --quiet origin && git checkout --quiet --detach "$RELEASE_SHA"`
and `docker compose --env-file .env -f infra/docker/docker-compose.prod.yml pull proovra-api`.

B1. **The image is the release** (prints the full SHA):
```bash
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "ghcr.io/$GHCR_OWNER/proovra-api:$IMAGE_TAG"
```

B2. **Read-only: what is pending** (expected exit 5, pending = `20281127120000_review_remediation_policy` only; 0 means already applied; 4, 6, 7 or 8 → stop):
```bash
docker compose --env-file .env -f infra/docker/docker-compose.prod.yml run --rm --no-deps -T -e MIGRATE_ALLOW_REMOTE=1 --entrypoint node proovra-api scripts/drift-check.mjs --allow-remote </dev/null; echo "exit=$?"
```
Then the gate the release runs (expected now: exit 12, naming the missing columns):
```bash
docker compose --env-file .env -f infra/docker/docker-compose.prod.yml run --rm --no-deps -T --entrypoint node proovra-api scripts/runtime-schema-gate.mjs </dev/null; echo "exit=$?"
```

B3. **Backup acknowledgement.** `MIGRATE_BACKUP_ID` = the dump file the refused release
printed in A3 (taken minutes before, proven). If B runs first, or much later, take and
prove a fresh backup with the established backup procedure and use its file name.

B4. **Apply** (expected: banner with the production host and database, `EXPLICIT REMOTE
MIGRATION OVERRIDE`, `Applying migration 20281127120000_review_remediation_policy`,
`All migrations have been successfully applied.`, exit 0):
```bash
docker compose --env-file .env -f infra/docker/docker-compose.prod.yml run --rm --no-deps -T -e MIGRATE_ALLOW_REMOTE=1 -e MIGRATE_BACKUP_ID=<dump file from B3> --entrypoint node proovra-api scripts/safe-migrate.mjs deploy --allow-remote </dev/null; echo "exit=$?"
```
No pnpm or Corepack is involved: `node` runs the canonical wrapper, which runs the
lockfile-pinned Prisma CLI with the same node binary. If the banner reports
`classification: LOCAL`, the acknowledgements are not required and the backup check is
skipped; still record the backup id.

B5. **Read-only after:** repeat B2's drift-check (expected exit 0, "Database schema is up
to date") and the schema gate (expected exit 0, `runtime-schema-gate: PASS`).

## C. Deployment (owner dispatch, after B5)
GitHub → Actions → `backend-release` → Run workflow: `mode=release`,
`sha=<merge SHA>` (still `main` HEAD). It takes a new backup, passes the schema gate,
replaces worker then API (`sha-<7>`), verifies health, readiness, revision and route
epoch, records `release/backend` success and dispatches the web continuation.
Rollback is code-first (`.deploy-state/previous-release`); the added columns are inert
to the previous code.

## D. Reconciliation (optional, separate, never automatic)
Not a prerequisite for the new behaviour; run only when the owner wants it, after C.
The plan file stays on the host (`.deploy-state/` is mounted at `/out`):
```bash
docker compose --env-file .env -f infra/docker/docker-compose.prod.yml run --rm --no-deps -T -v "$PWD/.deploy-state:/out" --entrypoint node proovra-api --experimental-specifier-resolution=node dist/scripts/review-remediation-reconcile.js plan --out /out/review-remediation-plan.json </dev/null
```
It is read-only and prints the plan hash and counts. Review every item, its effect and
its precondition (`RECONCILIATION.md`); then, only for the categories the owner
approves, the same command with
`apply --plan /out/review-remediation-plan.json --plan-hash <sha256> --categories <list> --operator "<name>"`.
Items whose reviewed context changed are refused (`changed_since_plan`); `compensate`
with the same plan and hash restores exactly what it applied.
