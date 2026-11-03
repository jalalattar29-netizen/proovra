# Capacity measurements (2026-11-03)

**This document does not establish production capacity.** It reports what one
developer workstation measured on a synthetic, labelled dataset, which paths
failed first there, and what was repaired. No figure here is a supported number of
users, workspaces or requests, and none may be quoted as one. The last section lists
the steps that would establish production capacity.

## 1. What was measured, and where

| | |
|---|---|
| Machine | AMD Ryzen 9 8940HX (16 cores, 32 threads), 31.2 GB RAM, one NVMe SSD, Windows 11 |
| Container runtime | Docker Desktop 29.8 on WSL2, 32 CPUs and 15.2 GiB visible to the VM |
| Database | `pgvector/pgvector:pg16`, one container, `shared_buffers=2GB`, `synchronous_commit=off`, `max_wal_size=8GB`, `dynamic_shared_memory_type=mmap`, `pg_stat_statements` and `auto_explain` loaded. Everything else at the image's defaults (`work_mem` 4 MB, `max_connections` 100) |
| API | the built API (`dist`), one Node 20.20.2 process, Prisma 7.4.2 over `pg` with the default pool (`new Pool({ connectionString })`, at most 10 connections) |
| Stack | `e2e/acceptance/stack.mjs`, environment from the allowlist builder. `/health` proved `isolated: true`, `envFilesLoaded: 0`, no live credential names, for the API and for a live worker, before each measurement series. Nothing was pointed at any non-loopback host |
| Noise | other agents' isolated stacks ran on the same machine: about 12 containers during the baseline, about 24 during the after-run. Numbers below therefore carry a few hundred milliseconds of noise and a repeat of one series (the operations sweep, unchanged code) moved from 582 s to 272 s |

`synchronous_commit=off` makes writes cheaper than on a durable production database,
and the database, API and load generator share one machine, so neither network latency
nor a separate database host is in any figure.

## 2. The dataset

`e2e/acceptance/capacity/seed.ts` builds it with set-based SQL (millions of rows
through the application write path would measure the seeder). Every row is
labelled: organizations and workspaces `CAPACITY-FIXTURE ...`, people
`capacity-*@fixture.local`, evidence in the bucket `capacity-fixture`, payloads
`"fixture":"capacity"`. The four personas are created the way `seed-admin-fixture.ts`
creates its accounts (real password hasher, legal acceptance) and sign in through the
real login route.

