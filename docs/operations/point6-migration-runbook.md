# PHASE 12 POINT 6 — Owner migration runbook

```text
THE AGENT DID NOT APPLY PRODUCTION MIGRATIONS.
OWNER EXECUTION IS REQUIRED.
CONTRACT/DROP MIGRATIONS MUST NOT BE APPLIED IN RELEASE A.
```

No production database was contacted while this runbook was produced. Every
command below is for the owner to run. Placeholders are written as
`<like-this>` — **never paste a credential into this file.**

Companion documents:

* release contents and rationale — [`docs/architecture/migration-deployment-plan.md`](../architecture/migration-deployment-plan.md)
* machine-readable inventory — `docs/architecture/migration-inventory-p6.json`
* migration safety wrapper policy — [`MIGRATION_DISCIPLINE.md`](./MIGRATION_DISCIPLINE.md)

---

## 0. Conventions

Set once per session. `P6_TARGET` is the database you are about to change;
`P6_PRODUCTION_READONLY_DATABASE_URL` is a **separate, SELECT-only** credential
used for reading state and nothing else.

```bash
export P6_TARGET="postgresql://<user>:<pw>@<host>/<db>?sslmode=require"
```

Every migration command goes through the safety wrapper
(`pnpm --filter proovra-api prisma:migrate`). It prints host, database and
classification before any SQL runs and refuses a non-local host unless BOTH
`--allow-remote` and `MIGRATE_ALLOW_REMOTE=1` are supplied. If you do not see
that banner, you bypassed the wrapper — stop.

**Release staging.** `prisma migrate deploy` applies every migration directory
it can see that is not yet recorded. The Release-D contract migrations RAISE
when their readiness is not zero, and a raise leaves a FAILED row that blocks
everything after it. So the six `CONTRACT_DROP_LATER` directories **must not be
present in the deployment artifact** until Release D. Stage them by commit:

```bash
git add services/api/prisma/migrations/<release-A-and-B-directories>
```

Leave `20270923500000_persona_profiles_removal_precondition`,
`20270924000000_drop_workspace_persona_profiles`,
`20271105000000_evidence_case_id_removal`,
`20271108000000_legal_hold_legacy_removal`,
`20271117000000_point4_schema_authority_contract` and
`20271118000000_legal_hold_strict_scope_target` out until Release D.

Applying them later, out of lexical order, is supported: Prisma applies any
migration not recorded in `_prisma_migrations`, regardless of name ordering.
This was executed in the production-like rehearsal.

---

## STEP 0 — Read-only production snapshot (do this first)

| | |
|---|---|
| purpose | Establish the real `_prisma_migrations` state, PostgreSQL version and installed extensions |
| environment | production |
| read-only or mutating | **READ ONLY** — the collector opens `BEGIN TRANSACTION READ ONLY` and asserts `transaction_read_only = on` before any query |
| prerequisites | a PostgreSQL role with `CONNECT`, `USAGE ON SCHEMA public` and `SELECT` only |
| expected result | a JSON file with one row per recorded migration, host/database in redacted form, no application data |
| stop condition | the collector exits 11 (`transaction_read_only` not on) or 12 (query failed) |
| recovery | none needed — it writes nothing |
| evidence to save | `p6-production-snapshot.json` |

```bash
P6_PRODUCTION_READONLY_DATABASE_URL="postgresql://<readonly-user>:<pw>@<host>/<db>?sslmode=require" node services/api/scripts/p6-production-migration-snapshot.mjs --out p6-production-snapshot.json
```

Then reconcile it against the inventory:

```bash
node services/api/scripts/migration-production-reconcile.mjs p6-production-snapshot.json --write
```

Exit 0 means every blocking divergence class is zero. Exit 1 lists the
divergences: checksum conflict, renamed-after-deployment, production-only
migration, failed/rolled-back/unfinished migration, duplicate timestamp.
**Do not "fix" `_prisma_migrations`.** A checksum conflict means the file was
edited after being applied — restore the applied bytes or add a forward
migration.

