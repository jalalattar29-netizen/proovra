# Phase O1.6 — Final Dashboards & Alerts Closure

**Status:** CLOSED. 11 dashboards, 11 + 23 alert rules (O1.2 baseline + O1.6 additions), contract-enforced.

## Scope

Trace-derived observability for every O1.5A/B/C/D/E business flow, plus
the executive rollup. Every panel and alert references a real emitted
span (from `PROOVRA_SPAN_NAMES`) or a real counter (from `COUNTER_NAMES`).

## Dashboards (10)

All live under `infra/grafana/dashboards/`:

| File | Domain | Panels |
| --- | --- | --- |
| `proovra-capture-evidence.json` | Capture session lifecycle + evidence create/upload/finalize/verify | 6 |
| `proovra-integrity.json` | Hash / canonical / signature / timestamp / public anchor verify + custody chain + TSA + OTS | 6 |
| `proovra-report.json` | Report generate / render html / render pdf / upload / publish | 4 |
| `proovra-verification-package.json` | Package generate / manifest / attestations / signer snapshot / zip / upload | 4 |
| `proovra-reviewer-ops.json` | Reviewer assignment create/complete + queue.build + console.load + reconcile | 6 |
| `proovra-graph.json` | Graph reconcile / timeline / domain.sync / search.projection + worker.graph.reconcile | 5 |
| `proovra-siu.json` | SIU export preflight + generate + followup.request + timeline.build | 5 |
| `proovra-ai.json` | AI chat + capture.review + support.response + openai.ai_request | 5 |
| `proovra-communications.json` | SMTP email_send + external.review.notify + webhook.dispatch | 6 |
| `proovra-executive-operations.json` | Cross-domain rollup: success ratios + top-line throughput + cross-domain failure rate + DLQ | 9 |

The 4 pre-existing O1.2 dashboards (`proovra-operations-overview.json`,
`proovra-queue-operations.json`, `proovra-exports-reproducibility.json`,
`proovra-recovery.json`) remain unchanged. Total provisioned: 14 JSON
files (contract-asserted).

Every panel uses one of two PromQL families:

1. **Span throughput / failure**: `traces_spanmetrics_calls_total{span_name="proovra.X.Y.Z"}` with optional `status_code="STATUS_CODE_ERROR"` filter, summed via `rate(...[5m])` for throughput or `increase(...[1h])` for ratios.
2. **Latency**: `histogram_quantile(0.95|0.99, sum by (le) (rate(traces_spanmetrics_duration_milliseconds_bucket{span_name="..."}[5m])))`.

A small subset also references the bounded counter registry (e.g., `dlq_job_total`, `queue_retry_failure_total`, `package_generation_failed_total`, `worker_stalled_total`) for legacy counter-based signals that pre-date span-metrics.

## Alerts (10 + 22 = 32)

`infra/grafana/alerts/proovra-operations-alerts.yaml` carries:

- **10 alerts from O1.2** (unchanged): api-down, worker-degraded, queue-failed-jobs-spike, export-failure-spike, package-generation-failure, recovery-validation-failure, siu-export-upload-failure, signer-health-degraded, forbidden-replay-attempted, pii-reveal-spike.
- **22 new O1.6 alerts** grouped into 6 bounded folders:
  - **proovra-infrastructure (3)**: redis-unavailable, queue-backlog-spike, queue-retry-failure-spike.
  - **proovra-integrity (4)**: signature-verify-failure, custody-chain-verify-failure, tsa-failure-spike, ots-failure-spike.
  - **proovra-report-package (4)**: report-generate-failure, report-upload-failure, package-upload-failure, package-attestation-degraded.
  - **proovra-reviewer-graph (3)**: reviewer-reconcile-failure, reviewer-assignment-backlog, graph-reconcile-failure.
  - **proovra-siu (2)**: siu-export-generate-failure, siu-followup-failure.
  - **proovra-ai (3)**: openai-failure-spike, openai-latency-elevated, ai-chat-rate-limited.
  - **proovra-communications (3)**: smtp-failure-spike, external-review-notify-failure, webhook-dispatch-failure.

