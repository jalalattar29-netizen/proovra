# Internal-grant release — Production rollout (owner runbook)

**Owner-executed.** No agent session has Production access, and none applied, deployed or
activated anything. Every step below runs on the Production host (checkout
`/opt/proovra/app`, compose file `infra/docker/docker-compose.prod.yml`, env file
`/opt/proovra/app/.env`). Nothing prints a credential: tools read `DATABASE_URL` from the
container environment and output counts, names, ids and SHA-256 fingerprints only.

The release is `feat/internal-plan-grant`. It ships nine migrations — the eight Universal
Evidence Capture migrations merged to `main` in `71d2bcbb` that Production has never applied,
plus the internal plan grant — and the API/worker code that **requires all nine**.

> **Why all nine, in one window.** `main`'s Prisma models already declare
> `evidence.signing_key_sha256` (000400) and `evidence_part_derived_assets.generation_parameters`
> (000000) / `storage_version_id` (000600). An image from `main` on a database without them
> fails every unnarrowed evidence/derived-asset read with P2022 — the Release-B invite outage
> class. Prisma applies in timestamp order and no runner in this repository can apply a single
> named migration, so `20281002000000_internal_plan_grants` cannot go ahead of the eight.

## 0. What you need before starting

| Item | How |
|---|---|
| A Neon (or provider) backup you can restore from | §2 |
| `RELEASE_SHA` | the final `feat/internal-plan-grant` commit (40 hex): `git rev-parse origin/feat/internal-plan-grant` |
| Images for that commit | GitHub → Actions → **deploy-images** → *Run workflow* on `feat/internal-plan-grant`. Produces `ghcr.io/<owner>/proovra-api:sha-<7>` and `proovra-worker:sha-<7>`. A fast-forward of `main` later keeps the SHA, so these are the release images (the main push rebuilds the same tag; the deploy script proves the revision label either way). |
| A Platform Admin actor | your own user id, from `admins` in §4 — never guessed |
| A maintenance window | §1 lock planning; the API keeps serving throughout (old code is compatible with all nine) |

```bash
cd /opt/proovra/app
git fetch --tags origin
export GHCR_OWNER=jalalattar29-netizen
export RELEASE_SHA="$(git rev-parse origin/feat/internal-plan-grant)"
export IMAGE_TAG="sha-${RELEASE_SHA:0:7}"
export COMPOSE="docker compose -f infra/docker/docker-compose.prod.yml"
echo "$RELEASE_SHA $IMAGE_TAG"
docker pull "ghcr.io/$GHCR_OWNER/proovra-api:$IMAGE_TAG"
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "ghcr.io/$GHCR_OWNER/proovra-api:$IMAGE_TAG"          # must print $RELEASE_SHA exactly
# The release's tools, run as one-off containers of the NEW image with the service's own env:
export ROLLOUT="$COMPOSE run --rm --no-deps -T --entrypoint node proovra-api"
```

`$ROLLOUT` starts a throw-away container from the **new** image (it carries the nine migrations
and the tools) with exactly the env the API service gets. It serves no traffic, and the running
API is not touched. Run `$COMPOSE ps` first and keep the output: that is what is running now.

## 1. The migration plan

All nine are applied by ONE run of the canonical runner (§3), in this order. "Old API" = the
image Production runs now (compatibility was checked against the pre-UC `main`, `47034f45`);
"new" = `$RELEASE_SHA`.

