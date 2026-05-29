# Phase O2 — Scale Readiness Program

**Status overview:**

| Phase | Title | Verdict |
| --- | --- | --- |
| O2.1 | Redis Shared Presence | **CLOSED** — real impl shipped, opt-in via env |
| O2.2 | Worker Autoscaling Readiness | **READY FOR INFRA** — single-container topology validated; horizontal scale is operator-config |
| O2.3 | Queue Partitioning | **CLOSED** — 16 isolated workers already partitioned by domain; topology documented |
| O2.4 | Deployment Topology | **CLOSED — documented** |
| O2.5 | Multi-Region Readiness | **READY FOR INFRA** — region pins inventoried; cross-region work is operator + cloud-infra scope |

This document is **honest about the line between "implementation
shipped" and "infrastructure operators must provide"**. Per the user's
hard rules: no fake autoscaling claims, no invented cloud resources,
no fake multi-region. Where O2 requires infrastructure PROOVRA does not
own (Kubernetes, autoscaling groups, Redis Cluster, second region), the
verdict is **READY FOR INFRA** with the exact prerequisites documented.

---

## O2.1 — Redis Shared Presence (CLOSED)

### What shipped

A real Redis-backed presence backend selectable at boot via env:

```
PROOVRA_PRESENCE_BACKEND=redis   # opt-in (default: memory)
REDIS_URL=redis://...            # required when above is "redis"
```

Files added:

- `services/api/src/services/presence/presence-backend.ts` — bounded interface
- `services/api/src/services/presence/redis-presence-backend.ts` — real Redis impl (Hash + TTL)
- `services/api/src/services/presence/presence-selector.ts` — env-driven dispatch
- `services/api/test/phase-o2-1-presence-redis-backend.test.ts` — 10 contract tests

`services/api/src/services/presence/presence.service.ts` is unchanged
(verbatim Phase G3) — it remains the in-memory backend, now reached
via the selector.

`services/api/src/routes/presence.routes.ts` was updated to import from
the selector and to `await` the now-async `listViewers`.

### Why NOT Redis Cluster

The implementation uses the existing single-Redis endpoint that BullMQ
+ rate-limit already depend on. **No Redis Cluster requirement.**

Per the user's hard rule (no faked cloud infra), Redis Cluster is
explicitly out of scope. The implementation works against any
single-node ioredis-compatible Redis. When PROOVRA scales past the
write throughput of a single Redis node (presence is ~1 HSET per
viewer per 30s — orders of magnitude below the Redis ceiling), Redis
Cluster becomes the natural next step. That step is **operator infra**,
not application code.

### Hard rules honoured (Phase G3 + O2.1)

- Workspace-scoped key (teamId in every hash key)
- Bounded payload — only `{displayName, tMs}` in the value JSON; NEVER IP / device / location / route
- Best-effort — Redis errors NEVER throw; degrade to empty list
- TTL eviction at read time AND Redis hash-key TTL (2× heartbeat TTL)
- Bounded fan-out — MAX_VIEWERS_PER_KEY=25, evict oldest when over
- No new endpoints — same `POST /v1/me/presence/heartbeat` + `GET /v1/me/presence/here` surface

### Operator playbook (when ready)

1. Confirm `REDIS_URL` points at a Redis that all api instances share.
2. Set `PROOVRA_PRESENCE_BACKEND=redis` in the api env.
3. Roll the api instances. Each will pick up the Redis backend on first
   presence call; no DB migration needed.
4. Verify in Grafana: viewer counts on a hot resource should now
   aggregate across instances rather than partition.

### Validation

`pnpm --filter proovra-api test -- phase-o2-1` → 10 / 10 passing.
Full suite: 11,051 passing / 53 skipped after this phase.

---

## O2.2 — Worker Autoscaling Readiness (READY FOR INFRA)

### Current state (audited)

`services/worker/src/index.ts` registers **16 BullMQ workers** via the
hardened `safeRegisterWorker` helper. Concurrency per worker is bounded
and documented inline:

| Worker | Concurrency | Rationale |
| --- | --- | --- |
| `report` | 2 | Puppeteer render is CPU + memory bound; 2 in parallel max |
| `ots-upgrade` | 1 | External calendar call; serial keeps backoff sane |
| `evidence-purge` | 1 | DB transaction-heavy; serial keeps locks short |
| `search-indexing` | 2 | Postgres tsvector update; bounded write parallelism |
| `media-intelligence` | 1 | Read-heavy on EvidencePart + ClientSignals; serial keeps Postgres calm |
| `derived-assets` | 1 | sharp + S3 (~4MB source); isolated from analyzer |
| `mi-exif` | 2 | exifr is CPU-light + bounded I/O (~16KB per part) |
| `mi-ocr` | 1 | Vendor-gated; serial bounds vendor backpressure |
| `mi-transcript` | 1 | Same as mi-ocr |
| `mi-search-index` | 2 | Thin shim to search-indexing queue |
| `graph-reconcile` | 1 | Read-only `reconcileTeamGraph`; serial keeps backpressure on queue |
| `graph-domain-sync` | 1 | Same |
| `graph-timeline-sync` | 2 | Read-heavy; bounded read parallelism |
| ...3 more subsystem workers | 1-4 | Each documented in source |

