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

---

# Phase O1.6 — trace-derived alert runbooks

The sections below back the new alert rules added in Phase O1.6 (see
`infra/grafana/alerts/proovra-operations-alerts.yaml`). Every section
maps a stable anchor to an alert UID. **Thresholds are honest defaults
— operators MUST tune them after a week of trace data establishes a
real noise floor.** No threshold here is fabricated to look precise.

## redis-unavailable

**Alert:** `proovra-redis-unavailable` (severity `critical`).

**Condition:** `avg_over_time(up{job=~"proovra-redis|redis"}[2m]) < 0.5`.

**First steps:**

1. `docker compose ps redis` (or the prod equivalent) — confirm the container is running.
2. From inside the api container: `redis-cli -h $REDIS_HOST ping`.
3. If Redis is down, BullMQ producers buffer briefly then fail. Restart Redis; if it loops, restore from snapshot. Worker + presence + idempotency caches all rely on Redis.

**False positives:** Redis failover during a maintenance window — confirm via the deploy log before paging.

## queue-backlog-spike

**Alert:** `proovra-queue-backlog-spike` (severity `warning`).

**Condition:** `rate(worker_stalled_total[10m]) + rate(queue_job_stalled_total[10m]) > 0.05`.

**First steps:**

1. Open `PROOVRA — Queue Operations` dashboard and identify the queue producing stalls.
2. Check the worker container's recent OTEL spans for `proovra.queue.job.*` errors.
3. If a single queue is stalling, consider increasing worker concurrency or partitioning — see `docs/operations/phase-o2-scale-readiness.md` (when O2.2 closes).

## queue-retry-failure-spike

**Alert:** `proovra-queue-retry-failure-spike` (severity `warning`).

**Condition:** `rate(queue_retry_failure_total[15m]) > 0.05`.

**First steps:**

1. Inspect the Queue Operations console — operator retries should succeed when the underlying handler is healthy.
2. If retries are failing, the root cause is the handler, not the retry path — follow `queue-failures` runbook for the affected queue.

## signature-verify-failure

**Alert:** `proovra-signature-verify-failure` (severity `critical`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.integrity.signature.verify",status_code="STATUS_CODE_ERROR"}[10m]) > 0.05`.

**First steps:**

1. A failure here means signed evidence/package material is failing verification. Treat as integrity incident.
2. Pull the failing trace from Tempo: filter `span_name="proovra.integrity.signature.verify"` `status.code=ERROR`. The bounded `proovra.operation` attribute identifies which surface (evidence verify / package verify / external review).
3. If the failure is sustained, freeze the affected signer (`POST /v1/operations/signers/:id/rotation/promote` to swap), and notify the on-call signer governance lead.

## custody-chain-verify-failure

**Alert:** `proovra-custody-chain-verify-failure` (severity `critical`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.custody.chain.verify",status_code="STATUS_CODE_ERROR"}[10m]) > 0.05`.

**First steps:**

1. Custody chain verification failures indicate either tampered material OR a hashing-pipeline bug in `evaluateCustodyChain`.
2. Pull the failing trace; bounded attributes identify the evidence ID family without leaking PII.
3. Cross-check `evidence_integrity_rejections_total` — coordinated rises suggest A0 hash hard-gate is doing its job; isolated rises here suggest a chain-evaluation regression.

## tsa-failure-spike

**Alert:** `proovra-tsa-failure-spike` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name=~"proovra.tsa\\..*",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. TSA provider outage is the most common cause. Check the configured TSA endpoint reachability.
2. The integrity pipeline tolerates short TSA outages — timestamps are added asynchronously. Sustained outage means new evidence ships without a timestamp until recovery.
3. If the TSA endpoint is reachable but failing, check whether the TSA's certificate has rolled and our trust store needs an update.

## ots-failure-spike

**Alert:** `proovra-ots-failure-spike` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name=~"proovra.ots\\..*",status_code="STATUS_CODE_ERROR"}[30m]) > 0.05`.

**First steps:**

1. OpenTimestamps anchor/upgrade/verify failures usually mean a calendar server outage. Threshold deliberately tolerates 30m because OTS is best-effort.
2. Check `ots_upgrade_failed_total` and `ots_upgrade_pending_total` to distinguish "permanently failed" from "still pending".
3. If a specific calendar is down, the worker should retry; if all calendars are down, anchor work backs up — drain manually via `pnpm --filter proovra-worker exec ts-node scripts/ots-upgrade-sweep.ts` once recovered.

## c2pa-validate-failure

**Alert:** `proovra-c2pa-validate-failure` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.c2pa.validate",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. Confirm `C2PA_ENABLED=true` and `C2PA_BIN` resolves inside the worker container.
2. C2PA validate failures during ingest are expected for malformed manifests — the pipeline records the failure and continues. Sustained failures across multiple evidence items indicate a tooling regression.
3. Inspect the bounded `proovra.stage` attribute on the failing span to see whether the failure is during detect, validate, or summary.

## report-generate-failure

**Alert:** `proovra-report-generate-failure` (severity `critical`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.report.generate",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. Open `PROOVRA — Report Pipeline` dashboard. Latency p95/p99 should still be valid even if generate is failing.
2. Tail the worker logs for the `proovra.worker.report.generate` parent span and the children that failed (`render.html`, `render.pdf`, `upload`, `publish`).
3. Common causes: missing Puppeteer/Chromium in the worker image; S3 outage during `report.upload`; the report-renderer crashed because a Matter is missing a required field.

## report-upload-failure

**Alert:** `proovra-report-upload-failure` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.report.upload",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. Almost always an S3 / IAM issue at the worker. Run `aws s3 ls s3://<bucket>` from the worker container.
2. If S3 is healthy, confirm Object Lock is not blocking writes (`GET /v1/operations/exports/object-lock`).