Shape (an assumption, not a measurement of production's distribution): one anchor
tenant with eight workspaces, the deepest holding 300,000 records and 1,500 members;
40 large tenants of three workspaces with 7,000 records each; 500 mid tenants with 800
records; 4,000 personal accounts with 30 records; every person with a personal space.

| table | rows | size |
|---|---:|---:|
| custody_events | 10,282,372 | 7.4 GB |
| evidence | 1,870,384 | 3.0 GB |
| admin_audit_logs | 3,499,419 | 2.3 GB |
| evidence_parts | 2,618,637 | 1.4 GB |
| evidence_search_documents | 1,869,576 | 1.3 GB |
| organization_audit_events | 2,697,847 | 0.8 GB |
| notification_deliveries | 1,809,579 | 0.6 GB |
| report_generation_requests | 1,088,795 (2,852 queued) | 0.6 GB |
| case_evidence_links / reports / verification_packages | about 1.05 M to 1.09 M each | 0.4 GB each |
| cases | 202,500 | 69 MB |
| team_members / teams / users | 52,600 / 23,428 / 22,800 | |

Total 20 GB. One fixture adjustment: the fixture workspaces carry a storage override
so the upload path is not stopped by the quota gate it is measuring. It is a fixture
row, not a plan figure; no business limit, quota or seat figure was changed.

## 3. Method

- `e2e/acceptance/capacity/profile.mjs` (plain mode): per route, one warm-up request,
  then one request between two `pg_stat_statements` resets (statement count, rows,
  shared blocks, slowest statements), then 10 sequential samples for p50 and p95.
- `--explain`: `auto_explain` with `log_analyze` and `log_buffers` on, one request per
  route, plans over 150 ms cut from the server log. A separate pass, so its overhead is
  not in the latency figures.
- `--concurrency=1,5,10,20`: a mixed read workload (command center, library list and
  summary, case list, org members, audit log, inbox summary) for 30 s per level, with
  `pg_stat_activity` sampled every 500 ms.
- `--upload`: 20 times, create a record, open a session, initiate multipart, presign,
  PUT 5 MiB to the fixture MinIO, mark the part uploaded.
- `e2e/acceptance/capacity/sweeps.ts`: calls the functions the worker timers and the
  API cron routes call, one at a time, between statement resets.
- Before and after ran on the same data: the seeded database was snapshotted with
  `CREATE DATABASE ... TEMPLATE`, restored before the after-run, and the new migrations
  applied with `prisma migrate deploy` (`stack.mjs migrate`). The API's in-process
  sweeps were switched off for route attribution (`ACCEPTANCE_QUIET_SWEEPS=1`); the
  sweeps were measured on their own.

Raw output (git-ignored): `.p7tmp/capacity/` (`before*.json`, `after*.json`,
`plans-before/`, `plans-after/`).

## 4. Results

### Routes, persona: owner of the 300,000-record workspace (milliseconds)

| route | p50 before | p95 before | p50 after | p95 after | statements before / after | DB ms before / after |
|---|---:|---:|---:|---:|---|---|
| command center (owner) | 7038 | 8092 | 2327 | 2546 | 217 / 219 | 28590 / 11956 |
| command center (member) | 7094 | 7928 | 2388 | 3546 | 217 / 219 | 25383 / 11995 |
| command center (7,000-record tenant) | 898 | 1017 | 303 | 445 | 220 / 219 | 2231 / 858 |
| trust summary | 1952 | 2374 | 2887 | 3389 | 71 / 74 | 9644 / 6672 |
| library list, one workspace | 3930 | 4299 | 518 | 548 | 207 / 209 | 3654 / 297 |
| library list, all workspaces | 5976 | 12820 | 918 | 1025 | 206 / 208 | 5784 / 678 |
| library list, filtered | 6279 | 10302 | 504 | 590 | 207 / 209 | 5431 / 275 |
| library list, member | 4067 | 4893 | 520 | 574 | 207 / 209 | 4487 / 284 |
| library summary | 5497 | 6451 | 3253 | 3534 | 210 / 211 | 21205 / 6921 |
| library search, common word | 4381 | 4787 | 507 | 525 | 212 / 214 | 3989 / 266 |
| library search, no match | 3098 | 3413 | 821 | 869 | 212 / 213 | 2965 / 574 |
| unified search | 1711 | 1877 | 353 | 414 | 64 / 64 | 1551 / 302 |
| case list | 269 | 306 | 263 | 303 | 205 / 205 | 44 / 75 |
| matter queue | 354 | 374 | 339 | 416 | 512 / 512 | 41 / 42 |
| workspace members | 61 | 67 | 57 | 74 | 53 / 53 | 2 / 2 |
| organization members | 57 | 76 | 52 | 69 | 24 / 24 | 6 / 4 |
| organization audit log | 28 | 33 | 26 | 36 | 24 / 24 | 1 / 1 |
| organization admin detail | 30 | 38 | 32 | 42 | 26 / 26 | 4 / 4 |
| organization workspaces | 1072 | 1216 | 120 | 154 | 249 / 177 | 7356 / 1206 |
| organization billing rollup | 2133 | 2176 | 181 | 190 | 263 / 191 | 4145 / 24 |
| inbox | 1964 | 2201 | 1842 | 1947 | 240 / 240 | 1680 / 1591 |
| inbox summary | 23 | 26 | 25 | 29 | 20 / 20 | 0 / 0 |
| notification deliveries | 59 | 73 | 63 | 78 | 55 / 55 | 1 / 2 |
| reviewer queue | 932 | 1010 | 69 | 79 | 77 / 68 | 1868 / 3 |

The trust summary's database time fell, but its p50 rose; the plan now runs its
counts as sequential scans of the evidence table instead of the per-row probe, and the
after-run carried twice the background load. It is listed as not improved.

The platform admin overview was not measured: the fixture operator needs an
authenticator enrolment, and no route figure for it is claimed.

### Upload path (p50 / p95 ms, 20 runs, the deep workspace)

| step | before | after |
|---|---|---|
| create the record | 1955 / 2964 | 917 / 1025 |
| open the session | 77 / 144 | 64 / 84 |
| initiate multipart | 81 / 132 | 60 / 70 |
| presign a part | 61 / 91 | 53 / 67 |
| mark the part uploaded | 62 / 86 | 52 / 67 |

The part path itself is flat with workspace size. Record creation runs the storage
quota check, which sums evidence, report and package bytes over the whole workspace on
each create; that is the remaining 0.9 s.

### Concurrency (mixed reads, 30 s per level)

| clients | before: req/s, p50, p95 (ms) | after: req/s, p50, p95 (ms) | lock waiters seen before / after |
|---:|---|---|---|
| 1 | 0.3, 3997, 7709 | 0.7, 780, 3499 | 0 / 0 |
| 5 | 0.9, 5501, 12187 | 2.6, 594, 5627 | 0 / 0 |
| 10 | 1.0, 6147, 25365 | 2.9, 1566, 8769 | 0 / 0 |
| 20 | 0.6, 39303, 65713 | 2.1, 7031, 20026 | 9 / 0 |

Throughput stops rising at about 5 clients and falls by 20, in both runs. The API's
pool holds at most 10 connections and one command center request fans out to more
than 10 parallel queries, so a handful of dashboard loads occupy the pool. These are
this machine's numbers for a mix of the heaviest reads, not a user count.

### Sweeps (one tick)

| sweep | before | after |
|---|---|---|
| archive tier transition (628 workspaces) | 699 s, 194,591 statements | 6.1 s, 1,258 statements |
| workspace operations sweep (200 of 23,428 workspaces) | 582 s, 254,126 statements | 272 s, 254,144 statements (code unchanged; the difference is load) |
| operations coverage query | 5.8 s | 0.2 s (cache) |
| retention, trash grace, archive restore, stranded report requests | under 1.5 s each | under 0.6 s each |
| notification retries, reminders, digests, communication retries, lifecycle tick | under 0.5 s each | under 0.1 s each |

The report queue has 2,852 queued requests in the fixture; the stranded-request
reconciler reads them in 0.5 to 1.4 s. The queue's claim is a single-row update by id
and was not a bottleneck here.

## 5. What was repaired, and why

Each change keeps the same results; the tests below were run.

1. **Library list, search, filters, bulk actions and duplicates** — the list select's
   `_count` of original parts compiled to a join on a `GROUP BY` over the whole
   `evidence_parts` table: a sequential scan of 2.6 M parts, with temp files, to count
   the parts of fifty records. The count is now one grouped query over the page's ids
   (`withOriginalPartCounts`, `services/api/src/routes/evidence.routes.ts`).
2. **The restricted-case narrowing** — "no link to a restricted case the caller cannot
   see" was evaluated once per record (1.7 s for 300,000 records with no restricted case
   at all). It is now resolved from the links whose case is restricted and closed to
   the caller, the same predicate driven from the other end, and applied as an id list,
   or as the old relation filter above 2,000 ids
   (`services/api/src/services/access/record-reach.ts`). Used by the library list and
   summary, the workspace reach every dashboard engine shares, the trust summary and
   search reach.
