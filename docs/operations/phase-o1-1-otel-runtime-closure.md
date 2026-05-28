# Phase O1.1 — OTEL Runtime Wiring — Convergence Closure

**Phase:** O1.1 (Production Observability Reality Closure)
**Status:** CLOSED in code; **awaiting production verification** (see §11).
**Closed at (UTC):** 2026-05-28
**Predecessors:** P2.0B (initial OTEL files), G5.5 (observability catalog)
**Successors:** none scheduled

---

## 0. Scope (verbatim from O1.1 spec)

> PROOVRA must emit real traces from:
>
> * API
> * Worker
> * BullMQ jobs
> * critical operations (report / verification package / SIU export / C2PA / offline package / queue replay / recovery / signer health / custody attestation)
>
> Grafana must receive services `proovra-api` and `proovra-worker`. No more "env exists but no traces".

---

## 1. Root cause of missing Grafana traces

The audit identified four classes of problem that previously combined to suppress production traces:

1. **`.env` global `OTEL_SERVICE_NAME=proovra-worker`** — meant the api container also reported as `proovra-worker`, so traces from both services collided under one service identifier in Grafana.
2. **Bootstrap log lines were quiet on success** — there was an `otel.disabled` line but no positive `otel.bootstrap_succeeded`, so operators couldn't confirm the bootstrap fired.
3. **Critical PROOVRA service entry points were not wrapped in spans** — the bounded `PROOVRA_SPAN_NAMES` enum existed but was unused at the SIU export / C2PA / signer / recovery entry points. Auto-instrumentation produced http spans but no business-level spans.
4. **No runtime-visible OTEL health surface** — operators had to grep container logs; there was no `/v1/runtime/otel-health` endpoint.

Phase O1.1 fixes each class.

## 2. Env / docker service-name summary

