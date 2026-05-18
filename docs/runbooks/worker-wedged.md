# Runbook — Worker wedged / queue not draining

**Failure modes:** FM-Q-001 (duplicate delivery), FM-Q-002 (startup race).
**Alerts:** `queue_oldest_pending_age`, `queue_backlog_high`, `stuck_destruction_executions`.

## What this means

Jobs are entering the queue faster than the worker drains them, OR
the worker is crash-looping. Possible drivers:
- Worker container is restarting (startup race FM-Q-002).
- A job is poison-pilling the processor (one body throws repeatedly).
- BullMQ delivered the same job twice and the idempotent guard is
  doing what it should — but the rate of duplicates spiked.
- Redis or Postgres is slow.

## First action (under 60s)

```bash
# Check worker container status
docker compose ps proovra-worker

# Worker heartbeat health (Phase Y)
curl -s "$API_BASE/v1/ops/metrics" | grep worker_heartbeat
curl -s "$API_BASE/v1/ops/metrics" | grep queue_oldest_pending_age
```

If `worker_heartbeat_total` is not incrementing, the worker is dead.
If it's incrementing but `queue_oldest_pending_age_seconds` is high,
the worker is alive but slow or stuck.

## Triage

**Is the worker crash-looping?**

```bash
docker compose logs --tail 200 proovra-worker
```

Look for repeated `Error: ECONNREFUSED` or `api-readiness timed out`
messages — that's FM-Q-002 (startup race). The api-readiness gate
should prevent this; if it's tripping, the api healthcheck itself is
failing.

**Is a specific job stuck?**

Check `DestructionExecution` for non-terminal rows older than a few
minutes:

```sql
SELECT id, "reviewId", status, attempt, "startedAt"
FROM "DestructionExecution"
WHERE status NOT IN ('COMPLETED','FAILED','ROLLED_BACK')
  AND "startedAt" < NOW() - INTERVAL '10 minutes';
```

For BullMQ:

```bash
redis-cli --no-raw KEYS "bull:*:wait" | xargs -n1 -I{} redis-cli LLEN {}
```

## Containment

If a specific job kind is poison-pilling, pause the queue (BullMQ
admin) and let the others drain. The destruction orchestrator is
idempotent — pausing and resuming is safe.

If the worker is crash-looping on startup, hold replicas at 0 until
the api is healthy.

## Root cause

The worker is designed for failure tolerance:
- `api-readiness.ts` performs an in-process readiness check with
  exponential backoff + jitter; the worker won't start any
  startup-triggered fetch until `/readyz` returns 200.
- `docker-compose` declares `proovra-api: service_healthy` as a
  worker dependency.
- `parseQueueEnvelope` accepts both raw legacy bodies and the canonical
  envelope, so a deploy that flips envelope adoption doesn't poison-
  pill the in-flight queue.
- Each governance worker writes a `GovernanceReconciliationRun` row at
  start and end; an orphan "started but not ended" row indicates the
  worker died mid-flight.

Common root causes:
- Redis network partition.
- Postgres advisory lock contention (audit chain inserts serialize
  through `ADMIN_AUDIT_ADVISORY_LOCK_KEY`).
- A specific evidence record's metadata exceeds the canonical-JSON
  depth cap and trips a recomputation loop.

## Recovery

1. If a poison job is identified, move it to the DLQ via the BullMQ
   admin and open an OperationalIncident with the job payload.
2. If the worker died mid-flight, kill any stale
   `GovernanceReconciliationRun` row by flipping it to
   `status = 'FAILED'` with an operator note. The next sweep will
   pick up the same set with a fresh run id.
3. Restart the worker. Confirm `worker_heartbeat_total` is
   incrementing.

## Postmortem checklist

- [ ] Identify the poison job (if any) and add a regression to the
      processor that surfaces the error to the DLQ rather than crash.
- [ ] Confirm api-readiness was queried at boot (see worker startup
      logs).
- [ ] Confirm the queue drained back below the alert threshold.
- [ ] If duplicates were involved, confirm `idempotencyKey` was set on
      the canonical envelope.
