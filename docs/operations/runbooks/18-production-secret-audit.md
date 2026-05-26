# Runbook 18 — Production secret rotation audit (DEF-003 closure path)

**Scope:** the operational procedure Ops follows to close `DEF-003` (production secret rotation audit) before launch. The platform's startup validator already enforces shape + presence of every required secret in production; this runbook covers the OPERATIONAL verification that the deployed secret VALUES are the current intended values, not stale pre-rotation values.

**Prerequisites:**

- Operator access to the production secret manager (the operator-controlled store — AWS Secrets Manager, Doppler, Vault, or whichever the Ops team uses).
- A clean check-in of the most recent intended rotation set (typically a Doc owned by the security lead — outside this repository).
- Read access to the production deployment surface so the operator can compare deployed env values to the secret-store values.

**Forbidden:**

- Pasting any secret value into the rehearsal log, the incident channel, or this repository. Audit findings reference *names only*.
- Storing rotated secrets in a personal file / chat / email. Operator-controlled store is the only authoritative source.
- Skipping any of the verification steps below to "save time".
- Marking DEF-003 RESOLVED in the master registry before all steps below complete.

---

## What this runbook is NOT

It is NOT a one-time launch checklist. It is the procedure Ops re-runs on the cadence the security lead defines (suggested: quarterly + after every security incident + after every personnel change with secret access).

It is NOT a substitute for the startup validator (`runStartupConfigValidation()`). The validator enforces shape + presence; this runbook verifies the VALUES match the intended rotation set.

---

## Steps

1. **Identify the canonical intended set.** Pull the most recent intended secret-rotation document from the security lead. For each secret listed, record: name, intended rotation date, intended provider/source. Confirm the document is the latest version.

2. **Inventory the production deployment env vars.** From the deployment console (Render / Railway / Fly / k8s / direct host — whichever Ops uses), list every env var name set on each running service (api / worker / web). Do NOT capture values; capture names + last-modified timestamps where the deployment surface exposes them.

3. **Cross-reference with the canonical set.** For each name in the intended set:
   - Is the env var present on the deployment surface? (YES / NO / NOT_APPLICABLE_TO_SERVICE)
   - Does the last-modified timestamp align with or post-date the intended rotation date? (YES / NO)
   - If NO to either: flag the variable in the audit findings table below.

4. **Verify against the secret store.** Open the operator-controlled secret store. For each variable flagged in step 3 OR for each variable whose intended rotation date is within the last 90 days:
   - Compare the value in the secret store to the value live on the deployment surface (the operator-driven comparison; do not log the values).
   - Record MATCH / MISMATCH / UNKNOWN.

5. **Decide remediation.** For each MISMATCH:
   - If the deployment env has a stale value: redeploy with the secret-store value.
   - If the secret store has the stale value and the deployment has the rotated value: update the secret store to match production. Audit how the deployment got the newer value (a follow-on ticket).

6. **Verify the startup gate.** Restart the API service in a staging environment that uses production-shape config. Confirm `runStartupConfigValidation()` completes without throwing `ProductionConfigError`. Any throw indicates a config violation that needs operator action before production restart.

7. **Verify the signing-key consistency.** If `SIGNER_PROVIDER=aws-kms`, confirm `KMS_KEY_ID` matches the active key in AWS KMS; the key is still in `Enabled` state; the historical key versions (for verification continuity) are still listed in KMS and NOT scheduled for deletion. If `SIGNER_PROVIDER=local-pem`, confirm the PEM file at `SIGNING_PRIVATE_KEY_PATH` exists on every running API + worker host and matches the operator-controlled backup digest.

8. **Verify the Stripe key separation.** Production MUST use `sk_live_*` for `STRIPE_SECRET_KEY` and `whsec_*` for `STRIPE_WEBHOOK_SECRET`. The startup validator catches `pk_*` in `STRIPE_SECRET_KEY` slot (Phase 32.7 DEF-012 closure). Operationally confirm `sk_live_*` (not `sk_test_*`) is the active value.

9. **Verify the SAML production posture.** For every customer organization with SAML configured, confirm:
   - `SamlConfig.acsUrl` is the production HTTPS URL — not localhost, not a dev domain.
   - `SamlCertificate.publicKeyPem` validNotAfter is in the future (not expiring within 30 days).
   - `SAML_TEST_MODE` is `false` (the startup validator rejects `true` in production).

10. **Verify the Redis + DB endpoints.** Confirm `DATABASE_URL` and `REDIS_URL` point to production-managed instances (not localhost, not dev). DEF-042 (POST_LAUNCH) tracks the gap where the startup validator does not yet enforce this — for this audit cycle, the verification is manual.

11. **Verify the OpenAI posture.** If `OPENAI_AI_ENABLED=true`, confirm `OPENAI_API_KEY` is set (DEF-040 POST_LAUNCH tracks the gap where the validator does not yet throw on this). If `OPENAI_AI_ENABLED=false`, confirm the AI surfaces return `status: "disabled"` end-to-end as expected.

12. **Verify the Twilio + Resend posture.** If `COMMUNICATIONS_ENABLED=true`, confirm Twilio + Resend credentials are present + valid. Issue a test SMS / test email to an operator address; confirm delivery.

13. **Record the audit findings.** Append a row to the audit findings table below.

14. **Mark closure.** If all steps complete with no MISMATCH and no operator action outstanding, AND Ops confirms the audit findings table reflects the current production state, Ops may signal DEF-003 closure to the next phase that updates the master registry. **This runbook does NOT directly close DEF-003; the audit completion is the EVIDENCE that the closing phase references.**

---

## Audit findings template

Append one row per audit cycle. Do NOT edit historical rows.

| Audit date (ISO 8601) | Operator | Secrets reviewed | Findings | Remediation |
|---|---|---|---|---|
| _no audit recorded yet_ | | | | |

Example shape (replace the placeholder when filling in):

| 2026-MM-DD | (operator name) | 18 production secrets reviewed | 0 MISMATCH, 0 stale | None |

---

## What "evidence-backed closure" means for DEF-003

DEF-003 is `BLOCKS_LAUNCH` in the master registry. Closure requires:

- This runbook is fully walked.
- The audit findings table has a row dated within the last 30 days.
- No MISMATCH outstanding.
- All operator-actioned remediation rows are also dated within the last 30 days and marked complete.
- The closing phase's doc references the audit findings row (date + operator).

Until those conditions hold, DEF-003 stays OPEN in the master registry §6 and PROOVRA is NOT launch-ready.

---

## Honest gaps

- DEF-042 (POST_LAUNCH) — the startup validator does NOT yet reject `DATABASE_URL` / `REDIS_URL` = localhost in production. A future bounded hardening phase adds the assertion. For this audit cycle, the verification is manual (step 10).
- DEF-040 (POST_LAUNCH) — the startup validator does NOT yet enforce `OPENAI_API_KEY` when `OPENAI_AI_ENABLED=true`. A future bounded hardening phase adds the assertion. For this audit cycle, the verification is manual (step 11).
- This runbook does NOT enforce cadence — Ops decides whether the rotation cycle is quarterly, biannual, or event-driven.
