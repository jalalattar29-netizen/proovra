# Disaster Recovery (DR) — posture, targets, and restore procedure

> **Honesty note.** This document describes the DR posture **as
> configured and as intended**. It does **not** assert any uptime
> guarantee, SLA, or certification. RPO/RTO figures below are stated
> **targets / assumptions**, not contractual guarantees. Each item is
> explicitly marked as **[configured]**, **[assumed / managed
> platform]**, or **[not in repo]** so an operator or reviewer can tell
> what is proven from what is delegated.

## Scope

Covers recovery of the PROOVRA platform after data loss, region
outage, or corruption. The live, machine-computed posture is available
to platform admins at **`/operations/readiness`** (backend
`GET /v1/operations/readiness`).

## Recovery objectives (targets — NOT guarantees)

No RPO or RTO has been approved. Nothing below may be quoted to a customer.

| Objective | Target | Basis |
|-----------|--------|-------|
| RPO (recovery point) | **Not approved.** With the `pg-backup` service running it is at most `BACKUP_INTERVAL_SECONDS` (default 6 hours) plus the time to the next off-host copy (default 1 hour) | **[configured, once started]** — a provider's point-in-time recovery, if there is one, can only be finer; verify it out-of-band |
| RTO (recovery time) | **Not approved and not measured on production data.** Restore + migrate-forward + artifact regeneration | **[not measured]** — the local drill proves the restore works, on test data, on a workstation |

These are planning figures. They become real when the owner approves them and a
drill has run against the production database's backup.

## What is configured vs assumed vs not-in-repo

### Evidence object preservation — **[configured, verifiable]**

- Evidence originals are retained under S3 Object Lock in **COMPLIANCE**
  mode for at least **2,920 days** from sealing. Production requires
  `S3_OBJECT_LOCK_ENABLED=true`, `S3_OBJECT_LOCK_MODE=COMPLIANCE` and
  `S3_OBJECT_LOCK_RETAIN_DAYS` unset or >= 2920; anything else is a
  startup violation for the API and the worker
  (`objectLockPostureViolations`, `@proovra/shared`).
- Live status is probed by
  `services/api/src/services/operations/object-lock-status.service.ts`
  and surfaced by `GET /v1/operations/exports/object-lock` and the
  readiness posture. When the bucket does not actually support Object
  Lock, the status reports `claimed-but-unsupported` — it never
  fakes a "verified" badge.
- Startup verification (API and worker) refuses to boot in production
  when the bucket cannot hold COMPLIANCE locks, cannot be verified, or
  carries a default retention weaker than the contract. There is no
  bypass. `/readyz` reports `storage_unreachable` /
  `object_lock_unverified` while the bucket is unreachable or wrong.
- **[infrastructure-owned]** The durability, versioning and any
  cross-region replication of the evidence bucket belong to the storage
  provider's configuration. The database backup below does NOT back up
  S3 objects.

### Database backup — **[in the deployment; started by the operator]**

The scripts in `scripts/ops` are run by two services in
`infra/docker/docker-compose.prod.yml`, under the `backup` profile. The release
deploy does not start them, and warns while they are not running:

```bash
docker compose --env-file /opt/proovra/app/.env \
  -f infra/docker/docker-compose.prod.yml --profile backup up -d
```

- `pg-backup` runs `pg-backup-cycle.sh --loop`. Each cycle takes a logical backup
  of `DIRECT_URL` (`pg-backup.sh`: `pg_dump` custom format from ONE exported
  snapshot, plus a SHA-256, exact per-table row counts and a schema fingerprint from
  the same snapshot), keeps the newest `BACKUP_RETAIN` under
  `/opt/proovra/backups/postgres` (umask 077), and records the outcome.
- `BACKUP_RETAIN` defaults to **4**, sized to the production host (75 GB disk, about
  11 GB free on 2026-11-21, a dump of about 1.07 GB). Four dumps hold about 4.3 GB.
  A fifth exists only while a backup runs, because retention runs after it. The
  weekly drill needs about 3.5 GB of scratch on the same disk, so the worst moment
  is about 7.8 GB. The old default of 14 would have needed about 15 GB. Older copies
  are kept by the off-host bucket's lifecycle.
