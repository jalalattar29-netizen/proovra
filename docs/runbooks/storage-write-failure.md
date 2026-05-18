# Runbook — Storage write failure

**Incident slug**: `storage-write-failure` · **Category**: `STORAGE` · **Default severity**: `HIGH`

## Symptoms
- Worker logs report S3 `PutObject` / `HeadObject` / `GetObject` errors.
- Upload finalize fails for newly captured evidence.
- Report / verification-package generation downstream failures (the job can't read source assets).

## Dashboards / metrics
- `/v1/ops/metrics` → `jobs_failed_total` rising.
- S3 / R2 dashboard — bucket-level error rate, throttle count.

## Safe commands / routes
1. `aws s3 head-object --bucket $BUCKET --key <known-good-key>` from the deployment host to confirm credentials + reachability.
2. Confirm `S3_OBJECT_LOCK_ENABLED` matches the bucket's actual Object Lock state. The Phase A bootstrap (`object-lock-verification.ts`) refuses to start in production when this is misconfigured.
3. Inspect the storage helper at `services/api/src/storage.ts` for recent changes.

## What NOT to do
- **Do not** set `bypassGovernance: true` on any storage call. Phase 20 verified no call site sets it; do not change that.
- **Do not** disable Object Lock to "make the error go away". Object Lock is the source of retention enforcement.
- **Do not** rotate S3 credentials in-band during an incident — schedule with the on-call.

## Rollback / retry guidance
- Transient: retry from the operator UI.
- Sustained: failover to standby bucket if available (Phase B/C work).
- If S3 is healthy but our IAM perms changed, restore the old policy.

## Escalation
- > 20 write failures / 5 minutes → page on-call. Affects upload + report + package surfaces simultaneously.
