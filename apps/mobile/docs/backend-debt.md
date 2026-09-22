# CANONICAL BACKEND DEBT

Defects that live in the **shared backend**, not in Native.

They are recorded here rather than worked around, because a Native-only
correction would make the two clients disagree about what the platform did —
and the client that "fixed" it would be the one telling the story the server
cannot support. Every entry names the endpoint, what it actually does, what
the affected surface does about it, and what a real fix would be.

Nothing here blocks a Native surface. A row is open debt, not a blocker.

---

## BD-1 — CLOSED (2026-09-22) — `POST /v1/batch-analysis/:id/cancel` reported success without cancelling

**What it did.** `cancelJob` acted only on `PROCESSING`. For a `PENDING` job
it returned `true` having changed nothing; the route read that as
cancellation, told the operator "Batch job cancelled", and wrote
`enterprise.batch_cancel outcome: success` into the audit log. The job then
ran.

**Why it was not worked around from Native.** A client that "fixed" it would
be the one telling a story the server could not support. Native withheld the
control instead, and named the reason here.

**The fix, in the service where it belonged.**

* A `PENDING` job is cancelled. It is the EASIEST one to stop — nothing has
  started, so there is nothing to stop and everything to mark.
* An item that was mid-flight is recorded as stopped BY THE OPERATOR rather
  than as a generic failure. "This could not be analysed" and "somebody
  stopped this" are different things to say about a piece of evidence.
* `cancelJob` returns an OUTCOME — `CANCELLED` / `NOT_FOUND` /
  `ALREADY_TERMINAL` — because a boolean could not distinguish "cancelled"
  from "this job already finished", which is why the route reported one as the
  other. A finished job now answers 409 and is audited as a refusal with its
  reason, not as a success.
* A job belonging to someone else still answers exactly as a job that does not
  exist.

**The clients.** Native offers Cancel on both non-terminal states now, because
that is where the service acts; withholding it would have become the untruth.
The web already offered it on both, so its "Batch job cancelled" is now true
rather than needing a change.

Guarded by `services/api/test/batch-analysis-cancellation.test.ts` and
`apps/mobile/test/operations.test.mjs`.

---

## BD-2 — CLOSED (2026-09-22) — batch jobs were process memory

**What it was.** The service stored `this.jobs` in a plain object on a module
singleton. A restart lost every job, and two API instances did not see each
other's, so a job could simply vanish. Both clients reported that honestly
because neither could do anything else.

**The fix.** `batch_analysis_jobs` / `batch_analysis_job_items`, modelled on
`evidence_intelligence_jobs` — this repository's existing durable-job shape —
rather than a second job system. No new queue, no new worker, no second
processing model: the same in-process execution runs, and what changed is
where its state lives.

* **Multi-instance safety is a CLAIM, not a flag.** `processBatch` moves the
  job from PENDING-and-unclaimed to PROCESSING-and-claimed in one conditional
  UPDATE, so Postgres decides and the loser is told the job is already
  processing. The old guard was a Map in one process and could not answer that
  question at all.
* **Workspace isolation is a column.** `team_id` is on the job row, so a read
  is scoped by a predicate rather than by a filter each caller must remember.
  A batch whose evidence spans two workspaces is refused at create: there is
  no honest `team_id` for it.
* **Cancellation survives.** A cancel that lands mid-run stops the loop at the
  next item, and the final status update is conditional so a cancelled job is
  never overwritten as COMPLETED.

**Proof.** `services/api/test/batch-analysis-durability.integration.test.ts` —
15 cases against a REAL PostgreSQL, including a second connection seeing the
job, only one instance claiming it, and cross-workspace isolation. A durability
claim proven against a mock would be proving the mock.

Migration `20280670000000_bd2_durable_batch_analysis_jobs`, curated in the
migration inventory (gate failures 0) and recorded in the deployment plan.
Clean-boot rehearsed; NOT applied to production.

---

## BD-3 — `GET /v1/cases/summary` — RESOLVED during Native closure

Recorded here during the convergence as "counters with no home on
`matter-queue`". It was dispositioned SUPERSEDED_REMOVE on the claim that no
UI was owed, and the tree contradicted that: the native Cases tab reads it for
four counters the replacement does not carry. The route moved to
PRODUCT_CONNECTED rather than being removed, which is recorded in
`audit-output/current/CONTINUATION-CHECKPOINT.md` with its cause.

Nothing is owed here. The entry is kept so the numbering does not have a hole
in it that a later reader has to go and re-derive.