## package-upload-failure

**Alert:** `proovra-package-upload-failure` (severity `critical`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.package.upload",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. Verification packages are evidence-grade artifacts. A sustained upload-failure spike means new packages are not durably stored — escalate to ops on-call.
2. Same triage as `report-upload-failure` but the impact tier is higher: external reviewers and public verify both consume packages.

## package-attestation-degraded

**Alert:** `proovra-package-attestation-degraded` (severity `warning`).

**Condition:** combined `package_attestations_degraded_total + package_attestation_generation_failure_total` rate > 0.05/s for 30m.

**First steps:**

1. Open the failing package via `GET /v1/operations/packages/:id`. Bounded `attestationStatus` will be `degraded` or `missing`.
2. The package still ships but with weaker assurance. Confirm the underlying attestation source (TSA / OTS / signer snapshot) is healthy via its own runbook before clearing.

## reviewer-reconcile-failure

**Alert:** `proovra-reviewer-reconcile-failure` (severity `warning`).

**Condition:** `rate(reviewer_reconcile_failed_total[15m]) > 0.05` OR span-derived equivalent.

**First steps:**

1. Reviewer reconcile is the loop that catches stuck/abandoned reviewer state. Failures here mean reviewer SLA + queue accuracy can drift.
2. Inspect recent traces for `proovra.reviewer.reconcile` — bounded attributes identify the workspace family without leaking org info.
3. If the failure is a DB timeout, the reconciler will retry on the next interval; a sustained pattern suggests a query plan regression.

## reviewer-assignment-backlog

**Alert:** `proovra-reviewer-assignment-backlog` (severity `warning`).

**Condition:** combined `reviewer_queue_pressure_total + reviewer_assignment_overload_detected_total` rate > 0.1/s for 30m.

**First steps:**

1. Open `PROOVRA — Reviewer Ops` dashboard; `assignment.create` rate should exceed `assignment.complete` for the spike to be real.
2. Most common cause: a workspace pushed a large intake batch with no reviewer capacity added. Coordinate with the workspace owner; consider raising reviewer capacity.
3. If the pressure is platform-wide, check whether the assignment engine is throttled by external SLA policy updates.

## graph-reconcile-failure

**Alert:** `proovra-graph-reconcile-failure` (severity `warning`).

**Condition:** `rate(graph_reconcile_failed_total[15m]) > 0.05` OR span-derived equivalent.

**First steps:**

1. Graph reconcile failures degrade search/timeline projections but do NOT block evidence ingest or report generation. Treat as warning, not critical.
2. Check the worker logs for `proovra.worker.graph.reconcile` span errors. Bounded `proovra.stage` attribute identifies the affected projection (`domain.sync`, `timeline.build`, `search.projection`).
3. If a single projection is failing, the reconciler will retry; persistent failure of a single domain usually means a schema drift between the domain table and the projection.

## siu-export-generate-failure

**Alert:** `proovra-siu-export-generate-failure` (severity `critical`).

**Condition:** span-derived OR `rate(siu_export_failed_total[15m]) > 0.05`.

**First steps:**

1. Same as `siu-export-upload-failure` but for the generation step. Bounded `errorCode` on the failed `CaseSiuExport` row distinguishes preflight failures from bundler failures from storage failures.
2. If the failure is preflight (`siu_export_preflight_failed`), the export is blocked because evidence is incomplete — not an outage. Coordinate with the operator.

## siu-followup-failure

**Alert:** `proovra-siu-followup-failure` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.siu.followup.request",status_code="STATUS_CODE_ERROR"}[30m]) > 0.05`.

**First steps:**

1. Follow-up request failures usually mean a notification path (email + webhook) is down. Cross-check `smtp-failure-spike` and `webhook-dispatch-failure`.
2. The follow-up record persists even if the notification fails — operators see the queued follow-up in the SIU workspace.

## openai-failure-spike

**Alert:** `proovra-openai-failure-spike` (severity `warning`).

**Condition:** `rate(traces_spanmetrics_calls_total{span_name="proovra.openai.ai_request",status_code="STATUS_CODE_ERROR"}[15m]) > 0.05`.

**First steps:**

1. OpenAI outage or rate limiting. AI is non-blocking — chat and capture review degrade gracefully (the `ai.chat` / `ai.capture.review` parent spans still emit; only the inner `openai.ai_request` fails).
2. If sustained, consider disabling AI via the feature flag (`AI_ENABLED=false`) until upstream recovers.

## openai-latency-elevated

**Alert:** `proovra-openai-latency-elevated` (severity `warning`).

**Condition:** `histogram_quantile(0.95, ... proovra.openai.ai_request ...) > 15000` (ms) for 15m.

**First steps:**

1. Confirm the spike is OpenAI-side (Anthropic / Azure dashboards for similar regions).
2. Reduce concurrent AI calls if necessary; the timeout for an AI request is set to a bounded value — check the `ai_chat_timeout_total` counter for breaches.

## ai-chat-rate-limited

**Alert:** `proovra-ai-chat-rate-limited` (severity `warning`).

**Condition:** `rate(ai_chat_rate_limited_total[15m]) > 0.1`.

**First steps:**

1. Per-user rate limit is working as designed for abuse-resistance (see A3.2). A sustained spike means either a real abuse attempt OR a UI bug retrying too aggressively.
2. Inspect the rate-limit rejections — bounded `actorId` in the SecurityEvent rows identifies hot offenders.

## smtp-failure-spike

**Alert:** `proovra-smtp-failure-spike` (severity `warning`).

**Condition:** span-derived OR `rate(communication_message_failed[15m]) > 0.05`.

**First steps:**

1. Check Resend (or configured SMTP provider) status page.
2. If a single account/workspace is the source, the rate limit may be account-scoped at the provider; coordinate accordingly.
3. PROOVRA does NOT retry SMTP sends in-line for evidence-grade communications (intentional — duplicates are worse than misses). The queued retry path runs out-of-band.

## external-review-notify-failure

**Alert:** `proovra-external-review-notify-failure` (severity `warning`).

**Condition:** span-derived OR `rate(external_review_grant_issue_failed_total[15m]) > 0.05`.

**First steps:**

1. The grant + notification step issues the external reviewer token + signals the workflow. A failure here means the external reviewer cannot start review.
2. Bounded `errorCode` on the failed grant identifies whether the failure was governance-blocked (legit denial) vs. infrastructure.

## webhook-dispatch-failure

**Alert:** `proovra-webhook-dispatch-failure` (severity `warning`).

**Condition:** span-derived OR `rate(webhook_delivery_failed[15m]) > 0.05`.

**First steps:**

1. Inspect the webhook destination — most failures are remote-side 5xx or timeouts.
2. PROOVRA retries webhook delivery with exponential backoff (bounded), tracked by `webhook_processing_failed_total`. A sustained failure that survives the retry budget means the destination is unhealthy.
3. Do NOT replay webhook deliveries by hand — replays for webhook are in the `forbidden` replay category.
