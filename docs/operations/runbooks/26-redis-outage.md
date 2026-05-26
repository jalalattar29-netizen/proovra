# Runbook 26 — Redis outage

## Symptoms
- BullMQ queues stall (no jobs processed).
- Rate-limit middleware falls through to memory-only mode (logs show "Redis unavailable").
- `/admin/runtime/readiness` `redis` subsystem reports CRITICAL.
- New job enqueue attempts fail.

## Blast radius
- **All async work** stalls: report generation, OTS upgrade, search indexing, evidence purge, retention reconciliation, destruction orchestration, MFA challenge GC, recovery digest emails.
- **Rate-limit fairness** weakens (memory-only mode is per-process, not cluster-wide). DEF-037 closures still apply but the bucket is per-API-instance rather than shared.
- **Synchronous API requests continue** (DB-backed paths are unaffected). Authentication, evidence read/write, capture, finalize, public verify — all keep working.
- **Custody / integrity / billing semantics** are UNAFFECTED.

## Detection
- `/admin/runtime/readiness` `redis: CRITICAL`.
- `/admin/runtime/queues` shows growing depth on every queue.
- BullMQ logs: `connection refused` / `ECONNREFUSED` on the worker side.
- Rate-limit service log: "Redis unavailable; falling back to memory store".

## Logs to inspect
- Worker logs filtered to BullMQ.
- Rate-limit service log (`services/api/src/services/rate-limit.ts`).
- Redis provider dashboard (Upstash / Render / etc.) for the incident timeline.

## Rollback procedure
None — Redis is a provider-managed dependency. The platform's behavior degrades gracefully; recovery is restoration of Redis.

## Safe recovery procedure
1. **Confirm the Redis provider is down** (provider dashboard).
2. **Confirm the platform's `REDIS_URL` is correct** (DEF-042 tracks the gap that this is not yet enforced in production startup; for this outage, manual verification).
3. **Wait for Redis to recover.** BullMQ + the rate-limit service both reconnect automatically. No restart required.
4. **Once recovered**: queues drain at the worker's normal concurrency. Lag is bounded by the outage duration × normal arrival rate.
5. **If queue depth remains elevated for > 30 min after recovery**: investigate worker logs for handler-level exceptions (the recovery itself may have surfaced latent bugs).
6. **For rate-limit fairness during the outage**: per-process buckets are 3-5× looser than the shared bucket. Operator may consider proactively reducing the per-process bucket constant if the outage extends.

## Validation steps
- `/admin/runtime/readiness` `redis: HEALTHY`.
- `/admin/runtime/queues` depths return to steady-state baseline within 1 hour.
- A test webhook delivery completes through the bounded retry runtime.
- A test rate-limited endpoint hit, refused after the bucket fills, then accepted after the window resets.

## Escalation conditions
- Redis outage > 30 min during business hours → customer-wide notification.
- BullMQ queue depth > 10× normal after Redis recovery → operator restart of the worker (runbook 03) + investigate.
- Rate-limit bypass observed during outage → DEF-037 closure invariant may have been compromised; investigate.

## DO NOT DO THIS
- Do NOT manually drain the queues. BullMQ handles drainage atomically.
- Do NOT change `REDIS_URL` to point to a different Redis instance "to recover" without coordinating: queues are tied to a specific Redis instance; switching means lost in-flight jobs.
- Do NOT disable rate-limit middleware. Memory-mode fallback is the documented degraded behavior; bypassing rate limits during an outage is an abuse opportunity.
- Do NOT bypass the BullMQ queue model by manually invoking handlers from the operator shell.
