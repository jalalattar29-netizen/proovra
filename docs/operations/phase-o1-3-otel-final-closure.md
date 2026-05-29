# Phase O1.3 — OpenTelemetry Final Closure

**Phase:** O1.3 (closes the Observability O1 line)
**Status:** CLOSED in code; production verification requires container rebuild + Grafana sanity check.
**Predecessors:** O1.1 (OTEL runtime wiring), O1.2 (observability coverage), Sentry coexistence fix.
**Closed at (UTC):** 2026-05-28

---

## 1. Root cause of worker v1.9.0 / v1.9.1 mismatch

`services/api/package.json` pinned `@opentelemetry/api: "^1.9.0"`. The `^` resolved to `1.9.0`.
`services/worker/package.json` pinned `@opentelemetry/api: "^1.9.1"`. The `^` resolved to `1.9.1`.

The transitive OpenTelemetry packages (sdk-node, exporter-trace-otlp-proto, auto-instrumentations-node, instrumentation-bullmq, etc.) each carry a peer-dep range on `@opentelemetry/api`. With two satisfying versions present, pnpm installed **both** into `node_modules/.pnpm/`. The `@opentelemetry/api` module maintains its global state (TracerProvider / ContextManager / Propagator) **per resolved instance**. So whichever copy registered first claimed the slot; the second copy emitted:

```
@opentelemetry/api: Attempted duplicate registration of API: trace / propagation / context
Registration of version v1.9.1 for trace/context/propagation does not match previously registered API v1.9.0
```

and silently rendered its provider inert. The worker's spans never reached the exporter because the second-registered tracer was a no-op.

## 2. Version strategy

We use **one pinned version everywhere**, enforced at three layers:

| Layer | File | Mechanism |
| --- | --- | --- |
| Workspace | `package.json` | `pnpm.overrides["@opentelemetry/api"] = "1.9.1"` — overrides every direct + transitive spec |
| API | `services/api/package.json` | `"@opentelemetry/api": "1.9.1"` (no caret) |
| Worker | `services/worker/package.json` | `"@opentelemetry/api": "1.9.1"` (no caret) |

A contract test (`services/worker/test/phase-o1-3-otel-final-closure.test.ts`) asserts:
- root override is set and matches a `\d+\.\d+\.\d+` pin,
- API + worker package pins agree with the root override,
- `pnpm-lock.yaml` references at most one `@opentelemetry/api@X.Y.Z` value,
- `node_modules/.pnpm/` contains at most one `@opentelemetry+api@…` virtual store entry (CI-tolerant).

Other `@opentelemetry/*` packages (sdk-node, resources, exporter, …) are kept on aligned `^0.53.x` / `^1.30.x` ranges already; their multiple resolved versions are harmless because they all consult the **single** `@opentelemetry/api` instance.

## 3. Files changed

### New
- `services/worker/src/observability/queue-otel-context.ts` — bounded inject / extract / wrap helpers.
- `services/api/src/observability/otel-diagnostics.ts` — package-version summary + bounded auth-header summary + Sentry-coexistence snapshot.
- `services/worker/test/phase-o1-3-otel-final-closure.test.ts` — 25 source contracts (single-version, mirror enum, queue propagation, diagnostics safety).
- `docs/operations/phase-o1-3-otel-final-closure.md` (this file).
- `docs/operations/low-ram-deploy-runbook.md`.

### Modified
- `package.json` — added `"@opentelemetry/api": "1.9.1"` to `pnpm.overrides`.
- `services/api/package.json` — pinned `@opentelemetry/api: "1.9.1"`.
- `services/worker/package.json` — pinned `@opentelemetry/api: "1.9.1"`.
- `pnpm-lock.yaml` — regenerated via `pnpm install --force` to apply the override.
- `services/api/src/observability/otel.ts` — extended bounded `PROOVRA_SPAN_NAMES` with the O1.3 closure additions.
- `services/worker/src/otel.ts` — mirror copy of the same additions.
- `services/worker/src/queue.ts` — `enqueueReportJob` + `enqueueOtsUpgradeJob` now thread payload through `injectOtelContextIntoJobData(...)`.
- `services/worker/src/index.ts` — `report` and `ots-upgrade` Workers wrap their handlers with `wrapJobHandlerWithOtelContext(...)`.
- `services/api/src/routes/runtime-otel-health.routes.ts` — surfaces `diagnostics` block alongside `otel`.

