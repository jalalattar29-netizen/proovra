# Runbook 03 — Worker restart recovery

**Scope:** restart the worker process and confirm that all DB-backed work resumes correctly, with explicit awareness of which work is restart-safe and which is not.

**Prerequisites:**

- Operator access to the worker deployment surface.
- Read access to `/admin/runtime/workers` and `/admin/runtime/queues`.

**Forbidden:**

- Restarting the worker while a finalize / signature / timestamp operation is mid-flight unless an Ops decision has explicitly accepted the per-record consequence (the operation will resume from its DB-backed state and may produce a degraded status for the affected record).
- Bypassing the BullMQ queue model by manually invoking handlers from the operator shell.

---

## What survives a worker restart

| Subsystem | Survives? | Recovery mechanism |
|---|---|---|
| Webhook delivery state (`AutomationWebhookDelivery`) | YES | DB-backed status + `nextAttemptAt`; `sweepDueRetries()` picks up RETRY_SCHEDULED rows on next tick |
| Automation runs (`AutomationRun`) | YES | DB-backed status + idempotency unique index |
| Custody events | YES | Append-only DB rows |
| Security events | YES | Append-only DB rows |
| Queue jobs in BullMQ | YES | Redis-persisted (provided Redis didn't restart too) |
| MFA challenge GC | YES | Cron-driven; next tick drains backlog |
| MFA recovery digest | YES | Per-day idempotency; failed sends retried next tick |
| Object Lock retention | YES | Bucket-enforced; not worker state |
| In-process `setInterval` schedulers | NO (paused while down; resume on restart) | Worker boot re-arms them |
| `setTimeout` retries scheduled within a sweep window | NO (lost on crash; see DEF-025) | Next `sweepDueRetries()` tick recovers the underlying DB row |

## Steps

1. **Snapshot health before restart.**
   - `GET /admin/runtime/readiness` — record subsystem rollup.
   - `GET /admin/runtime/queues` — record per-queue depths.
   - `GET /admin/runtime/workers` — record last heartbeat timestamp.

2. **Drain enqueue if possible.**
   - If the deployment surface allows SIGTERM with a grace period, send SIGTERM and wait for the worker to flush BullMQ in-flight jobs (BullMQ honors graceful shutdown by default).
   - Note: at the time of writing (DEF-026), there is no explicit application-level drain for in-flight webhook deliveries. Active `DELIVERING` rows on crash are recovered by `sweepDueRetries()` after boot.

3. **Restart the worker process.**
   - Stop + start through the deployment console (Railway / Render / Fly / k8s deployment / direct host).
   - Confirm the worker process is back up.

4. **Confirm boot-time checks.**
   - Worker log shows `bootstrapObjectLockVerification()` succeeded (or printed dev-only warning).
   - Worker log shows `runStartupConfigValidation()` did not throw.

5. **Confirm heartbeat resumed.**
   - Within `WORKER_HEARTBEAT_INTERVAL` (default 5 min), `GET /admin/runtime/workers` shows a fresh heartbeat.
   - `GET /admin/runtime/readiness` rolls up `workers: HEALTHY`.

6. **Confirm queue drain.**
   - `GET /admin/runtime/queues` queue depths return to a steady-state baseline.
   - If any queue stays above baseline for more than 2x the queue's nominal processing window, investigate the per-queue handler.

7. **Confirm webhook retry sweep ran.**
   - Wait for at least one `sweepDueRetries()` tick.
   - In the DB, no `AutomationWebhookDelivery` row remains in `DELIVERING` state for longer than the bounded delivery timeout (5 s) + sweep interval. Rows that were `DELIVERING` at crash time should now be either `SUCCEEDED`, `FAILED`, `RETRY_SCHEDULED`, or `RETRY_EXHAUSTED`.

8. **Sign off.**
   - Record the restart in the Ops log.
   - If any subsystem rolled up CRITICAL post-restart, do not consider the restart successful; escalate.

---

## Failure modes + recovery

- **Worker fails to boot due to Object Lock misconfiguration** — fix the bucket configuration; do NOT set `OBJECT_LOCK_VERIFICATION_BYPASS=true` in production.
- **Worker fails to boot due to missing env var** — re-check the deployment env. `runStartupConfigValidation()` lists which var failed.
- **Heartbeat does not resume within 2x interval** — worker crashed silently. Check process logs, check Redis connectivity, check DB connectivity.
- **Queue depth keeps growing post-restart** — handler is throwing. Inspect the per-queue handler logs; check the operational incident table for `WORKER` category entries.
