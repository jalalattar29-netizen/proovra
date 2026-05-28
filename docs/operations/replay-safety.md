# Replay Safety Matrix (Phase P2.3)

**Audience:** anyone introducing a new worker job kind.

**Canonical source:** `services/api/src/services/operations/queue-replay-safety.service.ts`.

---

## 1. The three categories

| Category | Meaning | Examples |
| --- | --- | --- |
| `safe` | Same input → same effect. Idempotent or upsert-only. | Search-index rebuild, media-intelligence run, graph reconcile |
| `requires_step_up` | Idempotent overall but with non-trivial cost or side-effects. Step-up gates operator confirmation. | Report PDF generation (signs the PDF), OTS upgrade (blockchain attempt) |
| `forbidden` | Mutates state irreversibly. Never replay. | Hard-delete purge of evidence |

A fourth status, `unknown`, applies when a job kind is not in the matrix at all. The route layer refuses unknown kinds.

## 2. Adding a new job kind

When introducing a new worker job kind:

1. Open `services/api/src/services/operations/queue-replay-safety.service.ts`.
2. Append an entry to `ENTRIES` with:
   - `queueName` (literal, must match the BullMQ Queue's name)
   - `jobKind` (the `job.name` value)
   - `category` (one of the three)
   - `rationale` (one-sentence operator-readable justification)
3. Add a frontend smoke test that the new entry surfaces with the right badge.

Adding a new entry is the ONLY way the operations UI lets the operator replay the kind.

## 3. Narrowing vs widening

- Widening (e.g. `requires_step_up` → `safe`) is a release decision and requires the engineer to justify why the idempotency now holds.
- Narrowing (e.g. `safe` → `forbidden`) is always allowed — it makes operations stricter.

## 4. Enforcement

- The route `POST /v1/operations/queues/:queueName/jobs/:jobId/replay` consults `getJobReplayCategory(queueName, jobKind)`.
- `forbidden` → bounded 403 `replay_forbidden`, audit event `queue_job_replay_forbidden`, metric `queue_replay_forbidden_total`.
- `requires_step_up` → step-up gate via purpose `QUEUE_JOB_REPLAY`.
- `safe` → executes; audit event chain `queue_job_replay_attempted` → `queue_job_replay_succeeded`.
- `unknown` → 400 `unknown_job_kind` (never executes).

## 5. UI consequences

- The frontend NEVER renders the Replay button for `forbidden` or `unknown` categories — it renders explanatory copy and points to the audit center instead.
- For `requires_step_up`, the button label includes "(step-up)" so the operator sees the confirmation requirement before clicking.