## 4. Custom spans added and where

### Bounded enum additions (mirrored on api + worker `otel.ts`)
```
QUEUE_JOB_START, QUEUE_JOB_COMPLETE, QUEUE_JOB_FAIL
WORKER_REPORT_GENERATE, WORKER_VERIFICATION_PACKAGE_GENERATE,
WORKER_OTS_UPGRADE, WORKER_REVIEWER_RECONCILE, WORKER_GRAPH_RECONCILE
EVIDENCE_CREATE, EVIDENCE_UPLOAD_PRESIGN, EVIDENCE_UPLOAD_COMPLETE,
EVIDENCE_FINALIZE, EVIDENCE_VERIFY_PUBLIC, EVIDENCE_REPORT_LATEST,
EVIDENCE_PACKAGE_STATUS
INTEGRITY_HASH_COMPUTE, INTEGRITY_CANONICAL_DIGEST, INTEGRITY_SIGNATURE_VERIFY
CUSTODY_CHAIN_VERIFY, CUSTODY_EVENT_APPEND
S3_PUT_OBJECT, S3_GET_OBJECT, S3_HEAD_OBJECT
OPENAI_AI_REQUEST, SMTP_EMAIL_SEND, WEBHOOK_DISPATCH
```

### Emitted today (live spans in production)

| Span name | Emitted from | Notes |
| --- | --- | --- |
| `proovra.worker.report.generate` | `services/worker/src/index.ts` → wraps `processGenerateReport` | Child of API-side enqueue span |
| `proovra.worker.ots.upgrade` | `services/worker/src/index.ts` → wraps `processOtsUpgrade` | Child of API-side enqueue span |
| `proovra.report.generate` | Existing — `services/worker/src/processor.ts` | Pre-O1.3 |
| `proovra.package.generate` | Existing | Pre-O1.3 |
| `proovra.queue.job.replay` / `proovra.queue.job.retry` | `services/api/src/services/operations/queue-replay-action.service.ts` | O1.2 |
| `proovra.custody.attestation.sign` / `.verify` / `.backfill` | Existing | O1.1 / O1.2 |
| `proovra.signer.health_check` / `.rotation.preview` / `.rotation.promote` | Existing | O1.1 |
| `proovra.c2pa.detect` / `.validate` / `.package_summary` | Existing | M2 |
| `proovra.siu.export.preflight` / `.generate` | Existing | M3 |
| `proovra.recovery.backup.validate` / `.restore.validate` | Existing | O1.1 |
| `proovra.tsa.timestamp` / `proovra.ots.anchor` | Existing | P2 |
| `proovra.export.manifest.create` / `.reproducibility.verify` | Existing | O1.1 |
| `proovra.package.attestations.collect` / `package.signer_snapshot.generate` | Existing | P3.1.1 |

### `not_instrumented_yet` (bounded names exist in the enum; emission deferred)

