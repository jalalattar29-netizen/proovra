# Runbook 21 — Immutable storage drift

## Symptoms
- `bootstrapObjectLockVerification` at worker boot reports `OBJECT_LOCK_UNAVAILABLE` despite `S3_OBJECT_LOCK_ENABLED=true`.
- Per-evidence `storageObjectLockMode` / `storageObjectLockRetainUntilUtc` is null on records the customer expected to be locked.
- `OperationalIncident` rows with `category=STORAGE` and `kind=IMMUTABLE_STORAGE_DRIFT`.
- Retention reconciliation flags evidence as `PROTECTION_UNAVAILABLE`.

## Blast radius
Per-bucket. Affects every evidence record written while the bucket lacked Object Lock configuration. Existing locked objects remain locked at the storage layer.

## Detection
- `/admin/runtime/readiness` `s3_object_lock` subsystem reports DEGRADED or CRITICAL.
- Worker boot logs show `bootstrapObjectLockVerification: FAILED`.
- Sample evidence rows have null Object Lock columns despite `S3_OBJECT_LOCK_ENABLED=true`.

## Logs to inspect
- Worker boot log around `bootstrapObjectLockVerification`.
- API logs: any `applyObjectRetention` errors (storage.ts).
- Storage provider audit log (AWS S3 / R2 console) for the bucket: when was Object Lock last configured?

## Rollback procedure
None — storage durability is provider-managed. Once an object is written without Object Lock metadata, retroactive locking requires writing a new version and applying retention to the new version.

## Safe recovery procedure
1. **Confirm provider-side configuration.** In the storage provider console, verify the bucket has versioning + Object Lock enabled at the bucket level + a default retention policy that matches `S3_OBJECT_LOCK_MODE` + `S3_OBJECT_LOCK_RETAIN_DAYS`.
2. **If the bucket lacks Object Lock**: it cannot be enabled retroactively on AWS S3 (must be configured at bucket creation). For Cloudflare R2: Object Lock is a beta feature; verify the bucket was created with it enabled. If not, a new bucket + migration is required (out of runbook scope; escalate to incident response).
3. **Restart the worker** so `bootstrapObjectLockVerification` re-runs against the (now-correct) bucket. In production, the worker refuses to boot if Object Lock is claimed but unsupported — do NOT set `OBJECT_LOCK_VERIFICATION_BYPASS=true` in production.
4. **For evidence written during the drift window**: identify the affected records via the retention reconciliation report. Per-evidence remediation: re-upload the evidence content as a new version + apply retention. This breaks integrity continuity for the affected records and must be documented explicitly per record + escalated.

## Validation steps
- Worker boots without `bootstrapObjectLockVerification` failure.
- A test evidence upload writes correct `storageObjectLockMode` + `storageObjectLockRetainUntilUtc` to the DB row.
- Reading the test object via the provider API shows Object Lock retention metadata matching the DB row.

## Escalation conditions
- Any evidence record under active legal hold was written during the drift window → INCIDENT (runbook 11). Hold integrity is the binding integrity contract; lock drift on a held record is a customer-notification-level event.
- A customer asks "is my evidence immutable?" and the answer is "we cannot confirm" for any record → INCIDENT.

## DO NOT DO THIS
- Do NOT set `OBJECT_LOCK_VERIFICATION_BYPASS=true` in production to "unblock" worker boot. The fail-fast is intentional.
- Do NOT delete the affected evidence records "to clean up". They remain audit evidence of the drift event.
- Do NOT silently re-upload affected records to apply retention without documenting per-record. The custody chain MUST reflect the rewrite.
- Do NOT modify `storageObjectLockMode` / `storageObjectLockRetainUntilUtc` columns directly from the operator shell. Those are storage-truth fields; the DB must reflect what's actually on the bucket.