- **Before writing anything**, `pg-backup.sh` checks two things and stops with
  `pg-backup: FAILED — <reason>` and exit 1 if either fails. The cycle then records
  `DATABASE_BACKUP FAILED`.
  - The client and server major versions. A client older than the server fails with
    `version mismatch — pg_dump client is PostgreSQL N and the server is PostgreSQL M`
    and names the image to use.
  - Free space. The backup directory must have at least 2 × the newest dump plus
    `BACKUP_FREE_MARGIN_MB` (default 1024) free. With no earlier dump, the database
    size stands in for the dump. Otherwise it fails with
    `insufficient disk space — … has X MB free and needs Y MB`.
- The `platform_backup_records` row carries no reason column. The reason is in the
  `pg-backup` container log, which keeps the `FAILED — <reason>` line.
- Every `BACKUP_DRILL_EVERY_SECONDS` (default weekly) the same cycle restores the
  newest backup into a throwaway server inside its own container
  (`pg-restore-drill-local.sh`), requires row counts and the schema fingerprint to
  match exactly, and records the outcome. The drill cannot reach production. The
  drill's server runs with `max_wal_size=256MB` and `min_wal_size=80MB`.
  Measured on the production dump, a restore with the default WAL settings used
  about 5.6 GB of disk, and about 3.5 GB with bounded WAL. The drill refuses to
  start unless its scratch space has 4 × the dump plus `DRILL_FREE_MARGIN_MB`
  (default 1024) free.
  The first cycle after the service starts runs a drill, because no earlier drill
  is recorded.
- `pg-backup-offhost` copies the directory to `BACKUP_S3_URI` with its own
  credentials (`BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`,
  `BACKUP_AWS_REGION`, `BACKUP_S3_ENDPOINT_URL`). After each copy it verifies the
  newest backup at the destination: the dump, its `.sha256`, `.counts` and `.schema`
  are all there, each with its local size, and the remote `.sha256` equals the local
  one. It leaves the result for the next cycle to record. It never deletes
  remotely, so retention there is the bucket's lifecycle. The destination (a
  dedicated bucket and credential, separate from the evidence bucket) and its
  retention are set up by the owner: `docs/operations/offhost-backup-and-pitr.md`.
- `pg-backup-offhost-verify.sh` proves the off-host copy restores: it downloads the
  newest off-host dump, checks its SHA-256 against the uploaded `.sha256`, the local
  record and `platform_backup_records`, and restores the retrieved copy with
  `pg-restore-drill-local.sh` (see "Proving the off-host copy restores" below).
- The image is `pgvector/pgvector:pg17`, pinned by digest
  (`sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd`).
  Production runs managed PostgreSQL 17 (17.12 on 2026-11-21). The image used to be
  `pg16`, which **cannot dump a PG17 server**, and the service had never run. When
  the server moves to a new major version, change this image first; the version
  check will otherwise fail every cycle.
- Each outcome is a row in `platform_backup_records` (counts and a checksum, never
  data). The readiness posture reads those rows:

| `databaseBackup` | Means |
|---|---|
| `restore_verified` | a backup and an off-host copy within 48 hours, and a drill within 35 days |
| `backup_recorded` | a backup is recorded; the reason names what is missing or stale |
| `provider_declared_unverified` | no run recorded; `DATABASE_BACKUP_PROVIDER` names a provider, which cannot be seen from here |
| `no_backup_recorded` | nothing recorded and nothing declared |
| `not_configured` | `DATABASE_URL` is unset |

A provider's point-in-time recovery, where available, remains the finer-grained
option. Production's database is Neon-managed PostgreSQL 17; how the owner checks
its restore window is in `docs/operations/offhost-backup-and-pitr.md`. `DATABASE_BACKUP_LAST_VERIFIED_AT` and `DATABASE_RESTORE_TESTED_AT` remain
the operator's statement about backups this process cannot see.

**Proved locally** by `services/api/test/pg-backup-restore-drill.integration.test.ts`
(2026-11-01; at PostgreSQL 17 on 2026-11-21). The test ran the real cycle, its
drill, and the off-host copy to a local MinIO. The source was a disposable
PostgreSQL 17 copy of the fully migrated schema, read with the pinned pg17 client.
The same file proves the refusal paths:
- a pg16 client against the PG17 server fails first, names both versions, writes
  nothing, and records `FAILED`;
- the free-space precheck refuses, for both the backup and the drill;
- the drill server runs with bounded WAL.