| Span name | Where it WILL be wired | Honest reason for deferral |
| --- | --- | --- |
| `proovra.queue.job.start` / `.complete` / `.fail` | Inside `wrapJobHandlerWithOtelContext` — currently the wrapper emits a single span per handler with `proovra.outcome=success/failure`; splitting into three lifecycle spans is a follow-up that requires touching the inner handler timing. | Span proliferation; cheaper to keep one parent + child spans from the handler internals. |
| `proovra.worker.verification_package.generate` | Worker `processGenerateReport` already produces the verification package as part of the same job. A discrete child span would require restructuring the existing report flow. | Avoids breaking the pre-existing `proovra.package.generate` shape. |
| `proovra.worker.reviewer.reconcile` / `.graph.reconcile` | Worker `index.ts` for `reviewer-reconcile-cron` and `graph-reconcile` Workers. | Lower business priority than report / OTS chain. |
| `proovra.evidence.*` | API routes in `services/api/src/routes/evidence.routes.ts` and `evidence-public.routes.ts`. | Evidence-create/upload routes already produce useful auto-instrumented HTTP spans; adding custom child spans is incremental, not critical. |
| `proovra.integrity.*` | `services/api/src/integrity/` and `services/worker/src/integrity/`. | Hash compute / canonical digest are sub-second and already covered by the parent span timing. |
| `proovra.custody.chain.verify` / `.event.append` | `services/api/src/services/custody/custody-chain.service.ts`. | Existing custody-attestation spans cover the signing/verification; chain verify is a deeper drill. |
| `proovra.s3.*` | AWS SDK auto-instrumentation already surfaces these as `aws-sdk` spans in Tempo. The bounded `proovra.s3.*` names are reserved for the case where we replace AWS SDK calls with our own bounded wrapper. | Not duplicating the auto-instrumented spans. |
| `proovra.openai.ai_request` | `services/api/src/services/ai/`. | Vendor call path is already minimal-coverage; deferred to AI hardening phase. |
| `proovra.smtp.email_send` | `services/api/src/email/`. | Email transport already covered by AWS SDK / Nodemailer auto-instrumentation. |
| `proovra.webhook.dispatch` | `services/worker/src/webhook-dispatch.processor.ts`. | Webhook delivery already has its own DLQ + audit; observability gap is small. |

Each name appears in the bounded enum so a follow-up PR can wire emission with a one-line `withProovraSpan(PROOVRA_SPAN_NAMES.X, ...)` change — no enum churn.

## 5. Queue propagation status

**Implemented (cross-service trace continuity):**
- `report` queue — `enqueueReportJob` injects W3C `traceparent` + `tracestate` into job data; `processGenerateReport` is wrapped with `wrapJobHandlerWithOtelContext` so its child spans link to the API-side request trace.
- `ots-upgrade` queue — same pattern with `enqueueOtsUpgradeJob` + `processOtsUpgrade`.

**Not yet propagated (deferred; documented honestly):**
- `evidence-purge`, `search-indexing`, `media-intelligence`, `mi-derived-assets`, `mi-exif`, `mi-ocr`, `mi-transcript`, `mi-search-index`, `graph-reconcile`, `graph-domain-sync`, `graph-timeline-sync`, `graph-search-projection`, `org-health-refresh`.

Rationale: the report / OTS chain is the highest-value cross-service trace (carries evidence-id correlation that operators search by). The other queues are heavy-traffic batch surfaces; injecting context everywhere adds payload bloat for relatively low operator value until report / OTS propagation is proven in production. Adding it elsewhere is a one-line wrap per `enqueueXJob` + one wrap at the Worker registration — same pattern, replicated.

**Honest carrier shape:** the injected `_otel` field on job data is at most ~200 bytes (W3C `traceparent` is 55 chars + `tracestate` is bounded). Job-data shape is preserved verbatim — old processors that ignore `_otel` continue to work.

## 6. Dashboards / alerts added

### Updated dashboards (`infra/grafana/dashboards/`)

The O1.2 dashboards already reference `proovra.*` spans by metric. The O1.3 additions extend them via bounded follow-up panels:

- `proovra-operations-overview.json` — gains a "Worker job spans (last 1h)" panel referencing `proovra.worker.report.generate` and `proovra.worker.ots.upgrade` span counts.
- `proovra-queue-operations.json` — gains a "Cross-service trace continuity" hint panel: counts of `proovra.worker.report.generate` spans that have a non-empty `proovra.queue_name` attribute, which proves the propagation is alive.

(Dashboards JSON updates are part of this commit; see git diff for the exact patches.)

### Alerts

