# PROOVRA — Low-RAM Production Deployment Runbook (Phase O1.3)

**Audience:** PROOVRA SRE / operator deploying to the production server.
**Server constraint:** the production VM has limited RAM. A full `docker compose build` of every service in parallel can OOM-kill the node-build step. The procedures below avoid that.

---

## 1. How a deploy works

Images are built off the server by `.github/workflows/deploy-images.yml`. The server
only pulls them, so a deploy needs no build memory. There is no on-server build path:
the old one here named a workflow and services that do not exist, and it went around
the revision and schema checks.

## 2. Deploy

Apply migrations first, through the migration runbook. Then, on the server:

```bash
GHCR_OWNER=<owner> RELEASE_SHA=<40-hex commit> IMAGE_TAG=sha-<first 7> \
  ./scripts/deploy-prod-pull.sh --plan      # prints what would happen, changes nothing
GHCR_OWNER=<owner> RELEASE_SHA=<40-hex commit> IMAGE_TAG=sha-<first 7> \
  ./scripts/deploy-prod-pull.sh
```

It proves each image's revision, gates on the database schema, recreates the API
then the worker, waits for each to be ready, and writes the release record. The web
deploys through Vercel.

If the workflow cannot publish images, fix that. Do not build on the server: a
hand-built image carries no revision label, and the deploy refuses it.

## 3. If memory is tight

```bash
free -h
docker image prune --force
docker builder prune --force --filter "until=72h"
```

Only env or config changed? Recreate the one service with the same `IMAGE_TAG` it
runs now (the command is under §6). Rollback is in §5.

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

Roll back through the deploy script. It runs the same revision and schema checks as
a deploy, so a rollback cannot start an image that fails them. Add `--plan` first to
see what it would do.

```bash
GHCR_OWNER=<owner> ./scripts/deploy-prod-pull.sh --rollback --plan
GHCR_OWNER=<owner> ./scripts/deploy-prod-pull.sh --rollback
```

This redeploys the release recorded in `.deploy-state/previous-release` by the last
deploy, and pulls its images from GHCR if the host no longer has them. If that file
is missing, or you need an older release, name it the same way as a deploy:

```bash
GHCR_OWNER=<owner> RELEASE_SHA=<40-hex commit> IMAGE_TAG=sha-<first 7> \
  ./scripts/deploy-prod-pull.sh
```

A rollback restores code only. Migrations are forward-only, and the script refuses
an image the database schema no longer satisfies. The web rolls back separately, in
Vercel.

After rollback, repeat §4 against the rolled-back release.

## 6. Common failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Host short of memory during a pull | Old images and builder cache | §3 housekeeping. Nothing builds on the server, so any build step here is the wrong path (§2) |
| `Attempted duplicate registration` after deploy | The image was built with a dependency override that did not apply | Fix it in the repository: confirm `pnpm-lock.yaml` was committed, let `deploy-images.yml` publish a new image, and deploy that commit (§2). Roll back meanwhile (§5) |
| `401 Unauthorized` from OTLP | Grafana token rotated; `OTEL_EXPORTER_OTLP_HEADERS` stale | Update the server's env file, then recreate each service with the command below this table |
| No worker spans in Tempo, no version-mismatch warning | `OTEL_ENABLED` is false on the worker container | `infra/docker/docker-compose.prod.yml` defaults it to true, so check the server's env file, then recreate the worker with the command below |
| Worker spans visible but not parented to API | Job enqueued before the O1.3 deploy reached the API | One-shot — clears after the next enqueue from the new API code |

To recreate a service after an env change, keep the image it runs now. From the
checkout of the running release on the server:

```bash
GHCR_OWNER=<owner> IMAGE_TAG=<tag it runs now> docker compose --env-file .env \
  -f infra/docker/docker-compose.prod.yml up -d --no-deps --force-recreate proovra-worker
```

## 7. Related docs

- `docs/operations/observability-runbooks.md` — per-alert runbooks (`api-down`, `worker-degraded`, …).
- `docs/operations/MIGRATION_DISCIPLINE.md` — DB-side discipline (separate from OTEL but same low-RAM constraints apply for `prisma migrate deploy`).
