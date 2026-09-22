# CANONICAL BACKEND DEBT

Defects that live in the **shared backend**, not in Native.

They are recorded here rather than worked around, because a Native-only
correction would make the two clients disagree about what the platform did —
and the client that "fixed" it would be the one telling the story the server
cannot support. Every entry names the endpoint, what it actually does, what
the affected surface does about it, and what a real fix would be.

Nothing here blocks a Native surface. A row is open debt, not a blocker.

---

## BD-1 — `POST /v1/batch-analysis/:id/cancel` reports success without cancelling

**Endpoint.** `services/api/src/services/batch-analysis.service.ts` →
`cancelJob(userId, jobId)`.

**What it does.** It returns `false` only when the job does not exist or
belongs to another user. When the job exists, it acts **only if**
`job.status === PROCESSING`; for `pending` it returns `true` having changed
nothing. The route reads that `true` as cancellation and audits
`enterprise.batch_cancel outcome: success`.

**Consequence.** `apps/web/app/(app)/operations/batch-analysis/page.tsx`
offers Cancel for both `pending` and `processing` and toasts "Batch job
cancelled" on the response. For a `pending` job that message is untrue, and
the audit record asserts an action that did not happen.

**What Native does.** `canCancelBatch()` offers the action exactly where it
acts — `processing` — and says so on the surface. It does not simulate
cancellation client-side, and it does not suppress the job.

**A real fix** belongs in the service: cancel a `pending` job too (it has not
started, so there is nothing to stop and everything to mark), or return
`false` and let the route answer a conflict. Either is a backend change with
an audit consequence, which is why it is not made from here.

---

## BD-2 — batch jobs are process memory

**Endpoint.** The same service stores `this.jobs` in a plain object. A restart
loses every job, and two API instances do not see each other's.

**Consequence.** Identical on Web and Native: a job can vanish. Neither client
can correct this, and neither pretends otherwise — a job that is gone reads as
gone rather than as failed.

**A real fix** is persistence, which is a schema change.
