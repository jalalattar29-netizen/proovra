# PROOVRA Observability Catalog (Phase G5.5)

**Audience:** SRE, ops leads, on-call engineers.

**Purpose:** name what is observable today, what's missing, and the bounded
migration path for each gap.

---

## 1. Metrics catalog

### 1.1 Where it lives

`packages/shared-runtime/src/ops/metrics.service.ts` — single-source registry
with two helper functions:

- `bump(key)` — increment a monotonic counter. Counter name must be in the
  pre-declared `COUNTER_NAMES` array (ad-hoc names rejected at runtime).
- `setGauge(key, value)` — overwrite a gauge.
- `buildPrometheusExposition()` — return Prometheus-format text for
  scraping.

### 1.2 Counts

- **345 counter names** (monotonic, namespaced)
- **97 gauge names** (last-write-wins)
- **442 total bounded keys**

### 1.3 Namespacing

Counters and gauges follow underscored namespaces. The top namespaces:

| Namespace | Purpose | Sample keys |
| --- | --- | --- |
| `tenancy_*` | Org/workspace resolution health | `tenancy_resolution_failure_total`, `orphan_governance_object_total`, `tenancy_disagreement_total`, `cross_org_resolution_blocked_total` |
| `reviewer_*` | Reviewer-ops + queue + SLA | `reviewer_queue_viewed_total`, `reviewer_assignment_failed_total`, `reviewer_sla_breached_total` |
| `governance_*` | Retention + holds + destruction | `governance_retention_resolution_total`, `governance_destruction_executed_total` |
| `custody_*` + `evidence_integrity_*` | Custody chain + integrity | `evidence_integrity_failed_hash_mismatch_total`, `custody_event_appended_total` |
| `queue_*` | BullMQ queue health | `queue_backlog_count` (gauge), `queue_job_failed_total`, `queue_dlq_total` |
| `upload_session_*` + `multipart_*` | Resumable + S3 multipart | `upload_session_finalized_total`, `multipart_upload_completed_total` |
| `media_intelligence_*` + `derived_assets_*` | MI signal projection | `media_intelligence_signals_indexed_total` |
| `sso_*` + `saml_*` + `scim_*` | Identity federation | `sso_login_succeeded_total`, `saml_assertion_validated_total` |
| `presence_*` | Heartbeat + collision | `presence_heartbeat_recorded_total` |
| `notification_*` | Inbox + preferences | `notification_preference_updated_total` |
| `step_up_*` | Re-auth challenges | `step_up_challenge_started_total` |
| `webhook_*` | Outbound webhook delivery | `webhook_delivery_succeeded_total`, `webhook_signature_failures_total` |
| `analytics_*` + `ai_*` | Hardened AI/analytics surfaces | `ai_chat_rate_limited_total`, `analytics_rate_limited_total` |

### 1.4 Cardinality discipline

The registry is **bounded by design** — names are constants, not derived
from request payloads. There is no `{user_id}` or `{evidence_id}` label
proliferation. This is the right shape for Prometheus + Grafana.

---

## 2. Structured logs

### 2.1 Worker (production-grade)

- **Logger**: Pino at `services/worker/src/logger.ts`.
- **Output**: structured JSON.
- **Redaction paths**: `authorization`, `cookie`, `token`, `accessToken`,
  `refreshToken`, `password`, `secret` — all auto-replaced with
  `[REDACTED]`.
- **Context injection**: `withJobContext()` adds `requestId`, `jobId`,
  `evidenceId`, `attempt`, `durationMs`, `status`.
- **Log level**: env-driven (`LOG_LEVEL`, default `info`).

### 2.2 API (gap — see §4.2)

- **Logger**: `services/api/src/utils/logger.ts` — console-based.
- **Production behaviour**: suppresses `info` and `warn` (only `error`
  emitted).
- **Missing**: structured JSON, automatic redaction, trace IDs, request
  correlation.

---

## 3. Security event catalog

### 3.1 Where it lives

`packages/shared/dist/security.d.ts` exports `SECURITY_EVENT_TYPES`. Service
layer: `services/api/src/services/security/security-event.service.ts`.

