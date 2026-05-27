# Post-deploy migration verification — production runbook

This is the canonical post-deploy checklist after `pnpm deploy:safe`
(or any prisma migration apply) has run against a production-like
database. It proves the rolled image is healthy AND that every
migration the codebase declares is present, finished, and
non-rolled-back on the target.

The runbook assumes Phase 2.7Z+ Dockerfile packaging — the runtime
image now includes `services/api/scripts/` (previously this had to
be hand-patched via `docker cp` after every deploy, which was a
silent footgun whenever an operator forgot).

---

## 0. Image-contents sanity check (one-time per image build)

Before running anything else, prove the rolled image actually
contains the migration tooling. If this step fails, **stop** — the
fix is rebuilding the image, NOT `docker cp`.

```bash
docker exec docker-proovra-api-1 sh -lc '
  ls -1 /app/services/api/scripts/ | sort
'
```

**Expected output (must include all of these):**
```
backfill-organizations.mjs
check-org-consistency.mjs
db-diff-guard.mjs
db-host-policy.mjs
db-preflight.mjs
deploy-safe.mjs
drift-check.mjs
migration-risk-scan.mjs
not-null-readiness.mjs
protected-runtime-tables.mjs
safe-migrate.mjs
```

If ANY of those are missing → the image was built from a Dockerfile
that predates the Phase 2.7Z+ packaging fix. Rebuild from current
HEAD and redeploy. **Do not patch via `docker cp` as the final
solution.**

---

## 1. Safe-migrate exits 0 (or 14 for dry-run)

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  export MIGRATE_ALLOW_REMOTE=1
  export MIGRATE_BACKUP_ID="${MIGRATE_BACKUP_ID:?MIGRATE_BACKUP_ID must be set (snapshot id from pre-deploy backup)}"
  pnpm prisma:migrate -- --allow-remote
'
```

**Expected:**
- Exit code `0`
- Banner shows `classification: REMOTE` and the `EXPLICIT REMOTE MIGRATION OVERRIDE` block printed by `safe-migrate.mjs`
- Final line: `All migrations have been successfully applied.`
- If there are no pending migrations: `No pending migrations to apply.`

If exit code is `3` → wrapper REFUSED because `--allow-remote` /
`MIGRATE_ALLOW_REMOTE=1` weren't both supplied. Set both.

If exit code is `11` → wrapper REFUSED because `MIGRATE_BACKUP_ID` is
unset or too short. Capture a snapshot, record its id, export it,
re-run.

---

## 2. `prisma migrate status` reports schema up-to-date

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate status
'
```

**Expected:**
```
… migrations found in prisma/migrations
Database schema is up to date!
```

If output says `N migrations have not yet been applied` → step 1
was skipped or failed. Repeat step 1 with the override env set.

If output says `Following migrations have failed` → see §8.

---