---

## RELEASE A — prerequisites and Expand/Repair · `SAFE_TO_APPLY_NOW`

### A.1 Backup

| | |
|---|---|
| purpose | A restorable point before the first schema change |
| environment | production |
| read-only or mutating | reads production, writes a backup artifact |
| expected result | a restorable snapshot/PITR checkpoint you have verified exists |
| stop condition | no verified backup — **do not proceed** |
| evidence to save | backup id + timestamp |

### A.2 Extension prerequisite

| | |
|---|---|
| purpose | `pgvector` must exist before the Point-5 embedding chain runs |
| environment | production |
| read-only or mutating | **mutating** (creates an extension) |
| prerequisites | a role permitted to create extensions; the server image must ship pgvector |
| expected result | `CREATE EXTENSION` or a no-op notice |
| stop condition | "could not open extension control file" — the server does not ship pgvector; deploy an image that does |
| recovery | roll forward only; the extension is additive |

```bash
psql "$P6_TARGET" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### A.3 Pre-flight status (read-only)

```bash
cd services/api && pnpm prisma:migrate:status
```

Expect exactly the Release-A set as pending and **zero** failed rows. Any
failed row is a stop condition.

### A.4 Apply Release A

| | |
|---|---|
| purpose | Additive columns/tables/indexes, the uuid default repair, the duplicate-column write unblock, the canonical legal-hold expansion |
| environment | production |
| read-only or mutating | **mutating (schema only — no pre-existing row is written)** |
| prerequisites | A.1 backup verified, A.3 clean |
| expected result | 18 migrations applied, 0 failed |
| stop condition | any RAISE; in particular `uuid_id_default_repair: table % has an incompatible id default` |
| recovery | roll forward — investigate the raised condition and re-run. Never `prisma migrate resolve` to skip. |
| evidence to save | full command output, plus A.5 |

```bash
MIGRATE_ALLOW_REMOTE=1 pnpm --filter proovra-api prisma:migrate deploy --allow-remote
```

### A.5 Backward-compatibility check (read-only)

The previous build is still serving. Confirm it still works:

```bash
pnpm --filter proovra-api db:raw-schema-verify
```

Expect `OK — N registered object(s) verified, 0 unregistered divergences, 0
objects proposed for removal.` Then confirm the live API log still shows
`runtime.schema_validation.healthy`.

Spot-check that the write-unblock landed:

```bash
psql "$P6_TARGET" -c "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE (table_name,column_name) IN (('cross_org_review_grants','created_by_user_id'),('delegated_admin_grants','grantee_user_id'),('redaction_policy_assignments','policy_version_id'));"
```

All three must read `is_nullable = YES`.

**Stop conditions for Release A:** any failed migration row; `raw-schema-verify`
reporting a divergence; the API logging `runtime.schema_validation.critical`.

---

## RELEASE B — Backfill and readiness · `WAIT_FOR_BACKFILL_READINESS`

**CONTRACT/DROP MIGRATIONS ARE PROHIBITED IN THIS RELEASE.**

### B.1 Size the backfills (read-only)

```bash
DATABASE_URL="$P6_TARGET" node services/api/scripts/backfill-case-evidence-links.mjs --check
DATABASE_URL="$P6_TARGET" node services/api/scripts/legal-hold-convergence-report.mjs
```

Record `protectedEvidenceCount` from the second command. **It must never
decrease.**

### B.2 Apply Release B

| | |
|---|---|
| purpose | Deterministic backfills into the canonical authorities |
| environment | production |
| read-only or mutating | **mutating (rows)** |
| prerequisites | Release A applied; B.1 recorded |
| expected result | 12 migrations applied, 0 failed |
| stop condition | any RAISE — e.g. `org_security_policy_org_scoped` on conflicting duplicate policies, or the legal-hold backfill's post-conditions |
| recovery | every backfill is idempotent and resumable — resolve the named rows and re-run `migrate deploy`. An interrupted run continues where it stopped; it never double-inserts (deterministic idempotency keys). |
| evidence to save | command output + B.3 |

```bash
MIGRATE_ALLOW_REMOTE=1 pnpm --filter proovra-api prisma:migrate deploy --allow-remote
```

Expect these notices, which are informational, not failures:

* `legal-hold backfill: N ACTIVE orphaned hold(s) preserved as HISTORICAL` —
  each one BLOCKS its workspace by design until you resolve it;
* `point5 …duplicate… resolved` — older duplicate rows moved to a terminal
  state with a bounded reason. **Nothing is deleted.**

### B.3 Readiness (read-only, exits non-zero while blocking)

```bash
DATABASE_URL="$P6_TARGET" node services/api/scripts/backfill-case-evidence-links.mjs --check
DATABASE_URL="$P6_TARGET" node services/api/scripts/legal-hold-convergence-report.mjs
DATABASE_URL="$P6_TARGET" node services/api/scripts/not-null-readiness.mjs
DATABASE_URL="$P6_TARGET" pnpm --filter proovra-api db:check-org-consistency
DATABASE_URL="$P6_TARGET" pnpm --filter proovra-api db:point5-vector-readiness
```

Blocking categories and what they mean are listed in the deployment plan §3.

**Resolving them is an operator decision, and only these shapes are legitimate:**

* orphan legacy pointer → detach the evidence (`case_id = NULL`) after
  confirming the Case is really gone;
* cross-workspace link → delete the *link* (never the evidence or the case);
* duplicate links → keep one, delete the surplus link row;
* cross-workspace hold → re-home it to the workspace that owns the target,
  preserving who placed it and when;
* hold whose placing user is gone → restore the user record; **never**
  re-attribute the hold to a different person;
* ACTIVE historical (orphaned) hold → investigate and RELEASE it explicitly,
  with attribution and a release note. Mirror that decision onto the still-live
  legacy source row so both stores agree.

**Never** delete evidence, a case, an audit row or a hold's provenance to make
a readiness count reach zero.

**Monitoring during B:** watch for lock waits on `case_evidence_links` and
`evidence_legal_holds` (the FK adds are `NOT VALID` then `VALIDATE`, so they
take only `SHARE UPDATE EXCLUSIVE`), and for the destruction/archive sweeps
(the Point-5 indexes change their claim semantics from "hope" to "claim").

---

## RELEASE C — Runtime cutover · `WAIT_FOR_RUNTIME_CUTOVER`

No migrations.

| | |
|---|---|
| purpose | Deploy the build that reads and writes only the canonical schema |
| environment | production |
| read-only or mutating | deploys code |
| prerequisites | Release B applied; B.3 readiness recorded |
| expected result | API logs `runtime.schema_validation.healthy`; worker starts and drains |
| stop condition | `runtime.schema_validation.critical`, or any error naming `evidence.case_id`, `case_legal_holds` or `legal_holds` |
| recovery | redeploy the previous build — every Release A/B migration is additive, defaulted or idempotent, so the older build keeps working |
| evidence to save | boot logs for API and worker |

Order: **API first, then worker.** No queue pause is required — both schemas
are readable by both builds.

Verify canonical read/write after cutover:

```bash
psql "$P6_TARGET" -c "SELECT count(*) AS canonical_links FROM case_evidence_links;"
psql "$P6_TARGET" -c "SELECT scope, status, count(*) FROM evidence_legal_holds GROUP BY 1,2 ORDER BY 1,2;"
```

Then re-run the exchange semantics migration once, because the pre-cutover
build may have written authorisation times back into `downloaded_at_utc`:

```bash
psql "$P6_TARGET" -f services/api/prisma/migrations/20271110000000_exchange_download_authorization_semantics/migration.sql
```

(That file is idempotent and guarded; running it by hand does not change
`_prisma_migrations`.)

---

## OBSERVATION WINDOW · `WAIT_FOR_OBSERVATION_WINDOW`

Minimum evidence before Release D — see plan §5. In short: two clean readiness
runs at least 24h apart, `protectedEvidenceCount` not decreased, zero legacy
accesses in logs, `raw-schema-verify` OK, `schema_validation.healthy` sustained.

---

## RELEASE D — Contract/Drop · `CONTRACT_DROP_LATER`

### D.1 Fresh backup — mandatory

A dropped column, table or hold store is not recoverable. Take and verify a new
backup immediately before this release.

### D.2 Pre-checks (read-only, all must be zero)

```bash
DATABASE_URL="$P6_TARGET" node services/api/scripts/backfill-case-evidence-links.mjs --check
DATABASE_URL="$P6_TARGET" node services/api/scripts/legal-hold-convergence-report.mjs
pnpm --filter proovra-api db:raw-schema-verify
```

### D.3 Stage the contract migrations into the artifact

Add the six `CONTRACT_DROP_LATER` directories to the deployed commit — see
§0 Release staging.

### D.4 Apply Release D

| | |
|---|---|
| purpose | Remove the legacy schema the runtime no longer uses |
| environment | production |
| read-only or mutating | **mutating and IRREVERSIBLE** |
| prerequisites | D.1 backup verified; D.2 all zero; observation window closed |
| expected result | 6 migrations applied, 0 failed |
| stop condition | ANY RAISE. Each one names the exact blocking counts. |
| recovery | **roll forward only.** A raised guard changes nothing — resolve the named rows and re-run. Never weaken a guard, never `migrate resolve` a contract migration. |
| evidence to save | full output including the `NOTICE … readiness is zero — proceeding` lines |

```bash
MIGRATE_ALLOW_REMOTE=1 pnpm --filter proovra-api prisma:migrate deploy --allow-remote
```

### D.5 Post-contract verification

```bash
psql "$P6_TARGET" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='evidence' AND column_name='case_id';"        # expect 0
psql "$P6_TARGET" -c "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('case_legal_holds','legal_holds','workspace_persona_profiles');"  # expect 0
psql "$P6_TARGET" -c "SELECT count(*) FROM evidence_legal_holds;"     # must equal the post-Release-B count
pnpm --filter proovra-api db:raw-schema-verify
cd services/api && pnpm prisma:migrate:status                          # expect: no pending migrations
```

Restart API and worker and confirm `runtime.schema_validation.healthy` again.

### D.6 Adapter removal

Once D.5 is green, the compatibility-adapter entries in
`docs/architecture/compatibility-adapter-registry.json` bound to
`20271105000000_evidence_case_id_removal` and
`20271117000000_point4_schema_authority_contract` are inert and may be deleted.

---

## `HISTORICAL_PRESERVE_NEVER_REWRITE`

The 185 migrations before `20270920000000_account_closure_requests` are settled
history. Their bytes are a Prisma checksum recorded in every database that has
applied them.

**Never** rewrite, rename, re-time, split or delete one. If a historical
migration is wrong, fix it with a NEW forward migration. This includes
`email_password_auth`, the unnumbered directory whose SQL is byte-identical to
`20260215095541_email_password_auth`: it is not a rename, both may be recorded
in `_prisma_migrations`, and deleting it would create a
"migration missing locally" drift.

---

## Command index by wave

| wave | owner action |
|---|---|
| `HISTORICAL_PRESERVE_NEVER_REWRITE` | none, ever |
| `SAFE_TO_APPLY_NOW` | Release A — A.1 → A.5 |
| `OWNER_ACTION_AFTER_BACKUP` | (no migration currently in this wave) |
| `WAIT_FOR_BACKFILL_READINESS` | Release B — B.1 → B.3 |
| `WAIT_FOR_RUNTIME_CUTOVER` | Release C |
| `WAIT_FOR_OBSERVATION_WINDOW` | observation window |
| `CONTRACT_DROP_LATER` | Release D — D.1 → D.6 |