**Not proved:** that these services run on the production host, or that a real
off-host bucket exists. See `docs/operations/deployed-topology.md`.

**Measured against production on 2026-11-21** (by the operator, on the production
host):
- backup: 126 s, about 1.07 GB custom format, from about 3.4 GB of data;
- restore and verify: 120 s;
- amcheck: 22 s over 1952 indexes.

**Alerting.** A missing or failed backup is pushed by the outage watchdog (below),
for each kind of record on its own: `DATABASE_BACKUP_MISSING` (no success within
`OPS_WATCHDOG_BACKUP_STALE_HOURS`, default 13), `BACKUP_OFFHOST_COPY_MISSING`
(`OPS_WATCHDOG_OFFHOST_STALE_HOURS`, default 26) and `RESTORE_DRILL_MISSING`
(`OPS_WATCHDOG_DRILL_STALE_HOURS`, default 192), and whenever the newest record of
that kind FAILED. Until 2026-11-21 only `DATABASE_BACKUP` rows were read, so a
failed off-host copy or drill raised nothing. The release deploy also warns when the
`pg-backup` container is missing, and when it is restarting.

### Outage alerting — **[configured; the receiver is external]**

The production worker crash-looped for about 25 h and nothing alerted. Its schema
head was behind its build (`HEAD_NOT_APPLIED`), and it restarted 306 times.
Scheduled reconciliation stopped for about 25.7 h.

The API now runs an outage watchdog as a step of its 5-minute platform maintenance
sweep, under a lease, so one replica evaluates each tick
(`services/api/src/services/operations/outage-watchdog.service.ts`). It sends
through the existing `dispatchOpsAlert` path.