### 3.2 Shape

- **320 distinct event types**, immutable catalog.
- **3 severities**: `INFO`, `WARNING`, `HIGH`.
- **DB-backed**: `SecurityEvent` table — columns `teamId`, `userId`,
  `eventType`, `severity`, `ipAddressHash` (hashed, not raw), `userAgent`,
  `requestId`, `metadataJson`, `createdAtUtc`.
- **Details bound**: each string clipped to 1,000 bytes; total JSON
  clipped to 4 KB; truncation logged.
- **No PII**: callers responsible. IP is hashed before persist.

### 3.3 Sample event types

- Upload: `repeated_upload_failure`, `upload_stalled`, `multipart_*_failed`
- Identity: `member_*`, `session_*`, `trusted_device_*`, `mfa_*`,
  `sso_*`, `saml_*`
- Governance: `retention_policy_*`, `destruction_*`,
  `evidence_lifecycle_*`
- Search / abuse: `search_*_blocked`, `excessive_rate_limit_hits`,
  `communication_rate_limit_exceeded`

---

## 4. Health endpoints

### 4.1 Shipped

| Endpoint | Auth | Purpose | Returns |
| --- | --- | --- | --- |
| `GET /healthz` | none | Liveness probe | `{ status: "ok" }` |
| `GET /readyz` | none | Readiness — DB + config validation | 200 OK or 503 with reason |
| `GET /v1/ops/health` | `identity.member.read` | Detailed snapshot | feature flags, queue depth, open incidents, reconcile summary, Prometheus snapshot |
| Worker `GET /health` | none (internal) | Worker liveness | queue counts + Redis ping latency |

### 4.2 Gaps

- No DB-latency measurement on `/readyz`.
- No Redis ping on API `/readyz`.
- No worker-processor heartbeat metric.

---

## 5. Top 5 observability gaps + migration plans

### 5.1 No SLO metrics (latency histograms, error-rate targets)

**Current state:** counters exist for success/failure events but no
percentile latency captured.

**Migration plan:**
1. Add a Pino-compatible histogram helper alongside `bump()` /
   `setGauge()`. Bounded buckets: 50ms / 100ms / 250ms / 500ms / 1s / 2.5s
   / 5s / 10s.
2. Wire the histogram on five hot paths: `/v1/evidence` create,
   `/v1/cases/:id/matter-workspace`, `/v1/reviewer-ops/console`,
   `/v1/governance/export-eligibility`, `/public/verify/:id`.
3. Define SLO targets:
   - 95% of `/public/verify/:id` < 250ms.
   - 95% of console aggregator < 500ms.
   - 99% of evidence create < 2.5s (excluding upload-byte transfer).
4. Surface in `/v1/ops/health` snapshot.

**Bounded effort:** ~1 day implementation, ~1 day instrumentation +
dashboard.

### 5.2 API logger lacks structure

**Current state:** `console.log` only. No JSON, no trace IDs, no
correlation header.

**Migration plan:**
1. Replace `services/api/src/utils/logger.ts` with a Pino instance that
   mirrors the worker's configuration (redaction paths, log level).
2. Add request-id middleware that injects an `x-proovra-request-id`
   header + a `request_id` log field.
3. Update existing call sites — they're already calling `log()` /
   `warn()` / `error()`, so the migration is the logger module body,
   not the call sites.

**Bounded effort:** ~1 day.

### 5.3 Security events not aggregated to real-time dashboard

**Current state:** events live in `SecurityEvent` table; operators must
query the DB to investigate.

**Migration plan:**
1. Add a counter per event type at emit time:
   `bump(\`security_event_${eventType}_total\`)`.
2. Surface a bounded "recent high-severity events" projection on the
   ops dashboard (last 24h, top 10 by count).
3. Add Prometheus alert candidates: page on
   `repeated_upload_failure_total` rate spike, `tenancy_disagreement_total`
   non-zero, `evidence_integrity_failed_hash_mismatch_total` non-zero.

**Bounded effort:** ~1 day metric instrumentation, ~1 day dashboard.

