# Runbook 06 — Signing-key recovery

**Scope:** recover signing-key availability after a key loss, a key compromise, or a backend transition (local-PEM ↔ AWS KMS).

**Prerequisites:**

- Operator authorisation to access KMS or the operator-controlled PEM backup store.
- Ability to update the deployment environment variables.
- Read access to historical `signingKeyId` + `signingKeyVersion` records in the DB.

**Forbidden:**

- Exposing private key material in logs, version control, screenshots, or chat. Operate on the key only through KMS APIs or operator-controlled secret managers.
- Renaming `SIGNING_KEY_ID` without first coordinating a label-rotation phase (would break verification of historical records — see DEF-004).
- Deleting historical KMS key versions or PEM files. The application uses the historical public key to verify historical records.

---

## Backend modes

| Mode | Configured by | Key material location | Recovery path |
|---|---|---|---|
| AWS KMS | `SIGNER_PROVIDER=aws-kms` + `KMS_KEY_ID` + `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | AWS KMS-managed | KMS provider recovery; never exported |
| Local PEM | `SIGNER_PROVIDER=local-pem` + `SIGNING_PRIVATE_KEY_PATH` + `SIGNING_KEY_ID` + `SIGNING_KEY_VERSION` | On-disk PEM file at the configured path | Restore PEM from operator-controlled backup |

Each historical signed record snapshots both `signingKeyId` and `signingKeyVersion` so verification continuity does not depend on the current active key.

---

## Steps

The procedure varies by scenario. Pick the scenario that matches the failure mode and follow its sub-steps.

### A. KMS key unavailable (AWS region issue)

1. Confirm the issue is provider-side via the AWS health dashboard.
2. Do NOT immediately rotate; the most reliable recovery is provider recovery.
3. While the key is unavailable, new evidence finalization will fail at the signing step. Capture / upload continue to succeed; signing retries are not bounded — operators may pause `automation` and `report` queues to reduce noise.
4. Once the provider recovers, signing resumes automatically.

### B. KMS key compromised

1. Generate a new KMS key. Record the new `KMS_KEY_ID`.
2. Pick a new `SIGNING_KEY_ID` label that is NEW (e.g. `dw_ed25519_v2`). Do NOT reuse the old label.
3. Bump `SIGNING_KEY_VERSION` to reflect the new key version.
4. Deploy the new env vars to the service.
5. Confirm `runStartupConfigValidation()` passes.
6. From now on, new evidence is signed under the new key. Historical records remain verifiable against the old key (the old key's public material MUST be retained for verification — do NOT delete it from KMS).
7. Open a security event entry documenting the rotation timestamp, the compromise scope, and the affected key id.

### C. Local PEM corrupted or lost

1. Restore the PEM from the operator-controlled secret backup.
2. Confirm the restored file path matches `SIGNING_PRIVATE_KEY_PATH`.
3. Restart the API service. `crypto.ts` loads the PEM at the configured path; if missing, startup throws.
4. Confirm `runStartupConfigValidation()` does not throw.
5. If the PEM cannot be restored, follow scenario B — generate a new key, deploy with a new `SIGNING_KEY_ID`, document the rotation.

### D. Transition from local-PEM to KMS (or vice versa)

1. Plan ahead: this is a coordinated change, not a hotfix.
2. Generate the destination key material (new KMS key OR fresh PEM) under a new `SIGNING_KEY_ID` label.
3. Deploy with `SIGNER_PROVIDER` updated to the new backend AND `SIGNING_KEY_ID` updated to the new label.
4. Confirm `runStartupConfigValidation()` passes.
5. Retain the old backend's public key material; the application uses the per-record `signingKeyId` snapshot to choose the verification key.

---

## Verification continuity guarantee

For ANY historical record:

- The DB snapshot includes the `signingKeyId` and `signingKeyVersion` that signed that record.
- Verification consults those snapshot fields and uses the matching public key material.
- As long as the public key material for `signingKeyId` is retained (KMS retain or PEM archive), historical records remain verifiable.

This is why the runbook forbids deleting historical key material. PROOVRA does not provide an automated key archive — operators MUST retain.

---

## Honest gaps

- DEF-027: signing-key rotation requires manual env update + service restart. No in-band rotation is implemented. A future bounded phase can add in-band rotation if rotation cadence justifies the complexity.
- The application does NOT enforce key archival — operators must retain historical public keys. Loss of historical key material breaks verification of records signed under that key.