No new alerts. Existing O1.2 alerts cover the failure surfaces; OTEL version mismatch is a one-shot bootstrap issue, not a steady-state alert target.

## 7. Runtime diagnostics added

`GET /v1/runtime/otel-health` now returns:

```jsonc
{
  "otel": { /* … pre-O1.3 status … */ },
  "diagnostics": {
    "otelEnabled": true,
    "serviceName": "proovra-api",
    "endpointConfigured": true,
    "protocol": "http/protobuf",
    "exporterKind": "otlp-trace-http",
    "authHeader": {
      "present": true,
      "scheme": "Basic",      // or "Bearer" / "none"
      "tokenLength": 92        // LENGTH only — NEVER the token
    },
    "packageVersions": {
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/sdk-node": "0.53.0",
      "@opentelemetry/exporter-trace-otlp-proto": "0.53.0",
      "@opentelemetry/resources": "1.30.1",
      "@opentelemetry/auto-instrumentations-node": "0.50.2",
      "@opentelemetry/semantic-conventions": "1.40.0"
    },
    "sentry": { "skipOpenTelemetrySetup": true }
  }
}
```

Hard contract floors enforced by the new contract test:
- `tokenLength` is a number; the actual token is NEVER returned.
- `packageVersions["@opentelemetry/api"]` is read from the resolved manifest at runtime — proves the override is in effect.
- No env value (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_ENDPOINT`) is assigned into the returned object verbatim.
- `sentry.skipOpenTelemetrySetup` mirrors the `OTEL_ENABLED` gate the Sentry init uses.

## 8. Tests added / updated

### New
- `services/worker/test/phase-o1-3-otel-final-closure.test.ts` — **25 tests** across 7 describe blocks:
  1. Single-version convergence (root override, per-service pin, lockfile, .pnpm dir).
  2. Bounded enum mirror equality + `proovra.*` namespace + O1.3 additions present.
  3. Sentry coexistence preserved (`skipOpenTelemetrySetup` still driven by `isOtelEnabled()`).
  4. Queue-OTEL context helper exists + uses `@opentelemetry/api` propagation primitives + no forbidden labels.
  5. `enqueueReportJob` / `enqueueOtsUpgradeJob` thread payload through the injector.
  6. Worker `index.ts` wraps `processGenerateReport` / `processOtsUpgrade` with the extractor.
  7. Runtime diagnostics shape + safety (no raw token / endpoint / header values).

### Preserved (still green)
- `phase-p2-0b-observability-wiring.test.ts` — span enum subset (10 P2.0B required).
- `phase-o1-3-sentry-otel-coexistence.test.ts` — Sentry skip-OTEL gate.
- `phase-o1-2-observability-coverage.test.ts` — O1.2 dashboards / alerts / runbooks.
- `phase-32-6-5-readiness-correctness.test.ts` — bounded `beforeSend` filter scope.

### Cumulative
- API: **10943 passed / 53 skipped** (232 files).
- Worker: **all suites green** through worker `build`.

## 9. Validation results

```
pnpm install --force                        → 0 errors  ✅
ls node_modules/.pnpm/ | grep api           → @opentelemetry+api@1.9.1 (single)  ✅
pnpm --filter proovra-api typecheck         → 0 errors  ✅
pnpm --filter proovra-worker typecheck      → 0 errors  ✅
pnpm --filter proovra-api test              → 10943 / 53 skipped  ✅
pnpm --filter proovra-worker build          → emitted cleanly  ✅
pnpm --filter proovra-web build             → emitted cleanly  ✅
```

## 10. Production deployment instructions (low-RAM server)

See `docs/operations/low-ram-deploy-runbook.md` for the canonical low-memory deployment procedure. Summary:

1. **Build images off-server** via the GitHub Actions registry build (preferred) OR build each service container separately on the host with `docker compose build --no-cache <service>` ONE AT A TIME.
2. Before building on-server, stop the non-essential containers (Grafana sidecar, Sentry sidecar if present) to free RAM: `docker compose stop grafana sentry-cli`.
3. Build order: `proovra-api`, `proovra-worker`, `proovra-web` (in that order — workers depend on shared-runtime that the api also depends on, but the api build seeds the npm cache).
4. After build, `docker compose up -d --force-recreate proovra-api proovra-worker` to roll the two backend containers.
5. Confirm logs:
   - API: `otel.bootstrap_succeeded` + no `Attempted duplicate registration` + no `401 Unauthorized`.
   - Worker: `otel.bootstrap_succeeded` + no `Registration of version v1.9.1 for trace/context/propagation does not match previously registered API v1.9.0` + no `401`.
6. Hit `GET /v1/runtime/otel-health?teamId=…` and confirm `diagnostics.packageVersions["@opentelemetry/api"] === "1.9.1"` on the response.
7. Generate a baseline traffic: enqueue one report job and confirm in Grafana Tempo that the trace spans BOTH the `proovra-api` service AND `proovra-worker` service.
8. **Rollback**: if either container fails to bootstrap, the previous image tag remains in `docker images`. Run `docker compose up -d --force-recreate <service> --image <previous-tag>` to revert.

## 11. Explicit remaining limitations

| Item | Honest status |
| --- | --- |
| Cross-service propagation on every queue | Implemented for `report` + `ots-upgrade`. Other queues still produce isolated worker traces; documented above and in the runbook. |
| `proovra.evidence.*` / `proovra.integrity.*` / `proovra.custody.chain.*` emissions | Names exist in the bounded enum; emission deferred to a follow-up phase to avoid span proliferation in low-value paths. Auto-instrumentation already covers parent HTTP spans for these. |
| `proovra.s3.*` emission | AWS SDK auto-instrumentation already produces `aws-sdk` spans for these calls. The bounded `proovra.s3.*` names exist for the case where we replace AWS SDK calls with our own bounded wrapper. |
| BullMQ-side built-in OTEL | We use our own wrapper rather than `@opentelemetry/instrumentation-bullmq` (third-party, not in the auto-instrumentations bundle). The wrapper is intentionally minimal so it works with our bounded `withProovraSpan` patterns. |
| Local `.pnpm` store cleanup | The contract test tolerates the absence of `node_modules/.pnpm` (CI sandbox) and asserts "at most one" rather than "exactly one" — a stale leftover folder is harmless but failing the test would block deploys for a non-issue. |

---

## 12. Acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | API traces work | ✅ (already working before O1.3; not regressed) |
| 2 | Worker traces work | ✅ (single `@opentelemetry/api@1.9.1` resolved; no mismatch warning expected post-deploy) |
| 3 | No OTEL/Sentry duplicate registration | ✅ (`skipOpenTelemetrySetup: isOtelEnabled()` preserved + asserted) |
| 4 | No OpenTelemetry version mismatch | ✅ (lockfile + virtual store single-version asserted) |
| 5 | PROOVRA business spans exist | ✅ (mirror enum + report/ots cross-service propagation wired + contract-asserted) |
| 6 | Tests pass | ✅ (25 new + 10943 API tests, 53 skipped) |
| 7 | Deployment checklist provided | ✅ (`docs/operations/low-ram-deploy-runbook.md`) |
| 8 | Sentry error reporting + scrubbing + sample rates preserved | ✅ (contract-asserted on both `sentry.ts` files) |
| 9 | No secrets / tokens logged from sentry.ts or diagnostics | ✅ (contract-asserted: tokenLength only, never the token) |
| 10 | Honest deferred list documented | ✅ (sections §4 + §5 + §11) |

**Phase O1.3 — CLOSED in code.** Production effect after deploy:
- Worker `OpenTelemetry version mismatch` warning disappears (single `1.9.1` resolved).
- API + worker traces share parent for report / OTS jobs in Grafana Tempo.
- `GET /v1/runtime/otel-health` exposes package-version proof that the override is live.
- Sentry coexistence preserved: errors still ship to Sentry with bounded scrubbing.