3. **Commercial context** — resolving a workspace's commercial context computed the
   whole usage rollup, six byte aggregates, and used only the seat figures. It now reads
   seats through one seat reader that the usage rollup also uses
   (`getWorkspaceSeatUsage`). This is what the reviewer queue, the organization
   workspace list (once per workspace) and record creation were paying for.
4. **Tier sweep** — per workspace it read 400 records in no order, every completed
   transition ever recorded, then each candidate again by id; a workspace whose first
   400 rows were already tiered never had the rest looked at. One ordered statement now
   selects the due records (latest completed known tier, age past its threshold, oldest
   first) with their sealed version (`services/worker/src/governance/archive-tier-auto-transition.worker.ts`).
   A new integration test (a due record behind 401 that are not due) fails on the old
   sweep and passes on the new.
5. **Three indexes**, each its own single-statement migration built `CONCURRENTLY`
   (`20281111000000`, `000100`, `000200`; rows in `docs/architecture/migration-deployment-plan.md`):
   `evidence (team_id, status, updated_at DESC)` for the command center's
   signed-not-timestamped and signed-without-package lists (3.2 s and 3.0 s sequential
   scans); a partial `evidence (team_id, verification_disclosure_changed_at_utc DESC)`
   for recent disclosure changes (3.9 s); `case_evidence_links (team_id, evidence_id)`
   for records in more than one case (3.4 to 4.4 s, 0.36 s with the index). Build cost
   on the fixture: 76 s and 84 MB, 4 s and 8 kB, 9 s and 50 MB. Each is one more index
   to maintain on every write of its table; `evidence` already carries 54.

## 6. Measured and not repaired

These are where this dataset failed first after the repairs. Each needs a decision or
a larger change than a bounded, same-result repair.

- **Workspace operations sweep (API, in process, shares the request pool).** One tick
  reconciles at most 200 workspaces at about 1,270 statements each (1.4 to 2.9 s per
  workspace here); the fixture has 23,428 workspaces, so one pass takes about 117 ticks,
  about 29 hours at the 15-minute interval, against a 45-minute freshness contract. Its
  largest costs are audit inserts (6,561 per tick) each taking a transaction-scoped
  advisory lock, and about 90 incident counts per workspace. Whether personal spaces
  need this sweep, and whether the audit chain can be partitioned, are owner decisions.
- **Audit chain lock.** Every `admin_audit_logs` insert serialises on
  `pg_advisory_xact_lock`. At 20 clients before the repairs 9 sessions waited on locks.
  It is the platform's tamper-evidence design; changing it is not a performance tweak.