| Category | Fires when | Default |
|---|---|---|
| `WORKER_SCHEMA_HEAD_REFUSAL` | the worker recorded a schema-head refusal (kind + expected migration) in Redis before exiting | within 30 min |
| `WORKER_RESTART_LOOP` | N worker process starts (the worker's own boot records in Redis) within the window | 4 in 60 min |
| `WORKER_NOT_LIVE` | fewer live worker leases than expected. A fleet whose last instance stopped cleanly counts | 1 expected, 10 min grace |
| `QUEUE_BACKLOG_STALLED` | a work queue's oldest waiting job is older than the limit, or it holds more waiting jobs than the ceiling | 30 min / 1000 |
| `RECONCILIATION_RUNS_MISSING` | the newest worker-scheduled `governance_reconciliation_runs` row is older than the limit | 60 min |
| `DATABASE_BACKUP_MISSING` | no successful backup within the window, or the newest backup FAILED | 13 h |
| `BACKUP_OFFHOST_COPY_MISSING` | no successful off-host copy within the window, or the newest one FAILED | 26 h |
| `RESTORE_DRILL_MISSING` | no successful restore drill within the window, or the newest one FAILED | 192 h |
| `HOST_DISK_LOW` | a measured filesystem is more than the limit used, or has less free than the floor (CRITICAL at 95 % or under 1 GB) | 85 % / 4096 MB |
| `MONITORING_SOURCE_UNREADABLE` | a source above (Redis, worker leases, queues, reconciliation runs, backup records, disk) could not be read for longer than the hold | 10 min |

- An alert is sent when a signal starts, again every `OPS_WATCHDOG_REMINDER_MINUTES`
  (default 60) while it lasts, and once more as `Resolved:` when it clears. The
  watchdog keeps its state in Redis, so a replica that takes over does not
  re-announce an ongoing alert.
- **Unreadable is not healthy.** A signal whose source could not be read is carried
  forward: never resolved, never re-announced. The source itself alerts
  (`MONITORING_SOURCE_UNREADABLE`) once it stays unreadable past the hold.
- **Delivery.** A start, reminder or `Resolved:` notice the receiver does not accept
  is retried on the next tick, so a transient receiver failure loses nothing and a
  recovery is announced exactly once (a refused recovery is given up after 12
  ticks, logged as `ops_watchdog.resolve_abandoned`).
- **Disk.** The watchdog measures `OPS_WATCHDOG_DISK_PATHS` (default `/`) with
  `statfs`, as `df` computes the percentage. In the API container `/` is the
  overlay on Docker's data disk; on the production host that is the same disk as
  `/opt/proovra/backups/postgres` (check with `df -h /var/lib/docker
  /opt/proovra/backups/postgres`). `off` turns the detector off.
- Settings, all optional: `OPS_WATCHDOG_ENABLED` (`false` turns it off),
  `OPS_WATCHDOG_EXPECTED_WORKERS` (0 turns off the liveness detector),
  `OPS_WATCHDOG_BACKUP_EXPECTED` (`false` where backups are deliberately elsewhere;
  it turns off all three backup detectors), `OPS_WATCHDOG_OFFHOST_EXPECTED`,
  `OPS_WATCHDOG_DRILL_EXPECTED`, `OPS_WATCHDOG_DISK_PATHS`,
  `OPS_WATCHDOG_DISK_MAX_USED_PERCENT`, `OPS_WATCHDOG_DISK_MIN_FREE_MB`,
  `OPS_WATCHDOG_UNREADABLE_HOLD_MINUTES`, and the thresholds named in the service.
- **Dependency:** the only transport is a webhook, `OPS_ALERT_WEBHOOK_URL`, read by
  the API from `/opt/proovra/app/.env`. The body follows the receiver: a Discord
  webhook gets `content` (mentions disabled), a Slack webhook gets `text`, anything
  else the JSON envelope (`OPS_ALERT_WEBHOOK_FORMAT` overrides). If it is unset,
  alerts are not delivered. Each one is then logged at WARN as
  `ops_watchdog.alert_undelivered`.
- **Delivery proof.** Inside the running API container,
  `node dist/scripts/ops-alert-delivery-test.js` sends a labelled
  `[PROOVRA SYNTHETIC TEST] … no action needed` alert and its recovery through the
  watchdog's own transport. For Discord it creates each with `?wait=true` and reads
  it back with `GET /webhooks/<id>/<token>/messages/<id>`. It prints the host, the
  message ids and the statuses only.
- **Not covered:** an API, Docker or host that is itself down. The external uptime
  check below covers that.

### External uptime check — **[configured; needs one repository secret]**

`.github/workflows/uptime.yml` runs every 10 minutes on GitHub's runners, outside
the production host, and runs `scripts/ops/uptime-probe.mjs`:

| Probe | Passes when |
|---|---|
| `https://api.proovra.com/health` | 200 with `ok: true` and `db: "up"` |
| `https://api.proovra.com/readyz` | 200 (database, Redis and evidence storage ready) |
| `https://www.proovra.com/api/health` | 200 |

- Each probe gets 3 attempts, 20 s apart, so one blip does not page. Every
  attempt is logged and listed in the job summary: the HTTP status and the time,
  and for a non-200 attempt the `server`, `cf-mitigated` and `cf-ray` headers and
  the first 80 characters of the body (sanitized). A probe that passes only on a
  retry is visible, not hidden.
- Each run ends with exactly one outcome, printed as `uptime-outcome: <X>` in the
  log and the job summary, and as a notice annotation with that title, which the
  next run reads back:
  - `UP`: every probe passed and the alert destination is configured.
  - `DOWN`: a probe failed (annotation `PROOVRA down`).
  - `CONFIG_MISSING`: the repository secret `OPS_ALERT_WEBHOOK_URL` is not set
    (annotation `OPS_ALERT_WEBHOOK_URL missing`). The run fails so the gap is
    visible. A failing probe is still annotated `PROOVRA down` in the same run.
  - `NOTIFY_FAILED`: a message was due and the webhook refused it.
  - `SELFTEST`: a manual self-test (below). Later runs ignore it.
- Messages follow the previous run's outcome. Cancelled, timed-out and skipped
  runs have no outcome and are passed over (one was cancelled by a runner network
  fault during checkout), and so are self-tests:
  - previous `DOWN`: still failing, nothing; passing, one `RECOVERED`.
  - previous `UP`: failing, one `[PROOVRA UPTIME] DOWN`; passing, nothing.
  - previous `CONFIG_MISSING`: failing, `DOWN`; passing, one "Monitoring
    configured — production up" message that says it is **not** an outage
    recovery. Adding the secret never posts a false `RECOVERED`.
  - previous `NOTIFY_FAILED`, or unreadable: failing, `DOWN`; passing, nothing.
- **A red scheduled run is a monitor result, not a push and not an application
  regression.** Read its outcome line first. `CONFIG_MISSING` says nothing about
  production; the probe lines and the summary table do.
- **Self-test** (Actions, uptime, Run workflow, tick `selftest`): adds a probe of
  `https://api.proovra.com/__uptime_selftest_404` (a GET of a path that answers
  404) and posts `[TEST]`-labelled DOWN and RECOVERED messages to the configured
  webhook. Production is only read. The same logic is tested with no network in
  `services/api/test/ops-uptime-probe.test.ts`, where a local HTTP server stands
  in for the endpoints, the Actions API and the webhook.
- **Known (2026-11-22): www passes only on the 3rd attempt from GitHub's
  runners** in every sampled run, while both api probes pass on attempt 1. The
  probe step took 42-43 s: the two 20 s retry delays plus about 2-3 s in total.
  So attempts 1 and 2 are fast refusals, not timeouts. www is proxied by
  Cloudflare (`server: cloudflare`, `cf-ray`); api is not. The per-attempt lines
  now record the status and `cf-mitigated` of those refusals. If they show `403`
  with `cf-mitigated: challenge`, the owner adds the Cloudflare skip rule below;
  until then a real www outage looks the same as a challenge for 40 s.
  - Cloudflare dashboard, zone proovra.com, Security, WAF, Custom rules, Create
    rule. Name: `uptime probe: www /api/health`. Expression:
    `(http.host eq "www.proovra.com" and http.request.uri.path eq "/api/health" and http.request.method eq "GET")`.
    Action: Skip. Skip "All remaining custom rules", "All rate limiting rules",
    "All managed rules" and, where the plan offers it, "All Super Bot Fight Mode
    Rules". Place it first. `/api/health` returns only `ok`, a timestamp and the
    public revision.
  - If the zone uses the free plan's Bot Fight Mode, a WAF rule cannot skip it.
    Then either turn Bot Fight Mode off, or leave the challenge in place and
    accept that only api is probed without retries masking it.
  - Changing Cloudflare is an owner action. Afterwards, the next run's lines must
    show `attempt web-health #1: HTTP 200`.
- It runs only on a schedule or by hand, in its own concurrency group. It is never
  part of a push or pull request, so it cannot block a merge or another workflow.
- **Detects:** the host, Docker, Caddy, TLS, DNS or the API process being down or
  unreachable from the internet; the API answering but not ready (database, Redis,
  storage); the web front end down.
- **Does not detect:** worker, queue, reconciliation, backup or disk problems while
  the API is up (the in-process watchdog covers those); a backup's freshness (no
  public endpoint states it, by design); slow responses under 15 s; anything
  between two runs (GitHub may delay a scheduled run by several minutes).

