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
| trust summary (change reverted, see 5a) | 1952 | 2374 | 2887 | 3389 | 71 / 74 | 9644 / 6672 |
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
   summary, the workspace reach every dashboard engine shares, search reach and the
   matter queue. **Not** used by the trust summary: see section 4a.
3. **Commercial context** — resolving a workspace's commercial context computed the
   whole usage rollup, six byte aggregates, and used only the seat figures. It now reads
   seats through one seat reader that the usage rollup also uses
   (`getWorkspaceSeatUsage`). This is what the reviewer queue, the organization
   workspace list (once per workspace) and record creation were paying for.
4. **Tier sweep** — per workspace it read 400 records in no order, every completed
   transition ever recorded, then each candidate again by id; a workspace whose first
   400 rows were already tiered never had the rest looked at. One ordered statement now
   selects the due records (latest completed known tier, age past its threshold, oldest
   first) with their sealed version. After merging with the integration branch's
   rewrite of the same sweep, it keeps that branch's guarantees (every team with a due
   record is visited each tick; per team a cap of 100 transitions and 400 attempts; a
   failed tag waits a day) and each page is one statement that reads only DUE records,
   skipping recent failures, with at most 5 pages per team
   (`services/worker/src/governance/archive-tier-auto-transition.worker.ts`).
   Integration tests from both sides pass, including "a due record behind 401 that are
   not due" (fails on the original sweep) and "a due record behind more than a page of
   finished ones". On the re-seeded fixture one tick took 9.2 s and 1,258 statements.
5. **Three indexes**, each its own single-statement migration built `CONCURRENTLY`
   (`20281111000000`, `000100`, `000200`; rows in `docs/architecture/migration-deployment-plan.md`):
   `evidence (team_id, status, updated_at DESC)` for the command center's
   signed-not-timestamped and signed-without-package lists (3.2 s and 3.0 s sequential
   scans); a partial `evidence (team_id, verification_disclosure_changed_at_utc DESC)`
   for recent disclosure changes (3.9 s); `case_evidence_links (team_id, evidence_id)`
   for records in more than one case (3.4 to 4.4 s, 0.36 s with the index). Build cost
   on the fixture: 76 s and 84 MB, 4 s and 8 kB, 9 s and 50 MB. Each is one more index
   to maintain on every write of its table; `evidence` already carries 54.

6. **Connection pool ceiling (CAP-9)** — `DATABASE_POOL_MAX` sets the API's and the
   worker's pool. Unset keeps the `pg` default of 10, so nothing changes until someone
   sets it; a value outside 1 to 500 stops the process. No production value is chosen
   here (`services/api/.env.example`, `services/worker/.env.example`).
7. **Organization members (CAP-10)** — `GET /v1/orgs/:id/members` returned every
   membership: 1,500 rows, 556 kB. It now pages like the workspace roster (`limit`
   default 50, at most 200; a `cursor` that must belong to the same organization;
   `q`), with whole-organization counts by role and status on every page. The members
   tab appends with Load more; the admin overview, organization page and setup wizard
   read their totals from the counts. The full roster stays at
   `GET /v1/orgs/:id/reports/members.csv`. Measured: p50 57 ms and 556 kB, then 29 ms
   and 18.7 kB.
8. **Matter queue** — each case's visible linked records were read separately (50 reads
   per page, each with the restricted-case predicate). One reach lookup and one lateral
   statement now read them for the page, with the same 500-per-case bound. Measured:
   p50 354 ms and 512 statements, then 203 ms and 464; the rest are seven per-case
   counters that were not batched.

### 5a. Second round: what was reverted, and what the pool setting showed

These ran on a re-seeded fixture (the same deterministic seed, rebuilt after the first
stack was removed), so compare within this section, not with section 4.

- **Trust summary, reverted.** Back to back on the same data, 20 samples each: with the
  narrowing resolved once, p50 2,648 ms (database 7.1 s); with the per-count predicate,
  p50 1,860 ms (database 8.2 s). The resolved form spends about 300 ms on the reach
  lookup before any count can start, and without the per-row predicate the planner ran
  the largest count (records with both a report and a package) with no parallel
  workers: 2.3 s against 1.3 s with three. The per-count predicate is restored for this
  surface only; after the revert p50 was 1,889 ms.
- **Pool ceiling, 10 against 20, same mix, 30 s per level** (this machine only; the
  database here had idle CPU and no connection cap):

  | clients | pool 10: req/s, p50, p95 (ms) | pool 20: req/s, p50, p95 (ms) |
  |---:|---|---|
  | 5 | 2.5, 1058, 5988 | 3.0, 758, 5839 |
  | 10 | 2.5, 2607, 10237 | 3.7, 1176, 7139 |
  | 20 | 2.0, 7955, 17801 | 4.5, 2175, 11922 |

  Connections held at the database rose from 17 to 27. This shows the setting works and
  that this workload was pool-bound here. It does not say what production should use,
  which depends on the database's connection limit and CPU, the pooler, and how many API
  and worker replicas share them.

## 6. Measured and not repaired

These are where this dataset failed first after the repairs. Each needs a decision or
a larger change than a bounded, same-result repair.

