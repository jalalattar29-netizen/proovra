# Runbook 12 — Failed upload / report / package

**Scope:** customer reports that a capture upload did not complete, a report cannot be generated, or a verification package fails to download.

**Prerequisites:**

- Read access to the evidence record + its custody event chain.
- Operator account on the customer's workspace.

**Forbidden:**

- Mutating the evidence record to "fix" the upload.
- Deleting in-flight upload sessions before runbook 09 (custody continuity) has been walked.

---

## Failed upload

1. **Identify the session.** Search `WorkflowIntakeSession` or `CaptureSession` for the customer's evidence id. Capture session status: `CREATED` / `OPENED` / `UPLOAD_STARTED` / `UPLOAD_COMPLETED` / `SUBMITTED` / `ABANDONED` / `EXPIRED`.
2. **Map status to action:**
   - `CREATED` / `OPENED` — customer didn't reach the upload step. Re-share the intake link.
   - `UPLOAD_STARTED` — a part started but didn't complete. Check S3 multipart-upload status; the reaper job (runbook 03 scheduler list) will abort stale sessions automatically.
   - `UPLOAD_COMPLETED` but no `SUBMITTED` — customer uploaded but didn't confirm. Coach the customer to revisit the link.
   - `EXPIRED` — link expired. Issue a fresh link (intake link or evidence request).
   - `SUBMITTED` but evidence record absent — INCIDENT (runbook 11). The `completeEvidence()` pipeline should have created the record.
3. **Verify integrity if the upload completed.** Run runbook 09 against the evidence record.

## Failed report generation

1. **Identify the report's lifecycle state.** `GET /v1/reports?evidenceId=<id>` or query `Report` + `EvidenceCompositionPipeline` rows. States: `not_requested` / `pending` / `ready` / `failed` / `unavailable`.
2. **`pending` for >10 min:** the worker `report` queue is backed up. Check `/admin/runtime/queues` for depth. If `report-dlq` has rows, the underlying job failed terminally — read the DLQ row to identify the cause.
3. **`failed`:** read the failure reason from the DLQ row or the worker logs. Common causes:
   - Puppeteer / Chromium error → restart the worker (runbook 03).
   - Missing snapshot field (e.g., evidence has no `fingerprintHash`) → the evidence record itself is incomplete. Run runbook 09; do NOT regenerate the report against a broken state.
   - Signing key error → runbook 06.
4. **Regenerate.** Use runbook 08 (report / package regeneration). Old version row stays in the DB; new version row is created.

## Failed verification-package download

1. **Identify the package's lifecycle state.** Same as report; `VerificationPackage` rows carry `generatedAtUtc` + storage references.
2. **Status `ready` but download returns 404:** S3 object missing or expired-presigned-URL. Re-request the download (presigned URLs are short-lived by design).
3. **Status `failed`:** worker `report` queue handler failed. Same diagnostic path as failed report.
4. **Status `unavailable`:** the package was never generated. Trigger generation via the worker queue.

## Status `unavailable` on a finalized evidence record

This means the evidence is `REPORTED` (signed + finalized) but the verification-package pipeline never ran. The most likely causes:

- Worker outage during the post-finalize hook → restart the worker, the hook re-fires on the next finalize-touch.
- Customer-team plan that does not include packages → check workspace billing plan.

Document the resolution path in the support ticket. Open a DEF if the same code path repeatedly fails.

---

## Honest gaps

- DEF-030 (E8): external responder submission emits no SecurityEvent; if the upload was via an external intake link, the security stream will show only the in-link audit events, not the responder activity. Diagnose from `WorkflowIntakeSession` + `EvidenceRequestEvent` rows instead.
- The platform does not auto-restart Puppeteer on individual job failures; a single bad Chromium state can affect subsequent jobs until worker restart.
