# Queue Operations (Phase P2.3 + P2.4)

**Audience:** SRE / platform engineers triaging worker pipeline failures.

**Canonical path:** `/operations/queues`.

---

## 1. What this surface gives operators

A single screen that exposes BullMQ queue state in operator-safe form:

- Per-queue counts: waiting / active / delayed / failed / completed
- Stalled job detection (jobs whose worker lost the lock)
- Worker health badges
- Failed-job list with replay-safety classification per row
- Replay / retry / cancel actions with step-up gating

No raw Redis, no raw BullMQ internals, no stack-trace dumps.

## 2. Backend contract

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/operations/queues?teamId` | inventory of all 17 known queues |
| GET | `/v1/operations/queues/workers?teamId` | health derived from queue state |
| GET | `/v1/operations/queues/replay-safety?teamId` | bounded matrix |
| GET | `/v1/operations/queues/:queueName/failed?teamId&limit` | failed-job listing |
| POST | `/v1/operations/queues/:queueName/jobs/:jobId/retry` | retry (requires reason) |
| POST | `/v1/operations/queues/:queueName/jobs/:jobId/replay` | replay (requires reason + step-up where applicable) |
| POST | `/v1/operations/queues/:queueName/jobs/:jobId/cancel` | remove (requires reason) |

## 3. Replay safety matrix (canonical)

See `services/api/src/services/operations/queue-replay-safety.service.ts` for the source of truth. Categories:

| Category | What it means | UI affordance |
| --- | --- | --- |
| `safe` | Idempotent or upsert-only. Re-run produces same result. | Replay button (no step-up). |
| `requires_step_up` | Idempotent but with side-effects worth confirming (PDF signing, blockchain anchor). | Replay button + step-up modal. |
| `forbidden` | Mutates state irreversibly. NEVER replay. | No button; operator-facing copy points to audit center. |
| `unknown` | Job kind not in matrix. | No button; refuse server-side. |

## 4. Failed-job sanitisation

- Stack traces are **sanitised**: absolute Windows / Unix paths are replaced with `<path>`, and the result is truncated to 800 chars.
- Failure reason is similarly path-scrubbed and capped at 240 chars.
- Job payload data is NOT echoed in the listing. Only "safe refs" (`teamId`, `evidenceId`, `matterId`) are surfaced when present.

## 5. Audit + metrics

- Audit events: `queue_job_replay_attempted`, `queue_job_replay_succeeded`, `queue_job_replay_failed`, `queue_job_replay_forbidden`, `queue_worker_stalled_detected`.
- Metrics: `queue_replay_total`, `queue_replay_forbidden_total`, `queue_replay_safe_total`, `queue_replay_step_up_total`, `dlq_job_total`, `worker_stalled_total`, `worker_heartbeat_missing_total`.

## 6. Operating procedure — replay a safe job

1. Open `/operations/queues`.
2. Click the queue card with the failed-job count > 0.
3. Inspect the failed-jobs table. The "Replay safety" badge tells you what's allowed.
4. Click **Replay** on a `safe` row. Enter a reason ("upstream API recovered after incident X").
5. Click **Replay** (or **Retry attempt** if you want a single-attempt re-try without resetting the chain).
6. The audit event chain is emitted; the row disappears once BullMQ picks the job up.

## 7. Honest scope

- Worker heartbeat timestamps are not persisted today; the worker logs heartbeat to stdout. The UI shows "missing" via derived signals (queue unreachable, jobs older than 5 minutes in the waiting list).
- The `replay` and `retry` route paths both call BullMQ's `job.retry()` under the hood. The distinction is operator vocabulary — `replay` signals "I believe the cause is resolved", `retry` signals "let it have another attempt".
