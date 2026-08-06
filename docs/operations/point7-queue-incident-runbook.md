# PHASE 12 — POINT 7: Production queue incident runbook (owner-operated)

**Status: `OWNER_PRODUCTION_QUEUE_INCIDENT_AUDIT_PENDING`.**
No production system has been contacted by this investigation. The steps below
require credentials that only the owner can issue.

## The two events

| | Issue | Time (CEST) | Tag | Stack | Transaction |
|---|---|---|---|---|---|
| A | `630a6b0c05a946018acb6279a6b26841` | 2026-08-05 03:47:28 | `job_kind=graph-reconcile` | `processPurgeDeletedEvidence` | `GET /health` |
| B | `0bf44308342249e1bedcb863b09c07f1` | 2026-08-05 04:18:53 | `job_kind=evidence-purge` | `processPurgeDeletedEvidence` | `GET /health` |

Both failed at `prisma.evidence.findUnique({ where: { id: undefined } })`.

## What the code says, before any production data is read

Three findings from the current worktree. They narrow the question; they do not
answer it.

**1. The TAG is trustworthy. The TRANSACTION is not.** *(corrected — an
earlier revision of this document had it the other way round.)*

Tracing the worker's actual capture path settles which half of each event can
be believed:

* `job_kind` reaches Sentry through `captureException(err, { jobKind })` in the
  `workerInstance.on("failed")` handler, where `jobKind` is the **closure
  variable naming the queue that worker instance serves**, and the capture
  already ran inside `Sentry.withScope`. It cannot be inherited from an earlier
  job. `job_kind=graph-reconcile` therefore means the graph-reconcile queue's
  worker reported this failure.
* The transaction is NOT set by that path at all. It is whatever span was
  active in the process, and on a mostly-idle worker that is the last health
  probe — which is why both events read `GET /health`. That part is genuine
  attribution bleed and it is what made the first reading of these events go
  wrong.

`setSentryCorrelationContext` — the function the earlier revision blamed — is
never called anywhere in the worker's job path. It could not have been the
cause of anything observed here.

Fixed in this pass, at both places the bleed occurs:
* `captureException` now runs inside `Sentry.startNewTrace` +
  `Sentry.withIsolationScope` and sets an explicit `queue.<name>` transaction,
  so a background failure can no longer be filed under an HTTP request.
* `wrapJobHandlerWithOtelContext` — the single seam every BullMQ handler in the
  worker passes through — now runs each job inside
  `runJobWithTelemetryContext`, so anything captured *while* a job runs gets
  that job's own isolation scope and span.

**1b. So the routing question is now SHARPER, not closed.**
A `processPurgeDeletedEvidence` stack reported by the graph-reconcile queue is
a pairing the current tree cannot produce: `graphReconcileWorker` is
constructed with `processGraphReconcileJob`, that function reaches
`reconcileTeamGraph` and the graph-search-projection enqueue and nothing else,
and the strict decoder rejects a job whose `name` does not match the registered
work name (`job_name_mismatch`) before any handler runs. Either the deployed
build wires those queues differently, or two queue names collide in it. Both
are version-skew, and both are answered by the same evidence.

**2. The CURRENT code cannot produce `id: undefined`.**
`processPurgeDeletedEvidence` decodes through `decodeCanonicalJob`, which
rejects a missing `commandId`, an unknown schema version, an unknown field and a
name mismatch — every one of them before the first database read. A malformed
payload cannot reach Prisma from this build.

**3. Therefore the failing worker is running an OLDER build.**
The `undefined` reaching Prisma is the signature of the pre-Point-5 tolerant
parser, which synthesised what a payload was missing. That is consistent with —
and is the strongest available evidence for — the version-skew hypothesis:

```text
current-tree producer (local test process, before the isolation fix)
  → production Upstash Redis (inherited REDIS_URL)
  → canonical payload { commandId, schemaVersion, … }
  → OLDER deployed production worker
  → reads legacy body.evidenceId → undefined
  → Prisma validation error
```

**This remains a hypothesis.** It is consistent with every observation and it is
not proven, because proving it requires reading the two jobs' actual payload
shapes and creation timestamps — which needs the owner.

## What the owner must run

### Option 1 — read-only credential (preferred)

Create a Redis role that can `GET`/`HGETALL`/`ZRANGE`/`LRANGE`/`TYPE` and
nothing else, then:

```bash
P7_PRODUCTION_QUEUE_READONLY_URL="rediss://<readonly-user>:<pw>@<host>:<port>" node services/api/scripts/p7-queue-incident-collector.mjs --out p7-queue-incident.json
```

The collector refuses to start without that variable and will not fall back to
`REDIS_URL` or anything in `.env`. It issues only read commands, records
metadata and **hashed** identifiers, and never writes payload values, tokens,
emails or tenant ids to its output.

### Option 2 — no read-only interface available

Do not connect. Export the two windows by hand from your queue console and share
only these fields per job:

```text
queue · jobId · jobName · createdAt · attempts · state · failedReason
payload KEY NAMES (not values) · schemaVersion
whether commandId exists · whether evidenceId exists
whether either is null/undefined · traceId present · producer build id
```

## The questions the evidence must answer

1. Was either job created by the local test run (creation time inside the
   window, producer build id matching the local tree)?
2. Did the payload use the current canonical contract (`commandId`,
   `schemaVersion`) or the legacy one (`evidenceId`)?
3. Did the deployed worker expect the legacy contract?
4. In the DEPLOYED build, what processor is the `graph-reconcile` queue's
   worker constructed with, and do any two queues share a name? Finding 1b
   rules out the tag being noise, so this pairing has to be explained by the
   deployed wiring.
5. Did any other job from the same local run reach production?
6. Did any such job **complete successfully**?
7. Did any evidence, custody, destruction, storage, report, notification,
   webhook or reconciliation side effect occur?

Question 6 is the one that matters. Both observed executions stopped at Prisma
validation *before* the query, so neither deleted anything — but that says
nothing about jobs that did not raise.

To answer 7, cross-check against the production database with a **read-only**
credential (`P7_PRODUCTION_DB_READONLY_URL`), looking for rows created or
modified in the two windows in: `evidence` (`deletedAt`, `purgedAt`),
`custody_events`, `destruction_certificates`, `notification_deliveries`,
`webhook_deliveries`.

## Quarantine — only if contaminated jobs are confirmed

**Never** `FLUSHALL`, **never** `FLUSHDB`, **never** delete a queue. Those
destroy legitimate work and the evidence at the same time.

Act on **named job ids only**, after the collector has identified them:

```bash
# 1. Record first — the job's data is the evidence.
#    (read-only credential)
HGETALL bull:<queue>:<jobId>

# 2. Move the specific job to the failed set so it stops being retried,
#    using the queue's own API rather than raw key surgery:
#      await queue.getJob(jobId) → job.moveToFailed(new Error("point7-quarantine"), token)
#    Do this ONE job id at a time, with the list from the collector.

# 3. Do NOT remove the job. A quarantined job that still exists can be
#    replayed through the authorized route once the worker is upgraded.
```

## Closing this out

The incident is closed when the collector output (or the owner export) answers
questions 1–7 and any contaminated job is quarantined by id. Until then this
document, the two Sentry issue ids, and the code findings above are the record.
Point 7 must not claim the production incident resolved.
