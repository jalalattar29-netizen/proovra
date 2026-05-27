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