### Signing keys — **[not in repo]**

The package signing key is a PEM mounted from
`/opt/proovra/app/services/worker/keys`. It is not in the database, so these
backups do not contain it. A key that is lost cannot seal new packages under its
identity; historical packages still verify from their registered public key. Keep an
offline copy under the owner's control. No such copy can be seen from the repository.

### Artifact regeneration — **[configured]**

- Signed reports and verification packages are **deterministic**
  artifacts re-derivable from immutable evidence + the stored manifest.
  They can be **regenerated** rather than restored. The reproducibility
  verifier lives at
  `services/api/src/services/operations/export-reproducibility.service.ts`
  (`POST /v1/operations/exports/:id/verify`).

### Full DR rehearsal / cross-region failover — **[not in repo]**

- Cross-region replication and failover are infrastructure-layer
  concerns exercised through the hosting provider's tooling. The
  application layer validates only what it can prove.

## Verifying a `pg-backup` dump: the isolated restore (exact procedure)

Use this to prove that a dump restores and serves, and to rehearse a restore.
Nothing in it can reach production:
- the network is `--internal`, so it has no route out;
- every credential is a throwaway;
- the evidence store is a throwaway MinIO bucket.

It was run on the production host on 2026-11-21. Restore and verify took 120 s, and
amcheck took 22 s over 1952 indexes. Run it from the repository checkout. Disk: about
3.5 GB with the WAL bounds below, against about 5.6 GB with defaults.

