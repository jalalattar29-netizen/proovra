# Signer Operations Runbook (Phase P3.1)

**Audience:** on-call SRE / platform engineers.

---

## 1. Daily

- Open `/operations/signers`. Confirm every purpose card shows `active`.
- If any card shows `degraded`, click **Inspect** → **Run health probe** → follow the recommended action.

## 2. Incident playbooks

### "KMS signing started failing"
1. `/operations/signers` → inspect the affected purpose.
2. Click **Run health probe**. The bounded state tells you what to fix:
   - `permission_denied` → the IAM role's `kms:Sign` policy was changed.
   - `key_disabled` → re-enable in the KMS console.
   - `unreachable` → VPC / endpoint reachability problem.
   - `unsupported_algorithm` → KMS key was rotated to an incompatible algorithm.
3. The signer remains in `active` status — the rotation lifecycle is NOT automatically triggered. Fix the underlying KMS condition first.

### "Operator reports a Report PDF can no longer be verified"
1. Open the report row's signer metadata (`Report.pdfSignerKeyId`).
2. Check whether that signer appears in `/operations/signers` (possibly with `retired` or `revoked` status).
3. Confirm the public material is still published. If not, this is an operator error during rotation — restore the public material from the KMS console.

### Two revocations, two scopes (2026-11-04)
The console offers two irreversible actions. Choose by what is true, not by what keeps signing working.

| Action | Scope | What it changes |
| --- | --- | --- |
| **Revoke authorization (step-up)**, typed `REVOKE` | this signer only: one purpose of one key identity | `signer_control_state` → `REVOKED`. That signer signs nothing again. `signing_keys` is not touched: everything it signed still verifies, and other purposes that use the same key file (for example the package seal) keep working. |
| **Declare key compromised (step-up)**, typed `COMPROMISED` | the key material (its SPKI SHA-256) | Every `signing_keys` row of that material is revoked, under any key id, version or purpose, the package seal included. Every signer that names one of those identities is withdrawn, for every purpose. Public Verify, the owner record, reports, package records and custody-attestation checks report the key as revoked. The same material registered later is born revoked. Allowed even after an authorization revoke. |

Both use the `SIGNER_REVOKE` step-up and platform operations authority. The API refuses a revoke that does not state `scope` (`authorization` or `key_compromise`).

A deployment should give each purpose its own key (`PACKAGE_SIGNING_PRIVATE_KEY_PATH` / `PACKAGE_SIGNING_KEY_ID` for the package seal, `PACKAGE_SIGNING_KMS_KEY_ID` in KMS mode), so that a compromise of one key never stops another purpose. When purposes share one key, a compromise stops all of them, by design.

### "Compromised KMS key"
1. **Immediately**: `/operations/signers` → inspect a signer that uses the key → **Declare key compromised (step-up)** with a clear reason. The result lists every signer it withdrew.
2. Stage a new signer with rotated KMS material.
3. Preview rotation. Confirm `compatibility=compatible` or `algorithm_change` is acceptable.
4. Promote (step-up).
5. Roll api + worker with new env and a NEW key identity (`SIGNING_KEY_ID` / `SIGNING_KEY_VERSION`, and the package pair). Verify health probe returns `healthy`.
6. The compromised signer's attestations remain auditable; their `verified` status is preserved as-of the verification time, but new verifications now report `signer_unavailable` because the key is revoked.

## 3. Custody attestation operations

### Daily attestation coverage
- `/operations/signers` → scroll to "Detached custody attestations". Run **Backfill 50 events (step-up)** when new custody events accumulate without attestations.

### Verifying a specific attestation
- Click **Verify** on the row. Outcome is one of the 7 bounded states; a non-`verified` outcome is a real signal — escalate.

## 4. Rotation playbook (quarterly)

1. Generate a new KMS key + version. Note the new `keyId` / `keyVersion`.
2. `POST /v1/operations/signers/stage` with the new metadata.
3. Click **Preview rotation**. Confirm compatibility.
4. Update `.env` and `docker-compose.prod.yml` with the new env values.
5. Click **Promote (step-up)** with reason "Q3 quarterly rotation".
6. `docker compose ... up -d --force-recreate`.
7. Verify the next Report PDF lists the new signer keyId in `Report.pdfSignerKeyId`.
8. After a 24h soak, click **Retire (step-up)** on the previous signer with reason "Q3 rotation: previous active retired after soak".

## 5. Honest disclosure

- Rotation is **operator orchestrated**. PROOVRA does not auto-rotate KMS keys.
- The signer audit timeline is the canonical record of who did what and when. Use it in procurement reviews.
- This runbook does NOT promise admissibility of any artifact in any jurisdiction.

## 6. Verification Package attestation closure (P3.1.1)

Every newly generated Verification Package now contains a bounded attestation set + signer registry snapshot. See `docs/verification/verification-package-format.md`.

### 6.1 Default (best-effort) mode
- No env var needed. Package generation continues if attestation lookup fails; `degradedReason` is recorded inside `custody/attestations.json`.
- Watch for `verification_package_attestations_degraded` audit events in the audit center.

### 6.2 Strict mode (procurement contract requires it)
- Set `VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true` on the worker container.
- Package generation will fail with `AttestationStrictModeFailureError` when attestations would be degraded.
- Strict mode is opt-in. Roll containers after changing the env.

### 6.3 If strict mode starts failing in production
1. Check `package_attestation_generation_failure_total` metric trend.
2. Inspect recent `signer_signature_failure` events.
3. If KMS is reachable and the custody-event signer is healthy, the most likely cause is missing attestation backfill — run `/v1/operations/custody-attestations/backfill` (step-up) on the api side.
4. As an emergency: drop strict mode (`VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=false`), roll containers, then investigate without blocking package generation.