### 5.4 Worker processor health dark

**Current state:** queue counts exposed but no per-job processing latency
or worker-pool saturation visible.

**Migration plan:**
1. Add a per-queue processing-latency histogram. Buckets: 100ms / 500ms
   / 1s / 5s / 30s / 2min / 10min.
2. Add `worker_processor_active_count` gauge (concurrent jobs in
   flight).
3. Surface in worker `GET /health`.

**Bounded effort:** ~half day.

### 5.5 Queue-depth forecasting absent

**Current state:** queue depth gauge exists but no trending.

**Migration plan:**
1. Compute a rolling 5-minute / 1-hour delta on `queue_backlog_count`.
2. Define alert: page if backlog growth rate > 100 jobs/min sustained
   for 5 min on any queue.
3. Add the aging metric (oldest pending job age) as an alert input.

**Bounded effort:** dashboard + alert rules only, no code change.

---

## 6. Alert candidates

Recommended alert rules (none wired today — operator decides Grafana /
PagerDuty / etc.):

| Severity | Metric | Threshold | Action |
| --- | --- | --- | --- |
| Critical | `evidence_integrity_failed_hash_mismatch_total` | rate > 0 / min | Page on-call |
| Critical | `tenancy_disagreement_total` | any | Page on-call (cross-tenant leak suspected) |
| Critical | API `/readyz` | non-200 for >2 min | Page on-call |
| High | `queue_dlq_total` | rate > 5 / 5 min | Notify ops |
| High | `webhook_signature_failures_total` | rate > 10 / 5 min | Notify security |
| High | `queue_backlog_count{queue=report}` | > 1000 sustained 10 min | Notify ops |
| Warning | `step_up_challenge_started_total` | rate spike 10× baseline | Notify security |
| Warning | `notification_preference_updated_total` | rate spike 10× baseline | Notify success (mass opt-out) |
| Warning | Worker `/health` | non-200 | Notify ops |

---

## 7. Correlation IDs

Recommended pattern (gap — see §5.2):

- Every request gets `x-proovra-request-id` (server-generated UUID if
  client did not provide).
- Worker jobs carry `requestId` field in their payload + Pino context.
- Public-verify-share links may use the same correlation id for forensic
  trace.

---

## 8. Reference

- Metrics service: [packages/shared-runtime/src/ops/metrics.service.ts](../../packages/shared-runtime/src/ops/metrics.service.ts)
- Security events: [services/api/src/services/security/security-event.service.ts](../../services/api/src/services/security/security-event.service.ts)
- Ops routes: [services/api/src/routes/ops.routes.ts](../../services/api/src/routes/ops.routes.ts)
- Worker logger: [services/worker/src/logger.ts](../../services/worker/src/logger.ts)
- API logger: [services/api/src/utils/logger.ts](../../services/api/src/utils/logger.ts)
- Health endpoints (worker): [services/worker/src/health.ts](../../services/worker/src/health.ts)

---

# Part B — Grafana OpenTelemetry + Sentry performance (Phase P2.0B)

## B.1 Service identity

| Service | OTEL service name | Sentry `serverName` |
| --- | --- | --- |
| API | `proovra-api` | `proovra-api` |
| Worker | `proovra-worker` | `proovra-worker` |
| Web | `proovra-web` (when instrumented) | (existing) |

Per-container `OTEL_SERVICE_NAME` is pinned in `docker-compose.prod.yml`. The api and worker can share a single `.env` block for everything else.

## B.2 Env contract (production)

```env
# Sentry — errors + performance + profiling
SENTRY_ENABLED=true
SENTRY_DSN=<existing>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.2       # bounded; clamped to [0,1]; default 0.2
SENTRY_PROFILES_SAMPLE_RATE=0.1     # bounded; clamped to [0,1]; default 0.1
SENTRY_RELEASE=                      # falls back to APP_RELEASE_SHA / GIT_SHA

# OTEL (Grafana Cloud)
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <ROTATED_GRAFANA_TOKEN>
OTEL_RESOURCE_ATTRIBUTES=service.namespace=proovra,deployment.environment=production
LOG_AGGREGATION_ENABLED=true

# AWS Secrets Manager — see docs/security/secrets-manager.md
AWS_SECRETS_ENABLED=true
AWS_SECRET_NAME=proovra/prod/app-secrets
AWS_SECRETS_REGION=us-east-1
AWS_SECRETS_REFRESH_TTL_MS=3600000
AWS_REGION=eu-north-1                # KMS continues to use this
```

