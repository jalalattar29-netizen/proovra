# Runbook 08 — Report / verification-package regeneration

**Scope:** regenerate a report or a verification package for an existing evidence record when the original artifact is missing, corrupted, or stale (e.g., snapshot fields refreshed).

**Prerequisites:**

- Capability `REPORTS_GENERATE` on the workspace.
- Read access to `Report` + `VerificationPackage` rows for the evidence in question.

**Forbidden:**

- Mutating the underlying Evidence record. Regeneration is read-only against the evidence.
- Mutating an existing `Report` or `VerificationPackage` row in place. Regeneration always creates a new version row; the old version is retained for verification continuity.
- Bypassing the worker `report` queue. Synchronous in-API generation is not supported.

---

## What regeneration means

Each `Report` and `VerificationPackage` row carries a `version` integer + a content snapshot of the verification state. Regeneration:

1. Reads the current evidence + verification snapshot.
2. Computes a fresh canonical content blob.
3. Enqueues the worker `report` (or `verification-package`) queue.
4. The worker produces a new artifact file.
5. A new `Report` (or `VerificationPackage`) row is created with `version = previous_version + 1`.

Old versions remain in the DB and storage; verification of a record signed under an older version continues to work as long as the historical snapshot fields are preserved.

---

## Steps

1. **Identify the evidence.**
   - Capture the evidence id and the current `Report` / `VerificationPackage` version (max version per evidence).

2. **Confirm the underlying integrity state is sound.**
   - Run runbook 09 against the evidence.
   - If the custody chain or signature verification has broken, STOP. Regenerating a report from a broken state would produce a misleading artifact.

3. **Trigger regeneration.**
   - Via the admin API, enqueue a `report` job for the evidence id (or `verification-package` for the package surface).
   - Confirm the job lands in the BullMQ queue (`GET /admin/runtime/queues`).

4. **Monitor the job.**
   - The worker processes the job within the configured concurrency window (default 2 for `report`).
   - On success, a new row is written; on failure, the row stays at the previous version and the failure is logged.

5. **Confirm the new artifact is reachable.**
   - The aggregator (`reports-aggregator.service.ts`) returns the latest version.
   - The Verify page surfaces the new artifact's `generatedAtUtc`.

6. **Document the regeneration.**
   - Capture: evidence id, previous version, new version, operator id, reason.
   - The DB rows themselves are the canonical audit trail.

---

## What this runbook does NOT cover

- Restoring an artifact whose object-storage version has been deleted before retention expiry (S3 Object Lock should prevent this; if it occurred, that is itself an incident).
- Re-stamping the evidence with a fresh TSA token (a future bounded phase if requested).

---

## Honest gaps

- Regeneration produces a NEW snapshot under the CURRENT key, even if the evidence was originally signed under a previous key. The original `Report` row preserves the original `signingKeyId` snapshot. Verifiers consulting only the latest version may see a different key id than the historical version — this is correct behavior; document accordingly.
