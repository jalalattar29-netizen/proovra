# Runbook 02 — Object storage restore validation

**Scope:** validate that evidence content + report + verification-package artifacts are recoverable from the object storage backend (AWS S3 or Cloudflare R2), and that S3 Object Lock retention has not been bypassed.

**Prerequisites:**

- Operator access to the storage provider console.
- `S3_*` environment variables for the target environment (NEVER read or print their values; reference them by name only).
- A test evidence record id whose `storageBucket` + `storageKey` are known.

**Forbidden:**

- Deleting any object whose `storageObjectLockRetainUntilUtc` has not yet passed. The bucket should reject the delete; this runbook does NOT include code that bypasses retention.
- Disabling Object Lock on a production bucket.
- Exporting evidence content out of the storage provider for ad-hoc inspection.

---

## Steps

### A. Confirm storage backend identity

1. From the operator workstation, confirm the storage backend the target environment points to:
   - If `S3_ENDPOINT` resolves to `https://s3.<region>.amazonaws.com` → AWS S3.
   - If `S3_ENDPOINT` resolves to `https://<account>.r2.cloudflarestorage.com` → Cloudflare R2.
   - If `S3_ENDPOINT` resolves to `http://localhost:9000` → MinIO (dev only; production deployment is misconfigured).
2. Record the backend identity in the rehearsal log.

### B. Verify provider-managed durability + versioning

1. Open the bucket in the provider console.
2. Confirm bucket-level versioning is enabled (S3 Object Lock requires versioning).
3. Confirm bucket-level Object Lock is enabled if the deployment claims `S3_OBJECT_LOCK_ENABLED=true`.
4. Confirm the default retention mode + retain-until shape match the deployment's `S3_OBJECT_LOCK_MODE` and `S3_OBJECT_LOCK_RETAIN_DAYS`.

### C. Verify per-object retention round-trips

1. Pick one finalized evidence record from the DB. Record the `storageBucket` + `storageKey`.
2. In the provider console, navigate to that object.
3. Confirm:
   - The object version exists.
   - `Object Lock Mode` matches the recorded `storageObjectLockMode` on the Evidence row.
   - `Retain Until` matches the recorded `storageObjectLockRetainUntilUtc` on the Evidence row.
   - `Legal Hold` matches the recorded status on the Evidence row.

### D. Validate retrievability

1. Read the object via the provider's get-object API (NOT via a presigned URL handed to a third party — read directly from the operator session).
2. Confirm the byte-length matches `Evidence.fileSizeBytes` on the DB row.
3. Compute a SHA-256 of the fetched bytes; confirm it equals `Evidence.fileSha256`.
4. If the digest matches, the object is recoverable and uncorrupted at the bucket layer.

### E. Validate worker boot-time Object Lock verification

1. Boot the worker process with `S3_OBJECT_LOCK_ENABLED=true`.
2. Expected: `bootstrapObjectLockVerification()` succeeds. In production, if the bucket cannot accept retention writes, the worker exits with code 1 and the runbook MUST stop here.
3. If the worker boot fails on Object Lock verification, fix the bucket configuration BEFORE proceeding.

### F. Sign off

- Record the rehearsal in `00-rehearsal-log.md`.
- Note any objects whose retention metadata did not round-trip; investigate as an integrity concern.

---

## What this runbook does NOT cover

- Cross-region object replication. PROOVRA does not currently replicate evidence content across providers or regions — storage durability is provider-managed and single-region by default.
- "Restoring" a deleted object. Within the Object Lock retain-until window, objects cannot be deleted. After the window passes, deletion is irreversible at the provider level.

---

## Honest gaps

- A multi-provider redundancy posture (e.g. S3 + R2 mirror) is NOT currently implemented. An enterprise customer who requires that would need it as a scoped future phase.
- "Restored from bucket" is meaningful only if the bucket itself was not destroyed. Bucket-level disaster is outside the application's recovery path.