| # | Migration | Schema effect | Existing rows changed | Readiness (stop if ≠) | Expected rows | Backup | Lock risk | Rollback limitation | Required by | Order |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `20281001000000_derived_asset_generations` | swaps CHECK `evidence_part_derived_assets_status_bounded` for a superset (+`SUPERSEDED`); adds nullable `generation_parameters JSONB` | none | derived-asset statuses outside the new catalog = **0** | 0 | full (window) | ACCESS EXCLUSIVE on `evidence_part_derived_assets` while the new CHECK validates every row (scan ∝ rows; see `rowEstimates`) | constraint can be swapped back; column is inert to old code | new API + worker (model declares the column) | before images |
| 2 | `…000100_acquisition_source_backfill_only` | `CREATE OR REPLACE FUNCTION evidence_acquisition_set_once()` — late `acquisition_mode_source` must be `BACKFILL_*` | none | — | 0 | full | brief, function only | re-create previous body | new API (old API never assigns a source late) | any |
| 3 | `…000200_case_evidence_link_pair_unique` | UNIQUE index `(case_id, evidence_id)` on `case_evidence_links`; **refuses** if duplicates exist | none | duplicate pairs = **0** | 0 | full | SHARE lock (blocks link writes) for the index build | `DROP INDEX` restores the old behaviour | new API (maps the unique violation to "already linked") | before images |
| 4 | `…000300_entitlement_one_active` | partial UNIQUE `(user_id) WHERE active` on `entitlements`; **refuses** if any user has >1 active | none | users with >1 active entitlement = **0** | 0 | full | SHARE lock (blocks entitlement writes: sign-up, credit spend) for the build | `DROP INDEX` | new API (`ensureEntitlement` re-reads the winner) | before images |
| 5 | `…000400_signing_key_identity_immutable` | nullable `evidence.signing_key_sha256`; triggers refusing identity change / un-revoke / delete on `signing_keys` | none | `proovra_refuse_history_rewrite()` exists | 0 | full | ACCESS EXCLUSIVE on `evidence` for the metadata-only ADD COLUMN — **waits behind any long transaction** (`transactionsOlderThan60s`); brief on `signing_keys` | drop the two triggers; the column is inert | **new API + worker (Evidence model declares the column — P2022 without it)** | before images |
| 6 | `…000500_capture_trust_events_append_only` | trigger refusing UPDATE/DELETE on `capture_trust_event_records` | none | function exists | 0 | full | brief | drop the trigger | integrity only; old and new code never update/delete these rows | any |
| 7 | `…000600_derived_asset_storage_version` | nullable `evidence_part_derived_assets.storage_version_id` | none | — | 0 | full | brief ACCESS EXCLUSIVE (metadata only) | column inert | **new worker + API (model declares it)** | before images |
| 8 | `…000700_retention_backfill_direct_capture` | **DATA**: sets `retention_until_utc = created_at + policy days` for non-deleted mobile/extension/Android/iOS records with NULL retention in workspaces whose policy sets `default_retention_days > 0` | **yes — exactly `backfill000700.expectedRowsUpdated`** | one policy row per team = **0** duplicates | `expectedRowsUpdated` from readiness | **required, verified (§2)** — the previous NULL is not recorded | row locks on the updated `evidence` rows only | restore from backup, or set those rows back to NULL where the date equals `created_at + policy days` (the sweeper only FLAGS expired rows, it never deletes) | data only; neither image depends on it | anywhere in the window |
| 9 | `20281002000000_internal_plan_grants` | `CREATE TYPE "PlanGrantSource"`, `CREATE TABLE plan_grants` + 4 CHECKs, FK → `users` ON DELETE CASCADE, unique `idempotency_key`, index `user_id`, partial unique `(user_id, source) WHERE revoked_at_utc IS NULL` | none (0 rows created) | `plan_grants` absent; `PlanType` has TEAM | 0 | full | brief SHARE ROW EXCLUSIVE on `users` while the FK is added | `DROP TABLE plan_grants; DROP TYPE "PlanGrantSource"` once no deployed code reads it | **new API + worker read it on every Personal plan resolution** | before images |

**Old API after all nine:** compatible. Every change is additive (nullable columns old models
do not name, a superset CHECK, triggers on writes old code never makes, a new table). The two
unique indexes only turn a concurrent duplicate — which old code already avoided with a
read-then-write — into a single failed request instead of a silent duplicate row.

**New API/worker:** start only after ALL nine (the deploy script's schema gate refuses
otherwise). Between migrations 1–9 the old API keeps serving; no image change happens until §5.

## 2. Backup (and prove it is readable)