```bash
IMG=pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd
DUMP=$(ls -1 /opt/proovra/backups/postgres/proovra-*.dump | sort | tail -n 1)
PW=$(openssl rand -hex 16)          # throwaway; never a production credential

# 1. An isolated, internal network (no egress) and a PG17 server with bounded WAL.
docker network create --internal proovra-restore
docker run -d --name proovra-restore-pg --network proovra-restore \
  -e POSTGRES_USER=restore -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=postgres \
  "$IMG" -c max_wal_size=256MB -c min_wal_size=80MB
until docker exec proovra-restore-pg pg_isready -U restore >/dev/null 2>&1; do sleep 1; done

# 2. Restore and verify (checksum, exact row counts, schema fingerprint), keeping the database.
docker run --rm --network proovra-restore \
  -v /opt/proovra/backups/postgres:/backups:ro -v "$PWD/scripts/ops:/ops:ro" \
  -e BACKUP_FILE="/backups/$(basename "$DUMP")" \
  -e DRILL_ADMIN_URL="postgresql://restore:$PW@proovra-restore-pg:5432/postgres" \
  -e DRILL_KEEP=1 \
  "$IMG" bash /ops/pg-restore-drill.sh
#   → "pg-restore-drill: DRILL_KEEP=1 — the restored database is kept as proovra_restore_drill_…"
#   → "pg-restore-drill: PASS — …"
DB=$(docker exec proovra-restore-pg psql -U restore -d postgres -A -t -c \
  "SELECT datname FROM pg_database WHERE datname LIKE 'proovra_restore_drill_%' ORDER BY datname DESC LIMIT 1")

# 3. B-tree structure check of every valid index (amcheck).
docker exec proovra-restore-pg psql -U restore -d "$DB" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS amcheck" \
  -c "SELECT count(*) AS indexes_checked FROM (SELECT bt_index_check(c.oid) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam WHERE am.amname = 'btree' AND i.indisvalid AND c.relpersistence <> 't') s"

# 4. An isolated API smoke against the restored database: dummy configuration,
#    a throwaway Redis and a throwaway MinIO with an Object-Lock bucket.
docker run -d --name proovra-restore-redis --network proovra-restore redis:7-alpine
docker run -d --name proovra-restore-minio --network proovra-restore \
  -e MINIO_ROOT_USER=restore -e MINIO_ROOT_PASSWORD="$PW" \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
docker run --rm --network proovra-restore --entrypoint /bin/sh pgsty/mc:RELEASE.2026-09-16T00-00-00Z -c \
  "mc alias set r http://proovra-restore-minio:9000 restore $PW && mc mb --with-lock r/restore-smoke"
docker run -d --name proovra-restore-api --network proovra-restore \
  -e NODE_ENV=development -e PROOVRA_TEST_STACK=1 -e EMAIL_TRANSPORT=recording -e PORT=8080 \
  -e DATABASE_URL="postgresql://restore:$PW@proovra-restore-pg:5432/$DB" \
  -e REDIS_URL=redis://proovra-restore-redis:6379 \
  -e S3_ENDPOINT=http://proovra-restore-minio:9000 -e S3_REGION=us-east-1 -e S3_FORCE_PATH_STYLE=true \
  -e S3_ACCESS_KEY=restore -e S3_SECRET_KEY="$PW" -e S3_BUCKET=restore-smoke -e S3_ALLOW_INSECURE=true \
  -e AUTH_JWT_SECRET="$(openssl rand -hex 32)" -e IDENTITY_SECURITY_HASH_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/<owner>/proovra-api:<the running sha tag>
docker exec proovra-restore-api wget -qO- http://localhost:8080/readyz   # expect ready

# 5. Remove everything (the dump itself is untouched).
docker rm -f proovra-restore-api proovra-restore-minio proovra-restore-redis proovra-restore-pg
docker network rm proovra-restore
```

**Limitation.** `pg_restore` recreates the `vector` extension at the version the
image provides: 0.8.7 in the pinned pg17 image, against 0.8.0 on production. Check
it with `SELECT extversion FROM pg_extension WHERE extname = 'vector'`. Restoring
into a managed server gives that server's version. Row counts, the schema
fingerprint and amcheck do not depend on it.

### The same, scripted, with an authenticated smoke

`scripts/ops/pg-restore-drill-smoke.sh` runs steps 1, 2, 4 and 5 above and then
signs in. A synthetic user is inserted into the restored copy only. It signs in
through `POST /v1/auth/email/login`, `/v1/auth/me` answers 200 for that user, and
401 without a session and with a tampered token.

