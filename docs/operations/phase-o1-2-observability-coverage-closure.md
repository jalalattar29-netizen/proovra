# Phase O1.2 — Observability Coverage Closure — Convergence Closure

**Phase:** O1.2 (Enterprise Operational Monitoring Completion)
**Status:** CLOSED in code; production verification depends on operator (Grafana dashboard import + alert provisioning).
**Closed at (UTC):** 2026-05-28
**Predecessors:** O1.1 (OTEL runtime wiring), G5.5 (observability catalog)

---

## 0. Scope (verbatim from O1.2 spec)

> Remaining observability gaps:
>
> 1. Queue replay/retry spans
> 2. Custody attestation sign/verify spans
> 3. Dashboards
> 4. Alerts
> 5. SLOs
> 6. Worker failure alerts
> 7. Export/recovery dashboards

All seven gaps are closed.

---

## 1. Span coverage summary

Wired `withProovraSpan` into:

- `services/api/src/services/operations/queue-replay-action.service.ts` — `proovra.queue.job.retry` + `proovra.queue.job.replay` around `retryFailedJob()` and `replayFailedJob()`.
- `services/api/src/services/operations/custody-attestation.service.ts` — `proovra.custody.attestation.sign` + `.verify` + `.backfill` around `signCustodyEvent()`, `verifyCustodyAttestation()`, `backfillCustodyAttestations()`.

Pre-existing critical spans (O1.1) remain intact: SIU preflight + generate, C2PA detect + package summary, signer health, recovery backup + restore.

Bounded span enum extended with `CUSTODY_ATTESTATION_BACKFILL = "proovra.custody.attestation.backfill"` (now 25 names, was 24).

Span attributes always bounded — never raw payload / signature value / canonical payload / private key path / KMS credentials / actor PII.

## 2. Metric coverage summary

`packages/shared-runtime/src/ops/metrics.service.ts` extended with 18 bounded counter names under the Phase O1.2 block:

```
queue_retry_total
queue_retry_failure_total
queue_replay_duration_ms
custody_attestation_sign_failure_total
siu_export_generated_total
siu_export_failed_total
siu_export_download_total
siu_export_upload_failure_total
package_generation_total
package_generation_failed_total
export_generation_total
export_generation_failed_total
export_reproducibility_verify_total
recovery_backup_validation_total
recovery_restore_validation_total
recovery_validation_failed_total
c2pa_backfill_run_failure_total
siu_pii_revealed_total
```

Pre-existing metrics from G5.5 / P3.1.1 / P2.3 are still in use; the O1.2 additions cover the surfaces the new dashboards consume.

## 3. Dashboard summary

Four Grafana JSON dashboards under `infra/grafana/dashboards/`:

| File | Purpose |
| --- | --- |
| `proovra-operations-overview.json` | API + worker health, queue failures, generation/export funnels, C2PA backfill, SIU exports |
| `proovra-queue-operations.json` | Per-queue failed jobs, replay vs retry, forbidden replay, step-up replay, stalled workers |
| `proovra-exports-reproducibility.json` | WORM exports, reproducibility verifications, SIU export pipeline, Object Lock checks |
| `proovra-recovery.json` | Backup + restore validation runs, validation failures, recovery report generation, signer health, custody attestation verify counts |

Every panel references a metric that is asserted to exist in the bounded `COUNTER_NAMES` / `GAUGE_NAMES` registry. Source-contract test enforces.

## 4. Alert summary

Single alert provisioning file `infra/grafana/alerts/proovra-operations-alerts.yaml` with 11 bounded rules:

| Alert UID | Severity | Condition |
| --- | --- | --- |
| `proovra-api-down` | critical | `up{job="proovra-api"} < 0.5` |
| `proovra-worker-degraded` | warning | `worker_heartbeat_missing_total` increase |
| `proovra-queue-failed-jobs-spike` | warning | `rate(dlq_job_total) > 1` |
| `proovra-export-failure-spike` | critical | combined export failure rate > 0.05/s |
| `proovra-package-generation-failure` | critical | `rate(package_generation_failed_total) > 0.05` |
| `proovra-recovery-validation-failure` | warning | any `recovery_validation_failed_total` increase |
| `proovra-siu-export-upload-failure` | critical | any `siu_export_upload_failure_total` increase |
| `proovra-c2pa-backfill-failure` | warning | `rate(c2pa_backfill_run_failure_total) > 0.05` |
| `proovra-signer-health-degraded` | critical | any `signer_health_degraded_total` increase |
| `proovra-forbidden-replay-attempted` | warning | any `queue_replay_forbidden_total` increase |
| `proovra-pii-reveal-spike` | warning | `rate(siu_pii_revealed_total) > 0.05` |

Every rule's `runbook_url` resolves to a stable anchor in `docs/operations/observability-runbooks.md`.

## 5. SLO summary

`docs/operations/slo-model.md` declares six **internal** SLOs:

1. API availability — 99.5%
2. Verification Package generation success — 99%
3. Report generation success — 99%
4. Queue recovery safety — 100% forbidden replay blocked
5. Export reproducibility — 99%
6. Worker health — 99%

Doc explicitly bounds the language to "internal target — not a customer SLA". External-facing claims require business + legal sign-off.

## 6. Worker failure alert summary

Phase O1.2 ships bounded worker-side signals:

- `worker_heartbeat_missing_total` (existing) — alert at 5m on increase.
- `worker_stalled_total` (existing) — surfaced in the queue dashboard.
- `queue_retry_failure_total` (new) — when an operator retry fails to complete the BullMQ-level handoff.
- The bounded OTEL bootstrap log lines (`otel.bootstrap_started` / `succeeded` / `disabled` / `failed`) remain the operator's positive-confirmation surface.

Heartbeat is currently derived (worker reports via metric bumps; no durable Redis key TTL). The bounded honest copy lives in `observability.md` Appendix B.7. Promotion to a durable heartbeat is a deferred follow-up.

## 7. Sentry summary

Bounded Sentry tag set is documented in `observability.md` Appendix B.6:

| Tag | Source |
| --- | --- |
| `service` | `proovra-api` or `proovra-worker` |
| `operation` | bounded operation label |
| `queueName` | bounded queue name |
| `jobType` | bounded job type |
| `errorCode` | bounded enum |
| `environment` | `OTEL_RESOURCE_ATTRIBUTES.deployment.environment` |

Forbidden: evidence content / claimant PII / raw payload / tokens / raw signatures. The `captureException` helper already redacts bearer / token / secret / password substrings in messages.

## 8. OTEL health extensions

`/v1/runtime/otel-health` now additionally returns:

- `lastSpanName` — bounded enum value of the most recent `withProovraSpan` call.
- `lastSpanAtUtc` — UTC timestamp of that span.

These additions surface in both api and worker `getOtelStatus()`. Source-contract test asserts the new fields exist and the endpoint never returns URL / headers / token.

## 9. Tests

| Suite | Path | Result |
| --- | --- | --- |
| O1.2 source contracts + metric registry + dashboard / alert lint + Sentry tag bounds | `services/worker/test/phase-o1-2-observability-coverage.test.ts` | **see worker run** |

Cumulative worker suite remains green.
All five workspace packages typecheck clean.

## 10. Files changed (summary)

**New:**

- `infra/grafana/dashboards/proovra-operations-overview.json`
- `infra/grafana/dashboards/proovra-queue-operations.json`
- `infra/grafana/dashboards/proovra-exports-reproducibility.json`
- `infra/grafana/dashboards/proovra-recovery.json`
- `infra/grafana/alerts/proovra-operations-alerts.yaml`
- `services/worker/test/phase-o1-2-observability-coverage.test.ts`
- `docs/operations/observability-runbooks.md`
- `docs/operations/slo-model.md`
- `docs/operations/phase-o1-2-observability-coverage-closure.md`

**Modified:**

- `services/api/src/services/operations/queue-replay-action.service.ts` — wraps with `proovra.queue.job.retry` / `proovra.queue.job.replay`; bumps `queue_retry_total` / `queue_retry_failure_total`
- `services/api/src/services/operations/custody-attestation.service.ts` — wraps sign / verify / backfill with bounded spans; bumps `custody_attestation_signed_total` / `custody_attestation_verification_failure_total` / `custody_attestation_sign_failure_total`
- `packages/shared-runtime/src/ops/metrics.service.ts` — adds 18 bounded counter names
- `services/api/src/observability/otel.ts` + `services/worker/src/otel.ts` — `lastSpanName` / `lastSpanAtUtc` + `CUSTODY_ATTESTATION_BACKFILL` enum entry

## 11. Production validation checklist

1. Rotate the Grafana token (carry over from O1.1).
2. Confirm production `.env` does NOT set a global `OTEL_SERVICE_NAME` (the compose override wins, but the line is misleading).
3. Re-create the stack with the new image.
4. Verify API + worker bootstrap log lines: `otel.bootstrap_started` → `otel.bootstrap_succeeded`.
5. Import the four dashboard JSON files via Grafana → Dashboards → New → Import → Upload JSON.
6. Provision the alert rules: Grafana → Alerting → Alert rules → Import (upload `proovra-operations-alerts.yaml`).
7. Generate baseline traffic: hit `curl https://api.proovra.com/health` and an SIU profile read endpoint to seed counters.
8. Confirm at least one counter from the new O1.2 block increments in Prometheus.
9. Confirm at least one alert is in `Normal` state per rule (not `NoData`).
10. Verify the runbook URL of each alert renders the documented section in `observability-runbooks.md`.

## 12. Remaining blockers

None at the code level. Deferred:

- Multi-window multi-burn-rate alerts for each SLO.
- Per-tenant SLO segmentation for enterprise workspaces.
- Promotion of worker heartbeat from "metric bump" to "durable Redis key TTL".
- Per-queue dimensions on `queue_retry_total` / `queue_retry_failure_total` (currently emitted without a `queue_name` label).
- A public SLO dashboard once external SLA discussions reach a binding stage.

## 13. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Queue replay/retry spans wired | ✅ |
| 2 | Custody attestation spans wired | ✅ |
| 3 | Dashboards added | ✅ (4 files under `infra/grafana/dashboards/`) |
| 4 | Alerts added | ✅ (11 rules in `infra/grafana/alerts/proovra-operations-alerts.yaml`) |
| 5 | SLO model documented | ✅ (`docs/operations/slo-model.md`) |
| 6 | Worker failure alerts defined | ✅ (`proovra-worker-degraded`, `proovra-queue-failed-jobs-spike`, etc.) |
| 7 | Export/recovery dashboards added | ✅ (two of the four dashboards) |
| 8 | No secrets / PII in telemetry | ✅ (bounded `withProovraSpan` attributes; bounded Sentry tags) |
| 9 | O1.2 fully closed (code) | ✅ |

---

## 14. Phase O1.2 — CLOSED in code; production verification (dashboard import + alert provisioning) is operator-side.