## 3. `_prisma_migrations` has no failed / pending rows

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node -e "
    const { PrismaClient } = require(\"@prisma/client\");
    const { PrismaPg } = require(\"@prisma/adapter-pg\");
    const pg = require(\"pg\");
    (async () => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const adapter = new PrismaPg(pool);
      const prisma = new PrismaClient({ adapter });
      const rows = await prisma.\$queryRawUnsafe(
        \`SELECT migration_name, finished_at, rolled_back_at, logs
         FROM _prisma_migrations
         WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
         ORDER BY started_at DESC\`
      );
      console.log(JSON.stringify(rows, null, 2));
      await prisma.\$disconnect();
    })();
  "
'
```

**Expected:** `[]` (empty array).

If non-empty → see §8. Each row shows `migration_name`,
`rolled_back_at` (timestamp = the migration was marked
rolled-back), and `logs` (the captured stderr from the apply
attempt).

---

## 4. Latest required migrations exist AND are finished

The four migrations the Phase 2.7 rollout depends on:

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node -e "
    const { PrismaClient } = require(\"@prisma/client\");
    const { PrismaPg } = require(\"@prisma/adapter-pg\");
    const pg = require(\"pg\");
    (async () => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const adapter = new PrismaPg(pool);
      const prisma = new PrismaClient({ adapter });
      const expected = [
        \"20260925000000_phase0_schema_catchup\",
        \"20260926000000_p2_7x_stage1_org_model_additive\",
        \"20260927000000_p2_7x_stage6_invite_token_hash\",
        \"20260928000000_p2_7x_stage6_teams_org_not_null\",
      ];
      const rows = await prisma.\$queryRawUnsafe(
        \`SELECT migration_name, finished_at, rolled_back_at
         FROM _prisma_migrations
         WHERE migration_name = ANY(\$1::text[])
         ORDER BY started_at\`,
        expected
      );
      console.log(JSON.stringify(rows, null, 2));
      const found = new Set(rows.map(r => r.migration_name));
      const missing = expected.filter(n => !found.has(n));
      const unfinished = rows.filter(r => !r.finished_at || r.rolled_back_at);
      if (missing.length || unfinished.length) {
        console.error(\"MISSING:\", missing);
        console.error(\"UNFINISHED:\", unfinished);
        process.exit(1);
      }
      console.log(\"OK: all 4 expected migrations present and finished\");
      await prisma.\$disconnect();
    })();
  "
'
```

**Expected (last line):** `OK: all 4 expected migrations present and finished`

If MISSING is non-empty → that migration's directory is absent from
the image (rebuild from current HEAD) OR the apply step skipped it
(unlikely — Prisma applies in order). Investigate, then re-run §1.

If UNFINISHED is non-empty → see §8.

---

## 5. Org consistency validator passes

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  pnpm db:check-org-consistency
'
```

**Expected:**
```
[PASS] ✓  1-teams-organization-id-not-null
[PASS] ✓  2-team-org-fk-integrity
[PASS] ✓  3-orgs-have-owner
[PASS] ✓  4-billing-owner-membership
[PASS] ✓  5-membership-user-fk-integrity
[PASS] ✓  6-stale-pending-invites
[PASS] ✓  7-no-duplicate-memberships
[PASS] ✓  8-personal-team-per-org-uniqueness
Result: 0 fail / 0 warn / 8 pass
```
Exit code `0`.

The validator refuses to run when host classification is non-LOCAL
unless you specifically need a production-side scan (currently
gated; production-side consistency monitoring lives in a separate
Stage 7+ pipeline). On the deployed REMOTE container, this command
will exit `2` ("local-only refusal") — which is **expected** and
not a failure. Local-only checks happen during the deploy:safe
chain on the operator's workstation before the REMOTE apply.

**If exit is 8 (FAIL)** → see §8 (consistency breach).
**If exit is 7 (WARN)** → see the printed `[WARN]` rows; usually
re-running `pnpm db:backfill:orgs` reconciles.

---

## 6. `deploy:safe --dry-run` passes inside the rebuilt image

This is the strongest "the image is correct" check. It runs every
preflight stage end-to-end.

```bash
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  export MIGRATE_ALLOW_REMOTE=1
  pnpm deploy:safe:dry --allow-remote
'
```

**Expected:**
```
═══════════════════════════════════════════════════════════════
  deploy:safe summary
═══════════════════════════════════════════════════════════════
  1. [PASS   ] ✓  preflight (classification + risk-scan + drift-check) (…ms)
  2. [PASS   ] ✓  typecheck (services/api)                            (…ms)
  3. [PASS   ] ✓  org consistency (Phase 2.7X Stage 5)                (…ms)
═══════════════════════════════════════════════════════════════
  RESULT: DRY-RUN OK — preflight + typecheck passed.
          Re-run without --dry-run to apply migrations.
═══════════════════════════════════════════════════════════════
```
Exit code `14` (the deploy:safe dry-run-OK sentinel — NOT a
failure; `safe-migrate.mjs` defines this convention).

If a stage shows `[FAIL]` → that stage's own output above the
summary identifies the cause. The risk-scan + drift-check stages
report destructive ops and schema-vs-migration drift respectively;
the typecheck stage reports compile errors against the rolled
schema.

---

## 7. API + worker start healthy

```bash
docker exec docker-proovra-api-1 sh -lc '
  curl -fsS http://localhost:8081/health
'
```
**Expected:** `{"ok":true,"db":"up"}`

For the worker (same pattern, different container name):
```bash
docker exec docker-proovra-worker-1 sh -lc '
  curl -fsS http://localhost:8090/health
'
```
**Expected:** `{"ok":true,"queue":"up"}` (or equivalent worker
health envelope).

Boot-time logs to check (both containers):
```bash
docker logs docker-proovra-api-1 --tail=200 | grep -iE "error|fatal|migrate|signing"
docker logs docker-proovra-worker-1 --tail=200 | grep -iE "error|fatal"
```
**Expected:** no `error` / `fatal` lines from the latest boot. Lines
referencing migrations should be the deploy:safe banner output;
lines referencing signing should be the signing-key seed
confirming the audit_local_ed25519 key (or the production keyId,
depending on env).

---

## 8. What to do if a migration is failed / rolled back / pending

### 8.1 Symptom matrix

| Step that surfaces it | What it means | Action |
|---|---|---|
| §2 `prisma migrate status` shows "Following migration have failed" | The migration ran partially and Prisma marked it failed. `_prisma_migrations.finished_at = NULL`, `rolled_back_at = NULL`, `logs` has the error. | Go to §8.2 |
| §3 row has `rolled_back_at` set | An operator (or a prior `migrate resolve --rolled-back`) marked the migration not-applied. Subsequent deploys will retry. | Go to §8.3 |
| §3 row has `finished_at = NULL` AND `rolled_back_at = NULL` | The migration is still RUNNING (rare for short migrations) OR crashed mid-apply (more common). | Go to §8.4 |
| §4 says MISSING | The migration directory is absent from the image. | Rebuild from current HEAD. |
| §4 says UNFINISHED | Same as §3 — defer to §8.2/§8.3/§8.4 based on which column is set. |

### 8.2 Recovery: failed migration (logs have an error)

```bash
# 1. Read the captured error log
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  node -e "
    const { PrismaClient } = require(\"@prisma/client\");
    const { PrismaPg } = require(\"@prisma/adapter-pg\");
    const pg = require(\"pg\");
    (async () => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      const rows = await prisma.\$queryRawUnsafe(
        \`SELECT migration_name, logs FROM _prisma_migrations
         WHERE finished_at IS NULL AND rolled_back_at IS NULL
         ORDER BY started_at DESC LIMIT 1\`
      );
      console.log(JSON.stringify(rows, null, 2));
      await prisma.\$disconnect();
    })();
  "
'

# 2. Address the root cause in the migration SQL (see Phase 2.7Z
#    FK-type-mismatch patch in
#    docs/product/PHASE_2_7Z_FK_TYPE_NORMALIZATION.md for the
#    canonical recovery pattern for `incompatible types`).

# 3. After the migration SQL is patched on disk, rebuild the image
#    and redeploy. THEN mark the failed attempt rolled-back:
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate resolve --rolled-back <migration_name>
'

# 4. Re-run §1 (safe-migrate) so the patched migration applies.
```

### 8.3 Recovery: rolled-back row, no error

A row with `rolled_back_at` set is in the "operator told us this
didn't actually apply — retry next deploy" state. The next
`prisma migrate deploy` will re-run it. So:

```bash
# Re-run §1. If the migration succeeds this time, §3 will show
# finished_at populated and rolled_back_at cleared (Prisma rewrites
# the row, not appends a new one).
```

### 8.4 Recovery: stuck mid-apply

```bash
# 1. Confirm no in-flight `prisma migrate deploy` is running:
docker exec docker-proovra-api-1 sh -lc '
  ps aux | grep -E "prisma.*migrate|safe-migrate" | grep -v grep
'

# 2. If no process is running → migration crashed. Mark rolled-back
#    and re-run:
docker exec docker-proovra-api-1 sh -lc '
  cd /app/services/api
  npx prisma migrate resolve --rolled-back <migration_name>
'

# 3. THEN re-run §1.
```

### 8.5 What NEVER to do during recovery

- **Never** `DELETE FROM _prisma_migrations WHERE migration_name = '…';`. That
  defeats the change-history Prisma uses for drift detection. Always
  use `prisma migrate resolve --rolled-back`.
- **Never** edit a row in `_prisma_migrations` directly. The columns
  are managed by Prisma; manual edits break later `migrate status`.
- **Never** skip §1 by running raw `npx prisma migrate deploy`. The
  Phase 2.5C `safe-migrate.mjs` wrapper enforces backup discipline
  and REMOTE override — bypassing it removes the production
  guard-rail layer.
- **Never** weaken the remote guard. Both `--allow-remote` AND
  `MIGRATE_ALLOW_REMOTE=1` AND `MIGRATE_BACKUP_ID` are required
  every time. There is no shortcut.

---

## 9. Dockerfile change reference

The single change made:

```diff
 COPY services/api/src services/api/src
 COPY services/api/keys services/api/keys
 COPY services/api/prisma services/api/prisma
 COPY services/api/prisma.config.ts services/api/prisma.config.ts
 COPY services/api/tsconfig.json services/api/tsconfig.json
 COPY services/api/tsconfig.build.json services/api/tsconfig.build.json
+COPY services/api/scripts services/api/scripts
```

That's it. No multi-stage refactor, no new layer, no .dockerignore
edit needed (the existing .dockerignore doesn't exclude `scripts/`).

The runner stage's existing line
`COPY --from=build /app/services/api /app/services/api` automatically
carries the scripts directory into the final image once it's in the
build stage.

---

## 10. Pre-commit verification (local mirror of §0)

To catch packaging regressions before they reach production, add
this build-time assertion to CI (recommended Stage 7 work; not
required for the immediate fix but documented here):

```bash
# After docker build, exec into the freshly built image:
docker run --rm proovra-api:<tag> sh -lc '
  for f in safe-migrate.mjs deploy-safe.mjs db-preflight.mjs \
           check-org-consistency.mjs migration-risk-scan.mjs \
           drift-check.mjs not-null-readiness.mjs \
           protected-runtime-tables.mjs db-host-policy.mjs \
           backfill-organizations.mjs; do
    test -f "/app/services/api/scripts/$f" || {
      echo "MISSING: scripts/$f" >&2
      exit 1
    }
  done
  echo "OK: all required scripts present in image"
'
```

Exit code 0 means the image is deploy-safe-ready. Non-zero blocks
the release.