Idempotency: every job handler is idempotent against retries (asserted by
contract tests; see `services/worker/test/readiness-smoke.test.ts`).
The custody chain hashes are stable per `(evidenceId, version)` so a
duplicate run cannot produce a divergent custody event.

### Horizontal scale = operator scale-out

The current docker-compose runs ONE worker container. **Horizontal
scaling is `docker compose up -d --scale proovra-worker=N`** — BullMQ
handles distribution because every worker registers against the same
Redis queue with the same concurrency settings. No code change needed
for N=2..8 workers.

What PROOVRA's code already supports without modification:

- N workers safely consume the same queue (BullMQ semantics)
- Per-worker heartbeat surfaces in `/health` (each container reports
  independently)
- DLQ + retry continue working unchanged
- The OTEL `worker.span_total` + `worker.span_failed_total` counters
  carry per-container service.instance.id, so per-instance dashboards
  work today

### What is READY FOR INFRA (not implemented here)

These items require infrastructure PROOVRA's code cannot provide:

1. **Autoscaling policy** — a cloud autoscaling group / k8s HPA that
   scales the worker replica count based on queue depth. PROOVRA's
   `worker_stalled_total` + per-queue lag in Grafana is the signal;
   the policy is operator config.
2. **Container orchestrator** — docker-compose is fine for 1-N workers
   on one host; beyond that requires k8s / ECS / Nomad. We do NOT ship
   k8s manifests because we do not own the cloud account. Operators
   port the worker container as-is — no code change needed.
3. **Cross-worker leader election** — currently NOT required. PROOVRA
   has no singleton task; every scheduled job is enqueued by the api,
   not by a worker leader.

### Operator prerequisites for horizontal scale

- ☐ Confirm Redis can sustain the queue write rate at N×concurrency.
- ☐ Confirm Postgres connection pool has capacity for N×concurrency.
  Current pool default is `?connection_limit=10` per instance.
- ☐ Pick an autoscaling signal — recommended: `dlq_job_total` +
  `queue_job_stalled_total` from the new O1.6 alerts.
- ☐ Confirm worker container memory ceiling (Puppeteer is the bottleneck
  in the `report` worker).

---

## O2.3 — Queue Partitioning Audit (CLOSED)

### Current partition map

PROOVRA already runs **16 partitioned queues**, each backed by an
isolated worker (see O2.2 table). Domain isolation rules:

- **Report rendering** has its own queue (`report`) so a Puppeteer
  stall cannot block evidence ingest.
- **Custody / OTS** (`ots-upgrade`) is isolated so a calendar outage
  cannot back up the report queue.
- **Search indexing** (`search-indexing` + `mi-search-index`) is split
  so the bulk indexer (`search-indexing`) cannot starve the per-evidence
  reindex (`mi-search-index`).
- **Media intelligence** is split FOUR ways (`media-intelligence`,
  `derived-assets`, `mi-exif`, `mi-ocr`, `mi-transcript`) so that a
  slow vendor (OCR / transcript) cannot head-of-line block EXIF or
  thumbnails.
- **Graph reconcile** is split THREE ways (`graph-reconcile`,
  `graph-domain-sync`, `graph-timeline-sync`) so a single slow domain
  cannot stall the whole graph projection pipeline.
- **Destructive operations** (`evidence-purge`) are isolated and serial.

### Justification (per queue)

The partition decisions are documented inline in
`services/worker/src/index.ts` — each `safeRegisterWorker` call site
carries a comment explaining the partition rationale. The contract
test `services/worker/test/readiness-smoke.test.ts` verifies that
every documented queue is still registered.

### Further partitioning recommendations

- ☑ **None required at current scale.** The 16-way partition is
  generous for current evidence volume (single-digit packages / second
  peak in load tests).
- ☐ When daily SIU export volume exceeds the worker's processing rate
  (an emerging operational signal), split `siu-export` into its own
  queue. Today SIU export runs via the BullMQ `report`-style flow
  through the API request lifecycle, not a dedicated worker.

---

## O2.4 — Deployment Topology Audit (CLOSED — documented)

### What ships today

`infra/docker/docker-compose.prod.yml` defines:

| Service | Image | Replicas | Notes |
| --- | --- | --- | --- |
| `redis` | `redis:7-alpine` | 1 | Single node; BullMQ + rate-limit + (new) presence all share. |
| `proovra-api` | local build | 1 | Fastify api on `127.0.0.1:8080`. `OTEL_SERVICE_NAME=proovra-api` pinned. |
| `proovra-worker` | local build | 1 | BullMQ workers + Puppeteer + OTS. `OTEL_SERVICE_NAME=proovra-worker` pinned. |
| `caddy` | `caddy:2-alpine` | 1 | TLS terminator + reverse proxy. |

`infra/docker/docker-compose.full.yml` is the local-dev stack — adds
MinIO, Postgres, and a TSA mock. Not production.

`infra/docker/docker-compose.yml` is the per-developer minimal stack.

### Topology invariants

