# PROOVRA — Low-RAM Production Deployment Runbook (Phase O1.3)

**Audience:** PROOVRA SRE / operator deploying to the production server.
**Server constraint:** the production VM has limited RAM. A full `docker compose build` of every service in parallel can OOM-kill the node-build step. The procedures below avoid that.

---

## 1. When to follow this runbook

Any change to:
- A service `Dockerfile`
- `package.json` / `pnpm-lock.yaml` (including the O1.3 `@opentelemetry/api` pin)
- TypeScript source in `services/api`, `services/worker`, or `apps/web`
- A worker / shared-runtime that the api also depends on

If you're only changing env vars or config, `docker compose up -d --force-recreate <service>` is enough — no build step needed.

## 2. Preferred path — off-server build

Use the existing GitHub Actions workflow to build + push the container images to GHCR. The production server only pulls + recreates. Off-server builds completely sidestep the memory pressure.

```bash
# Locally (or via PR merge), trigger the build workflow.
gh workflow run build-images.yml --ref main

# After the workflow finishes, on the production server:
docker compose pull proovra-api proovra-worker proovra-web
docker compose up -d --force-recreate proovra-api proovra-worker proovra-web
```

If the GHA workflow is unavailable or you need a hotfix faster than CI can build, use §3.

## 3. On-server staged build (last resort)

The principle: never let two service builds run concurrently. Free RAM between each build.

### 3.1 Pre-build housekeeping

```bash
# Stop non-essential containers to free RAM. proovra-api + proovra-worker
# can keep running until step 3.3 swaps them.
docker compose stop grafana-agent || true
docker compose stop sentry-relay || true

# Free Docker cruft.
docker builder prune --force --filter "until=72h"
docker image prune --force

# Check available memory (Linux).
free -h
```

Target: at least **2 GB free** before starting each container build. If you can't get there, fall back to off-server build (§2).

### 3.2 Build services one at a time

Build order: **shared deps first → api → worker → web**.

```bash
# 1. API container (includes shared-runtime + shared + shared-billing build
#    inside the Dockerfile).
docker compose build --no-cache proovra-api

# Confirm the build succeeded and we have RAM headroom.
free -h

# 2. Worker container.
docker compose build --no-cache proovra-worker

# 3. Web container.
docker compose build --no-cache proovra-web
```

If any individual build OOMs, stop, free more RAM (drop more sidecars), and resume from the failed step. Builds are independent — repeating one does not re-build the others.

### 3.3 Roll the containers

Roll backend first (api, worker), then frontend (web). This ensures the new web build talks to the new api.

```bash
docker compose up -d --force-recreate proovra-api
# Wait for bootstrap; see §4.

docker compose up -d --force-recreate proovra-worker
# Wait for bootstrap; see §4.

docker compose up -d --force-recreate proovra-web
```

### 3.4 Restart sidecars

```bash
docker compose start grafana-agent
docker compose start sentry-relay
```

## 4. Post-deploy validation (Phase O1.3)

### 4.1 API bootstrap

```bash
docker logs docker-proovra-api-1 --tail 200 | grep -iE 'otel\.bootstrap|duplicate registration|OTLPExporterError|401'
```

Expected:
- `otel.bootstrap_started`
- `otel.bootstrap_succeeded`
- **No** `Attempted duplicate registration`
- **No** `OTLPExporterError`
- **No** `401`

### 4.2 Worker bootstrap

```bash
docker logs docker-proovra-worker-1 --tail 200 | grep -iE 'otel\.bootstrap|duplicate registration|version v1|401'
```

Expected:
- `otel.bootstrap_started`
- `otel.bootstrap_succeeded`
- **No** `Attempted duplicate registration of API`
- **No** `Registration of version v1.9.1 for trace/context/propagation does not match previously registered API v1.9.0`
- **No** `401`

### 4.3 OTEL diagnostics endpoint

Auth-required; replace `…` with a valid bearer + active team id.

```bash
curl -s -H "Authorization: Bearer …" \
  "https://api.proovra.com/v1/runtime/otel-health?teamId=…" | jq .
```

Expected `diagnostics.packageVersions["@opentelemetry/api"] === "1.9.1"`. If it reports anything else, the override didn't apply — re-pull the image or `pnpm install --force` locally and rebuild.

### 4.4 Grafana Tempo — cross-service trace continuity

1. Open Grafana Tempo.
2. Query `service.name="proovra-api" name="proovra.report.generate"` for a recent trace.
3. Confirm the same trace shows a span tree that includes BOTH `proovra-api` (parent) AND `proovra-worker` (child `proovra.worker.report.generate`). This proves the queue-OTEL context propagation is alive.

### 4.5 Sentry coexistence

In Sentry, confirm:
- Errors from the bootstrap window are still arriving (project filter `environment:production`).
- No errors mentioning `Attempted duplicate registration`.

## 5. Rollback

Both image tags are kept locally for at least 7 days.

```bash
docker image ls | grep proovra
# Note the previous tag (e.g. proovra-api:sha-abc123).

docker compose up -d --force-recreate --image ghcr.io/proovra/proovra-api:sha-abc123 proovra-api
docker compose up -d --force-recreate --image ghcr.io/proovra/proovra-worker:sha-abc123 proovra-worker
```

If the rollback target is more than 7 days old, pull explicitly first:

```bash
docker pull ghcr.io/proovra/proovra-api:sha-abc123
docker pull ghcr.io/proovra/proovra-worker:sha-abc123
```

After rollback, repeat §4 against the rolled-back tag — the OTEL health endpoint should report the version the rollback tag was built with.

## 6. Common failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| OOM during `docker compose build` | Sidecars still running, builder cache too large | §3.1 housekeeping, then build ONE service at a time |
| `Attempted duplicate registration` after deploy | Override didn't apply to the resolved image | Rebuild with cleared cache (`--no-cache`); confirm `pnpm-lock.yaml` was committed |
| `401 Unauthorized` from OTLP | Grafana token rotated; `OTEL_EXPORTER_OTLP_HEADERS` stale | Update env, `docker compose up -d --force-recreate proovra-api proovra-worker` |
| No worker spans in Tempo, no version-mismatch warning | OTEL_ENABLED not set on worker container | Check compose override for `proovra-worker` service env |
| Worker spans visible but not parented to API | Job enqueued before the O1.3 deploy reached the API | One-shot — clears after the next enqueue from the new API code |

## 7. Related docs

- `docs/operations/phase-o1-3-otel-final-closure.md` — phase closure report (root cause + version strategy).
- `docs/operations/observability-runbooks.md` — per-alert runbooks (`api-down`, `worker-degraded`, …).
- `docs/operations/MIGRATION_DISCIPLINE.md` — DB-side discipline (separate from OTEL but same low-RAM constraints apply for `prisma migrate deploy`).
