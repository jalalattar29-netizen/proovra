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

## BD-2 — batch jobs are process memory

**Endpoint.** The same service stores `this.jobs` in a plain object. A restart
loses every job, and two API instances do not see each other's.

**Consequence.** Identical on Web and Native: a job can vanish. Neither client
can correct this, and neither pretends otherwise — a job that is gone reads as
gone rather than as failed.

**A real fix** is persistence, which is a schema change.

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