Every alert rule carries:
- A real PromQL expression referencing only real spans / counters (asserted by `phase-o1-6-dashboard-coverage.test.ts`).
- A `for:` duration that suppresses sub-window noise.
- A `severity:` label (`critical` for evidence-grade integrity failures + report/package upload failures + Redis outage + signer-verify failures; `warning` for everything else).
- A `runbook_url:` pointing at a real anchor in `docs/operations/observability-runbooks.md` (asserted by the contract test).

**Thresholds are honest defaults.** Per the O1.2 baseline approach, every numeric threshold is conservatively set — operators MUST tune after a week of trace data establishes a real noise floor. No threshold here was fabricated to look precise.

## Runbooks

`docs/operations/observability-runbooks.md` now carries one anchor per
new alert (`## redis-unavailable`, `## signature-verify-failure`, etc.),
each with:

- A one-line condition restatement.
- A first-steps triage list (3-5 items, all bounded — no external system credentials).
- An explicit "false positive" note where the threshold can flap (e.g., Redis failover, TSA cert rotation).

## Contract test

`services/api/test/phase-o1-6-dashboard-coverage.test.ts` enforces:

1. All 11 O1.6 dashboard files exist, parse, have `schemaVersion: 37`, bounded `uid`/`title`, `proovra` + `o1.6` tags.
2. Every `span_name="proovra...."` / `span_name=~"proovra....*"` referenced in any dashboard panel maps to a real entry in `PROOVRA_SPAN_NAMES`.
3. Every counter token (`*_total` and histogram bucket / latency token) referenced in any dashboard maps to `COUNTER_NAMES` or an explicit auto-instrumentation allowlist (`traces_spanmetrics_*`, `up`).
4. The 23 new alert UIDs are present in the YAML.
5. Every alert has a `runbook_url:` and `severity:` annotation.
6. Every alert PromQL expression references only real spans + counters.
7. Every runbook anchor referenced by an alert exists in `observability-runbooks.md`.
8. No dashboard or alert references forbidden label keys (`email=`, `token=`, `secret=`, `rawPayload=`, `fileContent=`).
9. Every span-name family in `PROOVRA_SPAN_NAMES` is covered by at least one O1.6 dashboard (or is allowlisted as covered by an O1.2 dashboard).
10. The dashboards/ directory ships exactly 15 JSON files — guards against stale provisioning entries.

The contract test runs as part of the api test suite — total now **11,041 passing / 53 skipped**.

## Validation results

```
pnpm --filter proovra-api typecheck       → 0 errors  ✅
pnpm --filter proovra-worker typecheck    → 0 errors  ✅
pnpm --filter proovra-api test            → 11041 passed / 53 skipped  ✅
pnpm --filter proovra-worker test         → 559 passed  ✅
pnpm --filter proovra-worker build        → emitted cleanly  ✅
pnpm --filter proovra-web build           → emitted cleanly  ✅
```

A pre-existing `readiness-smoke.test.ts` regex (worker entrypoint
contract) was tightened during this phase to accept the post-O1.3
multi-line `new Worker(\n  queueName, wrapJobHandlerWithOtelContext(...))`
shape. The contract intent (every Worker is registered via
`safeRegisterWorker` with the same canonical processor) is unchanged.

## What is intentionally NOT in this phase

- **Custom Grafana folder layout** — every dashboard ships at the
  top level of `infra/grafana/dashboards/`. Grafana auto-provisions
  them under the configured datasource folder. No `folders.yaml` or
  per-dashboard folder targeting is added; that is operator config.
- **Per-tenant variables** — Phase G3-style PII boundary rules forbid
  surfacing org / team / actor IDs as dashboard templating variables.
  The one templating variable in `proovra-capture-evidence.json` is
  bounded (`service` ∈ {`proovra-api`, `proovra-worker`}).
- **Customer-facing SLA dashboards** — internal SLO model lives in
  `docs/operations/slo-model.md`. These are internal operator dashboards.
- **Alertmanager wiring** — provider config (PagerDuty / Slack /
  email) is operator-managed; this phase only declares rules + severities + runbook URLs.

## What is next

Phase O2 (Scale Readiness Program) follows — see
`docs/operations/phase-o2-scale-readiness.md` (to be authored as O2
closes). O1.6 is the final observability closure before scale work.