## B.3 Grafana OTLP token handling

The Grafana OTLP `Authorization` header value is a SECRET.

- **Never commit it.** It lives only in `/opt/proovra/app/.env`.
- **Never log it.** `services/api/src/observability/otel.ts` parses headers but never emits their values; `getOtelStatus()` reports only `endpointConfigured: true|false`.
- **Rotate after exposure.** Treat the initial setup token as exposed. Procedure:
  1. Grafana Cloud → OpenTelemetry → rotate credential.
  2. Update `OTEL_EXPORTER_OTLP_HEADERS` in `/opt/proovra/app/.env`.
  3. `docker compose ... up -d --force-recreate` to roll both containers.

## B.4 PROOVRA span vocabulary

Bounded custom span names — referenced from `PROOVRA_SPAN_NAMES` (single source of truth in both `services/api/src/observability/otel.ts` and `services/worker/src/otel.ts`):

| Span | Originator |
| --- | --- |
| `proovra.report.generate` | worker `processor.ts` |
| `proovra.package.generate` | worker `verification-package.ts` |
| `proovra.export.manifest.create` | api `export-manifest.service.ts` (P2.1) |
| `proovra.export.reproducibility.verify` | api `export-reproducibility.service.ts` (P2.1) |
| `proovra.queue.job.replay` | api queue-ops routes (P2.3) |
| `proovra.queue.job.retry` | api queue-ops routes (P2.3) |
| `proovra.recovery.backup.validate` | api DR routes (P2.5) |
| `proovra.recovery.restore.validate` | api DR routes (P2.5) |
| `proovra.tsa.timestamp` | worker TSA path |
| `proovra.ots.anchor` | worker OTS path |

## B.5 Attribute safety

Allowed: `service`, `environment`, `queue name`, `job type`, `operation type`, `status`, `duration`, `workspaceId`, `orgId`.

Forbidden: evidence content / file names / SHA-256 hashes (unless already public-safe) / user emails / authorization headers / SAML assertions / payment data / Grafana token.

Sentry transactions are scrubbed via `beforeSendTransaction` — inbound headers matching `authorization` / `cookie` / `token` / `secret` / `api-key` are redacted before the payload leaves the process.

## B.6 Sample rate guidance

- `SENTRY_TRACES_SAMPLE_RATE=0.2` — 20% transaction capture. Right starting point for staging + production.
- `SENTRY_PROFILES_SAMPLE_RATE=0.1` — profiles only for SAMPLED transactions, so the **effective** profile rate is `0.2 × 0.1 = 0.02` (2%).
- Set `SENTRY_TRACES_SAMPLE_RATE=0` to disable performance entirely; errors keep flowing.

## B.7 Validation commands

```bash
# 1. Apply env + recreate containers
docker compose --env-file /opt/proovra/app/.env \
  -f infra/docker/docker-compose.prod.yml \
  up -d --force-recreate

# 2. Confirm boot logs
docker logs docker-proovra-api-1 --tail 100 | \
  grep -E "otel.bootstrap_(succeeded|disabled|failed)|aws_secrets.hydration_(succeeded|failed)"

docker logs docker-proovra-worker-1 --tail 100 | \
  grep -E "otel.bootstrap_(succeeded|disabled|failed)"

# 3. Verify secrets-health (auth required)
curl -s http://127.0.0.1:8080/v1/runtime/secrets-health?teamId=<UUID> \
  -H "Authorization: Bearer <admin-token>" | jq '.health.degraded, .otel'
```

Expected JSON shape (values vary):