- **Policy evaluation writes on reads.** Every authenticated read by a person in nine
  workspaces evaluates the session against each organization workspace in sequence
  (about 150 of a request's 200 statements, about 200 ms) and writes one
  `governance_policy_audits` row per workspace. A list request is therefore nine
  inserts. Recording evaluations is deliberate; whether it should be sampled is a
  decision.
- **Command center (2.3 s) and library summary (3.3 s).** About 30 whole-workspace
  aggregates per load. Report and package counts join through `evidence` because those
  tables carry no workspace column, so they hash-join whole tables. Bounded only by a
  maintained projection or a denormalised workspace column.
- **Record creation (0.9 s)** sums the workspace's stored bytes on every create.
- **Library search without a match (0.8 s)** is `ILIKE` over three columns with no
  trigram index; it grows linearly with the workspace. A trigram index would add three
  more indexes to `evidence`.
- **Inbox (1.8 s)** two evidence reads per load; not analysed further.
- **Organization members** returns every member in one response (1,500 members,
  556 kB); it is an unbounded read and needs pagination in the API and the page.
- **Connection pool.** Fixed at the `pg` default of 10 with no setting; the right size
  depends on the production database's connection limit and pooler, which are unknown.
- **The case-reach lookup** introduced in section 5 scans `cases` once per call
  (about 270 ms on 202,500 cases) because the restricted test is an OR over three
  sources. Cheaper than what it replaced; a candidate for a partial index once
  restricted cases exist in volume.

## 7. Limits of this method

- One machine runs database, API, MinIO and the load generator; no network hop and no
  managed-database limits (connection caps, IOPS, burst credits, pooler behaviour).
- `synchronous_commit=off` and a 2 GB buffer cache on a 20 GB database are local
  choices; production's settings are unknown (`docs/operations/deployed-topology.md`
  records the database provider as contradictory and unverified).
- The data distribution, record sizes and per-tenant activity are assumptions. Only
  one tenant is deep; real skew may be different.
- One API process and no worker during route timing; production runs workers and the
  in-process sweeps at the same time as requests.
- Other agents' containers shared the CPU and disk; repeat runs varied by up to 2x on
  the sweeps.
- Storage, PDF signing, TSA, OpenTimestamps and email providers were not exercised; the
  tier sweep stopped before storage because the fixture has no stored object versions.
- Latency is measured at the API, not in a browser.

## 8. What would establish production capacity

1. Fix the environment: a staging database of the same provider, plan, version,
   configuration and connection limit as production, behind the same pooler; API and
   worker images at production replica counts and memory; the same Redis and storage
   classes. Record each value.
2. Load a dataset shaped from production's own distribution (counts per tenant,
   records per workspace, custody events per record, audit volume per day), taken from
   read-only aggregate queries against production by the owner, scaled to the target
   horizon, with this seeder or a restore of a masked copy.
3. Run the workers and in-process sweeps at production intervals during every test.
4. Drive load from a separate host in the same region, through the real ingress, with
   a scenario mix derived from production request logs (route shares and think time),
   not this document's heaviest-reads mix.
5. Step concurrency until an objective is broken (for example p95 per route and error
   rate), hold each step long enough to cover a sweep interval, and record database CPU,
   I/O, connection waits, lock waits, pool waits and replication lag at each step.
6. Repeat three times on fresh restores and report the spread; state the objective, the
   step at which it broke and which resource broke first.
7. Repeat after each release that touches a measured path.

Until that is done, production capacity is unestablished.

## 9. Reproduce

```
node e2e/acceptance/stack.mjs infra-up
node e2e/acceptance/stack.mjs migrate
node e2e/acceptance/stack.mjs tsx ../../e2e/acceptance/capacity/seed.ts        # about 45 min here
node e2e/acceptance/stack.mjs build-api && node e2e/acceptance/stack.mjs build-worker
ACCEPTANCE_QUIET_SWEEPS=1 node e2e/acceptance/stack.mjs api                      # separate terminal
node e2e/acceptance/stack.mjs isolation                                          # with a worker running
node e2e/acceptance/capacity/profile.mjs --label=run --samples=10
node e2e/acceptance/capacity/profile.mjs --label=run --explain --min-ms=150
node e2e/acceptance/capacity/profile.mjs --label=run --concurrency=1,5,10,20 --duration-ms=30000
node e2e/acceptance/capacity/profile.mjs --label=run --upload --samples=20
node e2e/acceptance/stack.mjs tsx ../../e2e/acceptance/capacity/sweeps.ts --label=run
node e2e/acceptance/stack.mjs infra-down
```

The Postgres settings in section 1 were applied with `ALTER SYSTEM` and a container
restart; `infra-up` alone starts with the image defaults.