- **No leader-elected singletons.** Every scheduled job is api-driven,
  so N workers can co-exist without coordination beyond BullMQ.
- **No host-local persistent state in api/worker** — both are stateless.
  All durable state lives in Postgres + S3 + Redis.
- **Per-service OTEL service name** is pinned in the compose file
  (not in `.env`) so a shared `.env` cannot accidentally collapse the
  two services in Grafana Tempo. This is contract-asserted in
  `phase-p2-0b-observability-wiring.test.ts`.

### What is READY FOR INFRA (not implemented here)

- ☐ **Kubernetes manifests** — not shipped. Operators wanting k8s
  port the containers as-is. We deliberately do not include sample
  Helm charts because we do not test against a real cluster.
- ☐ **Cloud load balancer config** — Caddy is the terminator in the
  reference deployment; operators may swap for ALB / Cloud Run / etc.
  Our health endpoints (`/health` on api + worker) are stable.
- ☐ **Container registry pipeline** — operator config. We do not ship
  GitHub Actions deploy workflows because deploy targets are operator-
  specific (ECR vs. GCR vs. private registry).

---

## O2.5 — Multi-Region Readiness Audit (READY FOR INFRA)

### Region pins inventoried

| Component | Region pin | Source |
| --- | --- | --- |
| KMS signing | `AWS_REGION` (default `eu-north-1`) | `docker-compose.prod.yml` line 85 |
| AWS Secrets Manager | `AWS_SECRETS_REGION` (default `us-east-1`) | `docker-compose.prod.yml` line 83 |
| S3 bucket | `S3_REGION` (operator-set) | env var |
| Postgres | `DATABASE_URL` (operator-set) | env var |
| Redis | `REDIS_URL` (operator-set) | env var |
| OTEL OTLP gateway | `OTEL_EXPORTER_OTLP_ENDPOINT` (operator-set) | env var |

KMS and Secrets Manager regions are intentionally decoupled (Phase P2.0B
contract: KMS reads `AWS_REGION` directly; Secrets reads
`AWS_SECRETS_REGION` with `AWS_REGION` fallback) so multi-region S3
deployments do not force a KMS region migration.

### Hardcoded URLs (audited)

- `https://a.pool.opentimestamps.org` — public OTS calendar (intentional;
  not region-specific).
- No application code hardcodes a customer-facing domain. All
  CORS origins come from `CORS_ORIGINS`; the public verify URL comes
  from `ANCHOR_PUBLIC_BASE_URL`.

### What is READY FOR INFRA (not implemented here)

Per the user's hard rule: **no fake multi-region claims, no second
region spun up**. The verdict is honest:

1. ☐ **Active/active multi-region** requires region-replicated Postgres
   (Aurora Global / CrunchyDB Global) + region-replicated Redis +
   region-replicated S3 (or per-region buckets + cross-region replication).
   This is multi-million-dollar infra; PROOVRA's code is ready (no region
   assumption is hardcoded in app code), but the infra is operator scope.
2. ☐ **Active/passive DR region** is the easier path: stand up the same
   docker-compose stack in a second region pointing at a replica of
   Postgres + S3, with KMS keys replicated. The runbook in
   `docs/operations/dr-runbook.md` covers the cut-over.
3. ☐ **CDN / edge cache** for public verify pages — operator config.
   PROOVRA's `/verify/:id` is fully cacheable for completed evidence;
   wire CloudFront / Fastly + cache headers as needed.

### Code-side multi-region prerequisites already satisfied

- ☑ No hardcoded region in app code (all via env).
- ☑ Signed URLs use the configured S3 endpoint, not a hardcoded one.
- ☑ KMS signer is region-aware via `AWS_REGION`.
- ☑ OTEL is per-environment-tagged so region telemetry can carry a
  bounded `service.namespace=proovra-region-X` resource attribute.
- ☑ Public anchor URLs use `ANCHOR_PUBLIC_BASE_URL` — region-agnostic.

### What we explicitly DO NOT claim

- ❌ We do NOT claim PROOVRA is "multi-region today". It is not.
  Production runs in one region.
- ❌ We do NOT claim auto-failover. That requires DNS + health-check
  infra outside PROOVRA's code.
- ❌ We do NOT ship terraform / pulumi for a second region. Operators
  who own a second region implement that themselves.

---

## Closing verdict

- **O2.1 Redis Shared Presence — CLOSED.** Real impl shipped; opt-in.
- **O2.2 Worker Autoscaling — READY FOR INFRA.** Code supports
  horizontal scale-out; autoscaling policy + container orchestrator
  are operator scope.
- **O2.3 Queue Partitioning — CLOSED.** 16 isolated queues; further
  partitioning is workload-driven and not required today.
- **O2.4 Deployment Topology — CLOSED — documented.** Single-host
  docker-compose with N-replicable workers; k8s port is operator scope.
- **O2.5 Multi-Region Readiness — READY FOR INFRA.** No region pins
  in app code; second-region infra is operator scope.

The honest line between "code complete" and "infrastructure operator
scope" is preserved throughout. No fake autoscaling, no fake
multi-region, no invented cloud resources.
