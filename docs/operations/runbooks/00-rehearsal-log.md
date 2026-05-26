# 00 — Restore Rehearsal Log

This file records the outcome of each operator-driven restore rehearsal. Restore rehearsal is a periodic operational practice — backup is not validated until restore has actually been exercised end-to-end.

Append a new row to the table below after every rehearsal. Do not edit historical rows.

| Date (ISO 8601) | Environment | Operator | Scope | Result | Notes / follow-up |
|---|---|---|---|---|---|
| _no rehearsal recorded yet_ | | | | | |

## Required scope per rehearsal

1. DB restore to a non-production environment from the most recent provider backup snapshot.
2. `pnpm exec prisma migrate deploy` on the restored DB.
3. Boot API + worker pointing at the restored DB + a clone of object storage.
4. Hit `GET /admin/runtime/readiness`; confirm `database`, `migrations`, `schema`, `redis`, `s3_object_lock`, `queues`, `workers` are HEALTHY (or carry a documented degraded reason).
5. Re-validate the custody hash chain on at least one sampled evidence record (see runbook 09).
6. Trigger a full evidence finalization end-to-end against the staging environment (capture → upload → finalize → report → package). Do not mutate production data.
7. Confirm Object Lock metadata round-trips correctly on artifact write.
8. Confirm a webhook delivery for a sample automation rule completes through the bounded retry runtime.

## When to rehearse

- Quarterly at minimum.
- After any change to the database provider, the storage provider, or the signing-key backend.
- After any change to the worker or API Dockerfile that affects startup behavior.
- After any phase that introduces a new runtime dependency.

## Pass criteria

- All required scope items complete.
- No `CRITICAL` subsystem reported by readiness rollup at the end.
- Sampled custody chain re-validates clean.
- Sampled finalization end-to-end produces a report + package whose integrity verifies against the recorded snapshot fields.

## Fail criteria

- Any required scope item could not be completed → document the blocker in the row above and open an Ops ticket.
- Any subsystem reports CRITICAL with no documented degraded explanation.
- Custody chain re-validation surfaces a hash mismatch.
- Finalization fails partway and leaves the staging environment in an inconsistent state.