```json
{
  "health": {
    "awsEnabled": true,
    "awsConnected": true,
    "fallbackMode": "aws_primary",
    "region": "us-east-1",
    "degraded": false
  },
  "otel": {
    "enabled": true,
    "started": true,
    "serviceName": "proovra-api",
    "endpointConfigured": true
  }
}
```

The response NEVER includes the OTLP endpoint URL, the Grafana token, or any secret value.

## B.8 Failure modes

| Symptom | Cause | Recovery |
| --- | --- | --- |
| `otel.bootstrap_failed` log line | Bad header format / unreachable endpoint at boot | Bounded `code` field in the log. App keeps running; only telemetry suppressed. |
| OTEL 401 / 403 from the exporter | Token expired / rotated / wrong workspace | Rotate `OTEL_EXPORTER_OTLP_HEADERS`; rolling-restart. |
| Sentry quota spike | Sample rate too high | Set `SENTRY_TRACES_SAMPLE_RATE=0` immediately; investigate; reset to 0.2 once safe. |
| `health.degraded == true` | AWS Secrets Manager unreachable | App continues via env fallback. See `docs/security/secrets-manager.md` §6. |

## B.9 Rollback

- `OTEL_ENABLED=false` → roll containers. Tracing off. No code change.
- `SENTRY_TRACES_SAMPLE_RATE=0` → roll containers. Performance off. Errors still captured.
- `AWS_SECRETS_ENABLED=false` → roll containers. App reads from env exclusively.

---

# Appendix C — Phase O1.1 update (production OTEL wiring)

Phase O1.1 hardened the OTEL bootstrap and added the runtime-visible state:

- Bootstrap emits four bounded log lines: `otel.bootstrap_started` / `succeeded` / `disabled` / `failed`.
- Bounded `withProovraSpan(name, attrs, fn)` helper wires the critical entry points (SIU preflight + generate, C2PA detect + summary, signer health, recovery backup + restore validate).
- New endpoint `GET /v1/runtime/otel-health` returns the bounded `getOtelStatus()` snapshot — `started` / `degraded` / `lastBootstrapAtUtc` / `lastBootstrapOutcome` / `lastBootstrapFailureCode` / `lastExportErrorCode` / `spansCreatedCount` / `resourceAttributes`. Never returns the OTLP endpoint URL, headers, or Grafana token.

Full runbook: `docs/operations/otel-runtime-wiring.md`. Closure report: `docs/operations/phase-o1-1-otel-runtime-closure.md`.

---

# Appendix D — Phase O1.2 update (observability coverage closure)

Phase O1.2 added:

- **Span coverage**: `proovra.queue.job.retry` / `.replay` and `proovra.custody.attestation.sign` / `.verify` / `.backfill` wired into the api services.
- **Metric registry additions** (18 bounded names): `queue_retry_total`, `queue_retry_failure_total`, `queue_replay_duration_ms`, `custody_attestation_sign_failure_total`, `siu_export_generated_total`, `siu_export_failed_total`, `siu_export_download_total`, `siu_export_upload_failure_total`, `package_generation_total`, `package_generation_failed_total`, `export_generation_total`, `export_generation_failed_total`, `export_reproducibility_verify_total`, `recovery_backup_validation_total`, `recovery_restore_validation_total`, `recovery_validation_failed_total`, `c2pa_backfill_run_failure_total`, `siu_pii_revealed_total`.
- **Four Grafana dashboards** at `infra/grafana/dashboards/`: PROOVRA — Operations Overview / Queue Operations / Exports & Reproducibility / Recovery.
- **Eleven alert rules** at `infra/grafana/alerts/proovra-operations-alerts.yaml`. Every rule's `runbook_url` resolves to an anchor in `observability-runbooks.md`.
- **Internal SLO model** at `slo-model.md`. Six bounded internal targets. Bounded copy "internal target — not a customer SLA".
- **Bounded Sentry tag set** (`service` / `operation` / `queueName` / `jobType` / `errorCode` / `environment`). Bounded copy in §B.6.
- **OTEL health extensions**: `lastSpanName` + `lastSpanAtUtc` returned by `/v1/runtime/otel-health`.

Full closure: `phase-o1-2-observability-coverage-closure.md`.