- **Workspace operations sweep (CAP-6): repaired in part, contract not met at
  23,428 workspaces in one API process.** Before: one tick reconciled at most 200
  workspaces sequentially at about 1,100 statements each (222.6 s for a tick of 200
  never-run workspaces, of which 20.4 s was database time). Incident gauges alone were
  26,898 statements and 13.1 s of that tick. The cap of 800 workspaces an hour put any
  deployment over about 600 workspaces outside the 45-minute contract, permanently.

  Repaired (`workspace-operations-reconciliation.job.ts`, `incident.service.ts`):
  a scheduler tick now selects every due workspace (oldest first, same ranking) and
  stops starting new ones once 80% of the interval is spent, so the backlog shrinks
  every tick instead of being cut at 200. Workspaces can run in parallel
  (`OPERATIONS_RECONCILER_CONCURRENCY`, default 1, at most 4), each still claimed
  through the one run authority. Overlapping timer ticks are skipped. Incident gauges
  refresh at most every 15 s instead of on every incident write (808 statements per
  workspace in steady state).

  Measured on the fixture (Postgres 16 in Docker, documented settings, 32 cores; the
  harness drives the scheduler entry point, `trigger: scheduler`, ticks back to back
  with a 720 s budget):

  | | sequential (before) | concurrency 1 (after) | concurrency 4 (after) |
  |---|---|---|---|
  | workspaces per second, steady state | about 0.9 | 1.31 | 5.35 (16 ticks, 3,718 to 4,654 per tick) |
  | first pass over 23,428 never-run workspaces | about 29 h at the interval | about 5 h | 87 min (ticks 0 to 6, no failures) |
  | full pass in steady state | about 7 h | about 5 h | about 73 min; oldest picture 71 min |
  | largest workspaces | | 14 to 27 s each (7 of 200) | |

  **Why the contract is still not met here, and what would meet it.** The limit is not
  the database (Postgres used 0.7 of a core). It is one JavaScript thread: at
  concurrency 4 the main thread of the process measured 0.91 of a core and the other
  15 threads 0.03 or less, about 170 ms of CPU per workspace. One process therefore
  tops out near 5.4 workspaces a second. In production the timer gives the sweep 12 of
  every 15 minutes, so one process holds about 11,500 workspaces at concurrency 4 and
  about 2,800 at concurrency 1 inside 45 minutes. The fixture needs 10.8 a second. The
  default stays 1 because the sweep shares the API event loop: 4 would take most of
  it for 12 of every 15 minutes whenever there is a backlog. Meeting the contract at
  this size needs one of: a process that runs only the sweep (the API image with
  `OPERATIONS_RECONCILER_ENABLED` on there and off on the request-serving API), or
  fewer statements per workspace (the audit inserts and incident counts above). Each
  is a deployment or design decision, not a bounded repair. The production workspace
  count and the database round-trip time there (CAP-9) decide whether either is needed.
  The coverage metric (`due`, oldest picture) reports the gap rather than hiding it.
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
  tables carry no workspace column, so they hash-join whole tables (1.4 s and 1.5 s on
  the anchor workspace). No same-result rewrite without a schema change was found that
  measured faster; the options are a maintained projection or a workspace column.
- **Recent custody for the timeline projection: index measured and not added.** "Custody
  events of this workspace since a date, newest 200" (`projectWorkspaceTimeline`) runs
  only when a workspace's timeline projection is empty, so once per workspace on its
  first command center load, not on every load. No existing index leads with `at_utc`;
  `custody_events (evidence_id, at_utc)` serves it for small and mid workspaces. An index
  on `custody_events (at_utc DESC)`, built concurrently on the third fixture (15 s,
  208 MB), measured by the query's own plan, three runs each:

  | workspace | without the index (cold, warm) | with it (cold, warm) |
  |---|---|---|
  | anchor, 300,000 records | 4,162 ms, 969 ms (sequential scan, 510,000 blocks read) | 44 ms, 5 ms |
  | large, 7,000 records | 683 ms, 71 to 93 ms (team index, then evidence_id/at_utc) | 2,647 ms, 293 to 305 ms (walks the new index across all workspaces) |
  | mid, 800 records | 196 ms, 6 ms | 6 ms, 6 to 10 ms (same plan as without) |

  The command center's p50 did not move with or without it (anchor 2,071 and 2,068 ms;
  7,000-record workspace 285 and 276 ms), because the projection had already run. The
  index would make the deepest workspace's first load fast and the large tenants' first
  load slower, and adds an index to every custody append, the platform's busiest
  append-only table. It is therefore not added. The migration, schema entry and gate
  entries are kept as a patch outside the tree; a projection that is built ahead of the
  first load, or a bounded window per workspace, would remove the need for either.
- **Record creation (0.9 s)** sums the workspace's stored bytes on every create.
- **Library search without a match (0.8 s)** is `ILIKE` over three columns with no
  trigram index; it grows linearly with the workspace. A trigram index would add three
  more indexes to `evidence`.
- **Inbox (1.8 s)** two evidence reads per load; not analysed further.
- **Production pool size** — now a setting (section 5, item 6), still 10 everywhere.
  Choosing a value is a decision for whoever knows production's connection limit and
  pooler.
- **Ownership transfer picker** — after paging, it held only the members already read.
  It now searches the paged member API (`q`) across the whole organization; a render
  test hands ownership to member 250 of 250.
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
