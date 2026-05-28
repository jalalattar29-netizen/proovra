# PROOVRA Observability Runbooks (Phase O1.2)

**Audience:** PROOVRA on-call engineers responding to alerts from `infra/grafana/alerts/proovra-operations-alerts.yaml`.

Every section maps to an alert rule's `runbook_url`. Headings are anchor-stable so the alert links resolve without editing.

---

## api-down

**Alert:** `proovra-api-down` (severity `critical`).

**Condition:** `avg_over_time(up{job="proovra-api"}[2m]) < 0.5`.

**First steps:**

1. Hit `https://api.proovra.com/health` directly from the operator workstation. If 200, the alert is a scrape-side problem; check Prometheus / agent connectivity.
2. If 5xx or timeout, log into the api container:
   ```
   docker logs docker-proovra-api-1 --tail 200 | grep -iE 'fatal|crash|listen|otel.bootstrap_'
   ```
3. Confirm port `8080` is bound; restart the container with `up -d --force-recreate proovra-api` if the process is gone.
4. If restart loops, roll back to the previous image tag.

**False positives:** scheduled deploys (`docker compose up -d --force-recreate`) briefly drop the scrape. Threshold `for: 2m` mitigates.

## worker-degraded

**Alert:** `proovra-worker-degraded` (severity `warning`).

**Condition:** `worker_heartbeat_missing_total` increased in the last 5 minutes.

**First steps:**

1. Inspect worker container logs for the bounded heartbeat warnings:
   ```
   docker logs docker-proovra-worker-1 --tail 200 | grep -iE 'heartbeat|stalled|otel.bootstrap_'
   ```
2. Check Redis connectivity (`PING` from inside the worker container).
3. If BullMQ reports stalled jobs, restart the worker: `docker compose up -d --force-recreate proovra-worker`.

**False positives:** Redis cluster failovers can briefly increment the counter; threshold `for: 5m` mitigates.

## queue-failures

**Alert:** `proovra-queue-failed-jobs-spike` (severity `warning`).

**Condition:** `rate(dlq_job_total[10m]) > 1` for any queue.

**First steps:**

1. Inspect the failing queue in the operations console.
2. Use the bounded `replayCategory` from the replay-safety matrix before touching the job — DO NOT mass-replay failed jobs without confirming category.
3. If `replayCategory == "forbidden"`, leave the job in the DLQ and escalate.
4. If `replayCategory == "safe"`, retry one job manually first; if it succeeds, retry the rest.

## export-failures

**Alert:** `proovra-export-failure-spike` (severity `critical`).

**Condition:** combined `export_generation_failed_total + siu_export_failed_total` rate > 0.05/s for 15m.

**First steps:**

1. Check Object Lock status — `GET /v1/operations/exports/object-lock`. A `claimed-but-unsupported` mode degrades every export.
2. Check the signer health probe — `GET /v1/operations/signers/:id/health`. A degraded signer fails the manifest-signing step.
3. Tail the worker logs for `package-generation-failure` / `siu-export-upload` lines.

**False positives:** brief AWS KMS throttling. Re-check after 5 minutes; clear the alert if the failure rate has dropped.

## package-generation-failures

**Alert:** `proovra-package-generation-failure` (severity `critical`).

**Condition:** `rate(package_generation_failed_total[15m]) > 0.05`.

**First steps:**

1. Confirm the worker is up (`/health`).
2. Check S3 health — the package builder reads evidence bytes + writes the ZIP.
3. Inspect the worker's recent OTEL spans for `proovra.package.generate` errors via Grafana → Tempo.

## recovery-validation-failures

**Alert:** `proovra-recovery-validation-failure` (severity `warning`).

**Condition:** any `recovery_validation_failed_total` increase in 30m.

**First steps:**

1. Fetch the latest recovery report via `GET /v1/operations/recovery/reports`.
2. Read the bounded `unsupportedDomains` list — PROOVRA's DR scope is intentionally bounded.
3. If the failed validation is in scope (backup hash sampling / restore hash sampling / Object Lock readiness), follow the same escalation path as a degraded signer or S3 incident.

## siu-export-upload-failure

**Alert:** `proovra-siu-export-upload-failure` (severity `critical`).

**Condition:** any `siu_export_upload_failure_total` increase in 5m.

**First steps:**

1. Check S3 connectivity from the api container.
2. Inspect the failed `CaseSiuExport` row's bounded `errorCode` / `errorMessage`. Common codes: `siu_export_storage_unconfigured` (env), `siu_export_upload_failed` (network/IAM).
3. If the bucket env is misconfigured, set `S3_BUCKET` and re-create the api container.

## c2pa-backfill-failure

**Alert:** `proovra-c2pa-backfill-failure` (severity `warning`).

**Condition:** `rate(c2pa_backfill_failed_total[15m]) > 0.05`.

**First steps:**

1. Confirm `C2PA_ENABLED=true` and `C2PA_BIN` is set + reachable in the worker container.
2. Inspect the backfill run via `GET /v1/operations/c2pa/backfill/:runId`.
3. Cancel the run if the failure rate is sustained, and investigate the underlying tooling.

## signer-health-degraded

**Alert:** `proovra-signer-health-degraded` (severity `critical`).

**Condition:** any `signer_health_degraded_total` increase in 5m.

**First steps:**

1. Hit `GET /v1/operations/signers/:id/health` and read the bounded `state` (`degraded` / `unreachable` / `permission_denied` / `key_disabled` / `region_mismatch` / `unsupported_algorithm` / `unknown`).
2. For `permission_denied` or `region_mismatch`, fix the env / IAM and re-create the api container.
3. For `unreachable`, check the KMS endpoint reachability from the api container.

## forbidden-replay-attempted

**Alert:** `proovra-forbidden-replay-attempted` (severity `warning`).

**Condition:** any `queue_replay_forbidden_total` increase in 5m.

**First steps:**

1. Inspect the security event log for the bounded `queue_job_replay_forbidden` rows — the actor + reason are recorded.
2. If an operator attempted a forbidden replay, follow up with them; this is a hard refusal, not a bug.
3. If the same actor produces repeated `forbidden` attempts, treat as a possible account compromise.

## siu-pii-reveal-spike

**Alert:** `proovra-pii-reveal-spike` (severity `warning`).

**Condition:** `rate(siu_pii_revealed_total[30m]) > 0.05`.

**First steps:**

1. Cross-check the `siu_pii_revealed` audit-log rows for the actor + capability + bounded reason.
2. If a single actor is responsible, contact them — bounded `SIU_PII_REVEAL` step-up means each reveal is intentional, but a sustained spike is unusual.
3. If multiple actors are seeing reveals at once, escalate to the security on-call lead.