```bash
API_IMAGE=ghcr.io/<owner>/proovra-api:<the running sha tag> \
  bash scripts/ops/pg-restore-drill-smoke.sh          # newest dump by default
bash scripts/ops/pg-restore-drill-smoke.sh cleanup    # leftovers of an interrupted run
```

- Every resource is named `proovra-drill2-<role>-<run>` and labelled
  `proovra.drill2=1`. The run removes exactly its own resources when it exits.
  `cleanup` removes only resources that carry both the prefix and the label.
- It refuses to start the API unless the API's `DATABASE_URL` names this run's
  drill container. It checks this before the start and in the started container. A
  `DATABASE_URL` or `DIRECT_URL` in the shell that names another server is refused.
- The API gets dummy configuration only (no `--env-file`, `PROOVRA_TEST_STACK=1`,
  recording email, its maintenance sweep and watchdog off). `/health` must report the
  isolation facts: no env file, no live credential name.
- Bounds: memory 768m (database), 768m (API), 256m (MinIO), 64m (Redis); 1 CPU each.
  It checks first that Docker's data root has 4 × the dump plus 2 GB free.

### Proving the off-host copy restores

```bash
C="docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml --profile backup"
$C run --rm --no-deps --entrypoint bash pg-backup-offhost /ops/pg-backup-offhost-verify.sh fetch
$C run --rm --no-deps --entrypoint bash pg-backup /ops/pg-backup-offhost-verify.sh drill
```

- `fetch` (aws-cli image) downloads the newest off-host dump and its artifacts into
  `/opt/proovra/backups/postgres/.offhost-verify`. It requires the SHA-256 to match
  the uploaded `.sha256`, and the local `.sha256` while the dump is still retained.
- `drill` (pg17 image) checks the SHA-256 again and against
  `platform_backup_records` (a read-only SELECT). It restores the retrieved copy in
  a throwaway server and requires exact counts and schema. It then removes the
  scratch directory.
- Disk: the dump plus the drill's about 3.5 GB.

## Restore procedure

The safe-migration and preflight scripts referenced below already
exist in `services/api/scripts/`.

1. **Provision the database from the managed-platform backup**, or from the newest
   verified `pg-backup` dump: restore with `pg_restore --no-owner --no-privileges`,
   using the pinned pg17 image. Rehearse it with the isolated restore above first.
   Use the hosting provider's restore facility to bring up a database
   at the desired recovery point. *(Managed platform — outside this
   repo.)*

2. **Preflight the restored database.**
   ```bash
   node services/api/scripts/db-preflight.mjs
   ```
   Confirms connectivity and basic invariants before any migration is
   applied.

3. **Check for schema drift.**
   ```bash
   node services/api/scripts/drift-check.mjs
   ```
   Compares the live schema against the expected catalog
   (`services/api/src/runtime/schema-validation.ts`).

4. **Apply migrations forward safely.**
   ```bash
   node services/api/scripts/safe-migrate.mjs
   ```
   (or `deploy-safe.mjs` for the full deploy-guarded path). Do **not**
   hand-edit the schema.

5. **Confirm runtime readiness.**
   Hit `GET /v1/admin/runtime/readiness` and `GET /v1/admin/runtime/schema-status`,
   or view `/operations/readiness`. All load-bearing subsystems should
   report `HEALTHY`; `DEGRADED`/`CRITICAL` items carry remediation
   hints.

6. **Verify evidence integrity + regenerate artifacts.**
   Object Lock status should read `verified`. Regenerate any reports /
   verification packages as needed and run the reproducibility verifier
   to confirm the manifest still matches.

## Verification checklist

- [ ] Managed-platform database restore completed to the target RPO.
- [ ] `db-preflight.mjs` passed.
- [ ] `drift-check.mjs` shows no unexpected drift.
- [ ] `safe-migrate.mjs` applied cleanly.
- [ ] `/operations/readiness` runtime status is HEALTHY (or degraded
      items understood).
- [ ] Object Lock status reads `verified`.
- [ ] A sample report / verification package regenerates and verifies.

## What this document does NOT claim

- No uptime percentage or SLA.
- No SOC 2 / ISO 27001 certification.
- No penetration-test pass.
- No guarantee of a specific RPO/RTO — only the configured/assumed
  posture above.
