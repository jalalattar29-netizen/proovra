# SRE runbooks — operator procedures

> Operator procedures for the most common operational conditions. Each
> section names the **real** endpoint, worker, or queue involved so the
> on-call can act without guessing. This document does not assert any
> uptime or SLA target.

Live readiness for the whole platform: `/operations/readiness`
(platform-admin) and `GET /admin/runtime/readiness` (per-subsystem).

---

## 1. Report / OTS queue backlog

**Symptom:** report PDFs or OpenTimestamps anchoring are not
completing; queue depth climbing.

**Where to look:**
- `GET /v1/operations/queues` (route:
  `services/api/src/routes/operations-queues.routes.ts`) — queue depth,
  active/failed/delayed counts, and replay safety.
- The `queues` subsystem in `GET /admin/runtime/readiness` derives a
  coarse signal from open `WORKER`-category `OperationalIncident` rows
  (`services/api/src/runtime/runtime-readiness.ts`, `checkQueues`).

**Procedure:**
1. Confirm Redis is reachable — the `redis` subsystem in the readiness
   report performs a live ping. If `CRITICAL`, fix `REDIS_URL`
   reachability first; BullMQ cannot drain without it.
2. Inspect failed jobs / DLQ via the queues surface. Use the existing
   replay path (`queue_replay_*`) — do **not** hand-mutate jobs.
3. For a wedged worker tick, see **worker-wedged.md**.

---

## 2. Immutable-storage drift detected

**Symptom:** DB believes an evidence record is immutable but S3 Object
Lock metadata disagrees (or vice versa).

**Where to look:**
- The `immutable-storage-reconciliation` worker
  (`services/worker/src/governance/immutable-storage-reconciliation.worker.ts`)
  runs on a sweep, writes an `OperationalIncident`, and bumps
  `immutable_storage_drift_open`.

**Procedure:**
1. Follow the detailed steps in **immutable-drift.md** (containment
   → root cause → recovery). Object Lock changes are operator-only via
   the AWS CLI; the application intentionally exposes no runtime
   endpoint to alter immutable semantics.
2. After remediation, run the reconciliation worker once and confirm
   `immutable_storage_drift_open` returns to 0.
3. Confirm the `s3_object_lock` subsystem in the readiness report is
   `HEALTHY` and Object Lock live status reads `verified`.

---

## 3. Webhook destination auto-disabled

**Symptom:** an integration webhook stopped receiving deliveries; it
was automatically disabled after repeated failures.

**Where to look:**
- Auto-disable logic lives in
  `services/api/src/services/integrations/webhooks.service.ts`. A
  destination is disabled after a sustained failure streak so a dead
  endpoint does not accumulate an unbounded retry backlog.

**Procedure:**
1. Confirm the destination URL is reachable and returns 2xx to a manual
   test delivery.
2. Verify the signing secret at the destination matches (invalid
   signatures are a common cause — see
   **webhook-invalid-signature-burst.md**).
3. Re-enable the destination through the integrations surface once the
   endpoint is healthy. Deliveries resume from the point of
   re-enablement; historical failed deliveries are not silently
   replayed.

---

## 4. Worker heartbeat missing

**Symptom:** the `workers` subsystem reports `DEGRADED`
(`no_recent_reconcile` / `stale_reconcile`) — no recent reviewer
reconciliation heartbeat observed.

**Where to look:**
- `checkWorkers` in `services/api/src/runtime/runtime-readiness.ts`
  reads the `WORKER_HEARTBEAT` `SecurityEvent` written by the
  reviewer-reconcile loop.
- Note the built-in **startup grace window**: a freshly started API
  reports `worker_warming` (HEALTHY) until ~2× the reconcile interval,
  so a fresh deploy is not a false alarm.

**Procedure:**
1. If `reconcile_cron_secret_missing`: neither `REVIEWER_OPS_CRON_SECRET`
   nor `INTEGRATION_CRON_SECRET` is set on the API env, so the worker
   cannot authenticate the reconcile endpoint. Set one on **both** the
   API and worker, then restart both.
2. Otherwise confirm the worker process is running, that
   `REVIEWER_OPS_RECONCILIATION_ENABLED` is true, and that
   `INTERNAL_API_BASE_URL` on the worker points at the API.
3. See **worker-wedged.md** for a wedged (running but not ticking)
   worker.

---

## Escalation

If a load-bearing subsystem (`database`, `schema`, `s3_object_lock`,
`redis`) is `CRITICAL` and the steps above do not clear it, escalate
per your incident policy. Capture the full
`GET /admin/runtime/readiness` payload — every subsystem carries a
bounded `reasonCode`, `detail`, and `remediationHint` for triage.