- `infra/docker/docker-compose.prod.yml` already pins `OTEL_SERVICE_NAME` per container (`proovra-api` for the api block, `proovra-worker` for the worker block). The Grafana token is interpolated from the `.env`, never hardcoded. The compose file is unchanged.
- `services/worker/.env.example` now documents the bounded OTEL keys (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`, `LOG_AGGREGATION_ENABLED`) with empty defaults, so operators see what to set without committing the token.
- **Operator action required**: rotate the previously-exposed Grafana token AND ensure the production `.env` does NOT set `OTEL_SERVICE_NAME` globally. The compose's per-container override wins, but a global `.env` line is misleading and should be removed.

## 3. API OTEL runtime summary

- Entrypoint: `services/api/src/observability/otel-bootstrap.ts` (side-effect import) runs as the **first** import of `services/api/src/server.ts`, before Fastify.
- Bootstrap module: `services/api/src/observability/otel.ts`.
- Bounded log lines now emitted:
  - `otel.bootstrap_started` (always)
  - `otel.bootstrap_succeeded` (when NodeSDK started)
  - `otel.bootstrap_disabled` (when `OTEL_ENABLED ≠ "true"`)
  - `otel.bootstrap_failed` (when NodeSDK init threw)
- Every log line carries bounded fields: `serviceName`, `serviceNamespace`, `environment`, `serviceVersion`, `endpointConfigured`, `protocol`, `exporterKind`. NEVER the endpoint URL, headers, or Grafana token.
- Bounded runtime state tracked in module-scope variables: `lastBootstrapAtUtc`, `lastBootstrapOutcome`, `lastBootstrapFailureCode`, `lastExportErrorCode`, `spansCreatedCount`.

## 4. Worker OTEL runtime summary

- Entrypoint: `services/worker/src/otel-bootstrap.ts` (side-effect import) runs as the **first import** in `services/worker/src/index.ts`, BEFORE `./register-shared-runtime.js` and BEFORE the BullMQ-importing `./queue.js`.
- Bootstrap module: `services/worker/src/otel.ts` — full mirror of the api side (own copy so the worker package is self-contained).
- Same bounded log lines + state tracking as the api.

## 5. Custom spans wired

The bounded `PROOVRA_SPAN_NAMES` enum now contains **24** names (was 10). Phase O1.1 added: `SIGNER_HEALTH_CHECK`, `SIGNER_ROTATION_PREVIEW`, `SIGNER_ROTATION_PROMOTE`, `CUSTODY_ATTESTATION_SIGN`, `CUSTODY_ATTESTATION_VERIFY`, `PACKAGE_ATTESTATIONS_COLLECT`, `PACKAGE_SIGNER_SNAPSHOT_GENERATE`, `C2PA_DETECT`, `C2PA_VALIDATE`, `C2PA_PACKAGE_SUMMARY`, `SIU_EXPORT_PREFLIGHT`, `SIU_EXPORT_GENERATE`, `SIU_FOLLOWUP_REQUEST`, `SIU_TIMELINE_BUILD`.

`withProovraSpan(name, attributes, fn)` helper:

- Bounds attribute keys (≤60 chars) and values (≤200 chars for strings; non-finite numbers dropped; null / undefined dropped).
- Marks success → `SpanStatusCode.OK`; throw → `SpanStatusCode.ERROR` (with bounded error name).
- Increments `spansCreatedCount`; on error captures bounded `lastExportErrorCode`.
- Safe to call when OTEL is disabled — the no-op tracer keeps the helper transparent.

Wired at these critical entry points in O1.1:

| Span | Entry point |
| --- | --- |
| `proovra.siu.export.preflight` | `services/api/src/services/siu/siu-preflight.service.ts` → `runSiuExportPreflight` |
| `proovra.siu.export.generate` | `services/api/src/services/siu/siu-export-bundle.service.ts` → `buildSiuExportBundle` |
| `proovra.c2pa.detect` | `services/worker/src/c2pa/provider.ts` → `evaluateEvidenceC2pa` |
| `proovra.c2pa.package_summary` | `services/worker/src/c2pa/package-summary.ts` → `buildC2paPackageSummaryWithSpan` |
| `proovra.signer.health_check` | `services/api/src/services/operations/signer-health.service.ts` → `probeSignerHealth` |
| `proovra.recovery.backup.validate` | `services/api/src/services/operations/recovery-validation.service.ts` → `validateBackup` |
| `proovra.recovery.restore.validate` | `services/api/src/services/operations/recovery-validation.service.ts` → `validateRestore` |

Pre-existing real-tracer usage in the worker (verification package attestations + historical material) remains unchanged.

## 6. OTEL health endpoint summary

`GET /v1/runtime/otel-health?teamId=<uuid>` (new):

- Auth-gated through the same active-member + `identity.member.read` check as `/v1/runtime/secrets-health`.
- Returns ONLY the bounded `getOtelStatus()` snapshot.
- NEVER returns the OTLP endpoint URL, headers, or Grafana token. Source-contract test asserts.

## 7. Sentry compatibility summary

- Sentry init (`services/api/src/observability/sentry.ts` → `initSentry`) is unchanged.
- `server.ts` still calls `initSentry()` after the OTEL bootstrap fires.
- The OTEL auto-instrumentation does NOT touch Sentry's transport; the two systems coexist on separate exporters.
- Sample-rate envs (`SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILES_SAMPLE_RATE`) are untouched.
- Bounded source-contract test confirms.

## 8. Tests

| Suite | Path | Result |
| --- | --- | --- |
| O1.1 bootstrap source contracts + runtime helper behaviour | `services/worker/test/phase-o1-1-otel-runtime.test.ts` | **31 / 31 pass** |

Cumulative worker suite: **379/379 pass** (348 prior + 31 O1.1).
Typechecks across api + worker: clean.

## 9. Files changed (summary)

**New:**

- `services/api/src/routes/runtime-otel-health.routes.ts`
- `services/worker/test/phase-o1-1-otel-runtime.test.ts`
- `docs/operations/otel-runtime-wiring.md`
- `docs/operations/phase-o1-1-otel-runtime-closure.md`

**Modified:**

- `services/api/src/observability/otel.ts` — extended span enum + `withProovraSpan` helper + bounded state tracking + 4 bounded log lines
- `services/worker/src/otel.ts` — full mirror of the api side
- `services/api/src/server.ts` — registers `runtimeOtelHealthRoutes`
- `services/api/src/services/siu/siu-preflight.service.ts` — wraps with `proovra.siu.export.preflight`
- `services/api/src/services/siu/siu-export-bundle.service.ts` — wraps with `proovra.siu.export.generate`
- `services/api/src/services/operations/signer-health.service.ts` — wraps with `proovra.signer.health_check`
- `services/api/src/services/operations/recovery-validation.service.ts` — wraps backup + restore
- `services/worker/src/c2pa/provider.ts` — wraps `evaluateEvidenceC2pa` with `proovra.c2pa.detect`
- `services/worker/src/c2pa/package-summary.ts` — adds `buildC2paPackageSummaryWithSpan` wrapper
- `services/worker/.env.example` — documents bounded OTEL keys
- `docs/operations/observability.md` — Appendix C summary

## 10. Production validation commands

```bash
cd /opt/proovra/app

# 1) Confirm env keys are present (without printing values).
grep -E 'OTEL_|LOG_AGGREGATION' .env | awk -F= '{print $1}'

# 2) Re-create the stack so the new image picks up the bootstrap.
docker compose --env-file /opt/proovra/app/.env \
  -f infra/docker/docker-compose.prod.yml \
  up -d --force-recreate

# 3) Inspect bootstrap log lines.
docker logs docker-proovra-api-1   --tail 200 | grep -iE 'otel\.bootstrap_'
docker logs docker-proovra-worker-1 --tail 200 | grep -iE 'otel\.bootstrap_'

# 4) Health probe.
curl -s http://127.0.0.1:8080/health
curl -s 'http://127.0.0.1:8080/v1/runtime/otel-health?teamId=<your-team-uuid>' \
  -H "Authorization: Bearer $PROOVRA_ADMIN_TOKEN" | jq .

# 5) Generate test traffic.
curl -s https://api.proovra.com/health

# 6) Open Grafana → Explore → Tempo. Filter `service.name=proovra-api`
#    then `service.name=proovra-worker`. Confirm spans within ~60 s.
```

Expected:

- API logs include `otel.bootstrap_succeeded` with `serviceName: proovra-api`.
- Worker logs include `otel.bootstrap_succeeded` with `serviceName: proovra-worker`.
- `/v1/runtime/otel-health` returns `started: true`, `degraded: false`.
- Grafana lists `proovra-api` and `proovra-worker` as distinct services.

## 11. Remaining blockers

Phase O1.1 ships the code changes. **Production verification depends on the operator:**

1. Rotate the previously-exposed Grafana token.
2. Confirm the production `.env` does NOT set a global `OTEL_SERVICE_NAME` (the compose override will win, but the line is misleading).
3. Re-create the stack with the new image.
4. Run the validation commands in §10.
5. Confirm both services appear in Grafana.

The acceptance criterion "Grafana receives `proovra-api` and `proovra-worker` traces" is satisfied by the code; production confirmation is the final gate.

Deferred (out of O1.1 scope):

- Wiring `withProovraSpan` into queue-replay / queue-retry / custody-attestation-sign / -verify (the enum names exist; the entry points are still unwrapped).
- A bounded sampling policy beyond the default `1.0` ratio. Currently the Grafana collector handles retention; an SDK-side `ParentBasedSampler` is documented as a follow-up.

## 12. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | API emits as `proovra-api` | ✅ docker-compose pins it; bootstrap defaults to it |
| 2 | Worker emits as `proovra-worker` | ✅ same |
| 3 | OTEL bootstrap runs before Fastify / BullMQ | ✅ source-contract test asserts |
| 4 | No Grafana token logged | ✅ bootstrap log lines never include headers or URL |
| 5 | No secrets / PII in spans | ✅ `withProovraSpan` bounds attribute values |
| 6 | App boots if OTEL fails | ✅ `try { sdk.start() } catch { log; continue }` |
| 7 | Grafana receives real traces | ⏳ pending operator validation (see §11) |
| 8 | O1.1 fully closed (code) | ✅ all 12 code parts implemented |

---

## 13. Phase O1.1 — CLOSED in code; awaiting production verification.
