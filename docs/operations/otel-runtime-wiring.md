# OpenTelemetry Runtime Wiring (Phase O1.1)

**Audience:** PROOVRA operators verifying production observability; engineers extending the span coverage.

---

## 1. Where the bootstrap lives

| Service | Bootstrap entry | Bootstrap module |
| --- | --- | --- |
| API | `services/api/src/observability/otel-bootstrap.ts` | `services/api/src/observability/otel.ts` |
| Worker | `services/worker/src/otel-bootstrap.ts` | `services/worker/src/otel.ts` |

Both bootstrap entries are side-effect imports placed BEFORE Fastify (api) or BullMQ (worker) so the auto-instrumentation patches Node's `http`, `ioredis`, and other built-ins before the application loads them.

## 2. Environment contract

Shared (api + worker, lives in production `.env`):

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <ROTATED_GRAFANA_TOKEN>
OTEL_RESOURCE_ATTRIBUTES=service.namespace=proovra,deployment.environment=production
LOG_AGGREGATION_ENABLED=true
```

Per-container in `infra/docker/docker-compose.prod.yml`:

```yaml
proovra-api:
  environment:
    OTEL_SERVICE_NAME: proovra-api

proovra-worker:
  environment:
    OTEL_SERVICE_NAME: proovra-worker
```

The compose file inherits endpoint / protocol / headers / resource attributes from the `.env` and ONLY overrides `OTEL_SERVICE_NAME` so each container reports a distinct service. The Grafana token NEVER appears in the compose file.

## 3. Bootstrap log lines

Both services emit four bounded log lines depending on outcome:

| Log line | Meaning |
| --- | --- |
| `otel.bootstrap_started` | Bootstrap is about to attempt initialisation. Includes `serviceName`, `endpointConfigured`, `protocol`. |
| `otel.bootstrap_succeeded` | NodeSDK started; auto-instrumentation patched. Includes `serviceName`, `serviceNamespace`, `environment`, `serviceVersion`, `endpointConfigured`, `protocol`, `exporterKind`. |
| `otel.bootstrap_disabled` | `OTEL_ENABLED ≠ "true"` (default in local dev / Docker). |
| `otel.bootstrap_failed` | NodeSDK init threw. Includes bounded `code`. |

These lines NEVER include the OTLP endpoint URL, headers, or the Grafana token.

## 4. Bounded PROOVRA span helper

Use `withProovraSpan(name, attributes, fn)` to wrap any unit of work. Phase O1.1 wires it into:

- SIU export preflight + generate
- Signer health probe
- Recovery backup + restore validation
- (existing) Verification Package attestations + historical material

The helper:

- Bounds attribute keys to ≤60 chars and values to ≤200 chars.
- Drops null / undefined / non-finite numbers / objects.
- Sets `SpanStatusCode.OK` on success and `SpanStatusCode.ERROR` (with the bounded error name) on throw.
- Increments `spansCreatedCount` and (on error) `lastExportErrorCode` in the bounded runtime state.

The full bounded enum is `PROOVRA_SPAN_NAMES` in both `otel.ts` copies. NEVER pass PII, evidence content, tokens, or storage keys as attributes.

## 5. Auto-instrumentations

Enabled:

- `@opentelemetry/instrumentation-http` (server + outbound client)
- `@opentelemetry/instrumentation-ioredis`

Explicitly disabled:

- `@opentelemetry/instrumentation-fs` (noisy + leaks file paths)
- `@opentelemetry/instrumentation-dns` (cardinality blowup)
- `@opentelemetry/instrumentation-pg` (conflicts with bundled Prisma engine)

Postgres latency is visible via Prisma metrics; the http-client span tree already shows queries through the Prisma engine proxy.

## 6. Runtime health snapshot

`GET /v1/runtime/otel-health?teamId=<uuid>` (auth-gated; mirrors `/v1/runtime/secrets-health`).

Returns the bounded `getOtelStatus()` snapshot:

- `enabled`, `started`, `degraded`
- `serviceName`, `serviceNamespace`, `environment`, `protocol`
- `endpointConfigured` (boolean — never the URL)
- `lastBootstrapAtUtc`, `lastBootstrapOutcome`, `lastBootstrapFailureCode`
- `lastExportErrorCode`
- `spansCreatedCount`
- `resourceAttributes` — bounded `service.name` / `service.namespace` / `deployment.environment` only

NEVER returns: endpoint URL, headers, Grafana token, raw env, or any token-bearing material.

## 7. Related documents

- `observability.md` — operator runbook for the observability stack.
- `deployment-hardening.md` — production deployment + token rotation.
- `phase-o1-1-otel-runtime-closure.md` — closure report.