1. Neon console → the Production project → **Branches → Create branch** from the primary
   branch at *now* (or your provider's snapshot). Record its id: `export MIGRATE_BACKUP_ID=<id>`.
2. Prove the backup is a real, readable copy at the same state — run the read-only readiness
   check against **the backup's** connection string (typed, not echoed, not in history):

```bash
read -rs BACKUP_DATABASE_URL && export BACKUP_DATABASE_URL
$COMPOSE run --rm --no-deps -T -e DATABASE_URL="$BACKUP_DATABASE_URL" --entrypoint node proovra-api \
  dist/scripts/internal-grant-rollout.js readiness > .deploy-state/readiness-backup.json; echo "exit $?"
unset BACKUP_DATABASE_URL
```

Its migration list and counts must equal §3's readiness on Production.

## 3. Readiness, then the nine migrations

```bash
mkdir -p .deploy-state
$ROLLOUT dist/scripts/internal-grant-rollout.js readiness | tee .deploy-state/readiness-before.json; echo "exit ${PIPESTATUS[0]}"
$ROLLOUT dist/scripts/internal-grant-rollout.js admins            # note YOUR platform-admin user id
```

**STOP unless exit 0 and `"verdict": "READY"`.** In particular:

* `000200: zero duplicate (case, evidence) link pairs` / `000300: zero users with more than one
  active entitlement` must be `ok`. If not, the migration would REFUSE (it never deletes or
  merges). Deciding which link/entitlement survives is an owner decision — credits on a
  duplicate entitlement may be purchases. Resolve through the product, re-run readiness.
* `no pending migration outside this release` must be `ok` — if another migration is pending,
  stop: this runbook is not authorised to apply it.
* Record `backfill000700.expectedRowsUpdated` and `lockPlanning`. If
  `transactionsOlderThan60s > 0`, wait — 000400's `ALTER TABLE evidence` queues behind them and
  every evidence query queues behind it.

Apply through the canonical runner (`safe-migrate.mjs` → `prisma migrate deploy`), from the new
image, with the backup id it requires for a remote database:

```bash
$COMPOSE run --rm --no-deps -T -e MIGRATE_ALLOW_REMOTE=1 -e MIGRATE_BACKUP_ID="$MIGRATE_BACKUP_ID" \
  --entrypoint node proovra-api scripts/safe-migrate.mjs deploy --allow-remote; echo "exit $?"
```

Expected: nine `Applying migration …` lines, then `All migrations have been successfully applied.`

**If a migration fails** (e.g. `P3018` naming 000200/000300): nothing after it ran, and the
failed one is recorded as failed. The two fail-closed migrations raise before creating anything.
Fix the cause, then mark it rolled back and re-run (both through the same runner):

```bash
$COMPOSE run --rm --no-deps -T -e MIGRATE_ALLOW_REMOTE=1 -e MIGRATE_BACKUP_ID="$MIGRATE_BACKUP_ID" \
  --entrypoint node proovra-api scripts/safe-migrate.mjs resolve --rolled-back <migration_name> --allow-remote
```

(Rehearsed on a disposable PostgreSQL 16: a duplicate active entitlement stopped 000300 with
`UC-COM-004: 1 user(s) …`; after the duplicate was resolved and the migration marked rolled
back, readiness returned READY and the remaining six applied.)

## 4. Verify the schema, and the OLD API

```bash
$ROLLOUT dist/scripts/internal-grant-rollout.js verify-schema | tee .deploy-state/verify-schema.json; echo "exit ${PIPESTATUS[0]}"
$ROLLOUT scripts/runtime-schema-gate.mjs; echo "exit $?"
curl -fsS http://127.0.0.1:8080/health; echo; curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8090/health | head -c 300; echo
curl -fsS https://api.proovra.com/health; echo
```

`verify-schema` must be `PASS` (each of the nine recorded exactly once, nothing pending, every
column/index/trigger/constraint present, `000700 left no candidate row`, `planGrantRows: 0`).
The gate must print `PASS — all N required objects present`. The OLD API and worker must still
be healthy. **Do not create the grant yet.**

## 5. Main, then API + worker

1. Fast-forward `main` to `$RELEASE_SHA` (no merge commit, no force):
   `git push origin "$RELEASE_SHA:refs/heads/main"` from a workstation, after confirming
   `git merge-base --is-ancestor origin/main $RELEASE_SHA`.
2. Wait for **Main CI** green on `$RELEASE_SHA` (`ci`, `schema-reproducibility`,
   `playwright-e2e`, `deploy-images`, and `uc1-browser-acceptance` when triggered) and the
   Vercel production deployment of the web app.
3. Deploy — the script records the running release as the rollback point, checks out the
   compose file at `$RELEASE_SHA`, pulls, proves each image's revision label, runs the schema
   gate from the new image, then recreates the API (waits for health + `/readyz`) and then the
   worker (health). It prints the image/tag/SHA first and never prints env values.

```bash
./scripts/deploy-prod-pull.sh --plan      # review: selected release + current rollback point
./scripts/deploy-prod-pull.sh
```

4. Verify:

```bash
$COMPOSE ps
for s in proovra-api proovra-worker; do
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$(docker inspect --format '{{.Config.Image}}' "$($COMPOSE ps -q $s)")"; done   # both = $RELEASE_SHA
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz        # 200
curl -fsS http://127.0.0.1:8090/health | head -c 400; echo                      # ok, redis up
$COMPOSE logs --since 15m proovra-api proovra-worker 2>&1 | grep -Ei 'P2022|P2021|does not exist|plan_grants' | head
```

The last command must print nothing. In Sentry, filter the last hour for `P2022`, `P2021`,
`does not exist` and `plan_grants`: no new issues. A FREE and a paid account (yours) must
still load Billing with their real plan.

**Rollback (code):** `./scripts/deploy-prod-pull.sh --rollback` redeploys the recorded previous
release with the same proofs. The migrations are forward-only and the old image is compatible
with them (§1), so a code rollback needs no database change.

## 6. Activate the test account (exactly one grant)

```bash
export ADMIN_ID=<your platform-admin user id from `admins`>
export GRANT_KEY="owner-test:reem.ammar@hotmail.com:team:2026-10"
export EXEC="$COMPOSE exec -T proovra-api node"

$EXEC dist/scripts/internal-plan-grant.js status --email=reem.ammar@hotmail.com          # must list NO active grant
$EXEC dist/scripts/internal-grant-rollout.js snapshot --email=reem.ammar@hotmail.com --out=/tmp/reem-before.json
#   → exactly one user resolved (otherwise SUBJECT_NOT_FOUND / SUBJECT_AMBIGUOUS — stop);
#     record userId, personalTeamId, providerPlan, effective, activeGrant (must be null).

export EXPIRES="$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"
$EXEC dist/scripts/internal-plan-grant.js apply --email=reem.ammar@hotmail.com \
  --actor-user-id="$ADMIN_ID" --reason="Owner-authorized PROOVRA end-to-end Product testing" \
  --idempotency-key="$GRANT_KEY" --expires-at="$EXPIRES" --confirm
#   → "created": true, grant.plan TEAM, grant.source INTERNAL_TEST, grant.expiresAtUtc = $EXPIRES

$EXEC dist/scripts/internal-grant-rollout.js snapshot --email=reem.ammar@hotmail.com --out=/tmp/reem-after.json
$EXEC dist/scripts/internal-grant-rollout.js compare --before=/tmp/reem-before.json --after=/tmp/reem-after.json \
  --expect=grant-applied --idempotency-key="$GRANT_KEY" --expiry-days=90
```

The CLI is the canonical service (`applyInternalPlanGrant`) — the same transaction, lock,
validation and audit the admin route uses; there is no SQL. It refuses without `--confirm` and
without a live Platform Admin actor.

## 7. Prove it

`compare --expect=grant-applied` must print `"verdict": "PASS"`. Its checks are the proof:

* same user and personal workspace; **provider plan unchanged**; active entitlement count unchanged;
* `subject grants +1`, `subject applied events +1` (exactly one `billing.internal_grant.applied`),
  `all grants +1`, `all applied events +1`;
* one active grant: plan `TEAM`, source `INTERNAL_TEST`, the idempotency key, expiry = activation
  + 90 days;
* effective plan `TEAM`, source `INTERNAL_GRANT` — computed by the SAME reader
  (`readActiveInternalPlanGrant`) and policy (`resolvePersonalEffectivePlan`) the API and the
  worker both call;
* unchanged — row count AND a SHA-256 over every column of every row — for: entitlements,
  subscriptions, payments, billing checkout attempts, evidence-credit ledger, team memberships,
  owned workspaces, storage add-ons, workspace usage counters, evidence, reports, verification
  packages. (No Stripe/PayPal object can exist without a checkout attempt or subscription row.)

Then the idempotent replay — it must change **nothing**:

```bash
$EXEC dist/scripts/internal-plan-grant.js apply --email=reem.ammar@hotmail.com \
  --actor-user-id="$ADMIN_ID" --reason="Owner-authorized PROOVRA end-to-end Product testing" \
  --idempotency-key="$GRANT_KEY" --expires-at="$EXPIRES" --confirm                     # "created": false, same grant id
$EXEC dist/scripts/internal-grant-rollout.js snapshot --email=reem.ammar@hotmail.com --out=/tmp/reem-replay.json
$EXEC dist/scripts/internal-grant-rollout.js compare --before=/tmp/reem-after.json --after=/tmp/reem-replay.json --expect=none
for f in before after replay; do $COMPOSE cp proovra-api:/tmp/reem-$f.json .deploy-state/; done
```

In the product: the account signs in with its own credentials (never requested), its Personal
workspace shows TEAM capabilities, and Billing shows **granted** access with no TEAM purchase
offer; a TEAM checkout answers `409 INTERNAL_GRANT_ACTIVE` before any provider call.

**Rollback (grant):** `$EXEC dist/scripts/internal-plan-grant.js revoke --email=reem.ammar@hotmail.com
--actor-user-id="$ADMIN_ID" --reason="<why>" --confirm` — the account falls back to its provider
plan on the next read (rehearsed: TEAM/INTERNAL_GRANT → FREE/PERSONAL_ENTITLEMENT). Do not revoke
the live grant to "test" this; the integration suite and the rehearsal prove it.

## 8. Record

Keep `.deploy-state/` (readiness, verify-schema, the three snapshots, `previous-release`,
`history.log`). Report: previous/final `main` SHA, `$RELEASE_SHA`, migration list and
`verify-schema` verdict, deployed revisions, user id, personal workspace id, previous provider
plan, grant id, expiry, the two `compare` verdicts.
