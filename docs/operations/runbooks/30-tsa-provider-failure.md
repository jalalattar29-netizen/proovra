# Runbook 30 — TSA (RFC 3161 timestamping) provider failure

## Symptoms
- Evidence finalization shows `tsaStatus: FAILED` on a recent batch of records.
- The configured `TSA_URL` returns 5xx / network errors during evidence finalize.
- `OperationalIncident` rows referencing `TSA_PROVIDER_UNAVAILABLE`.

## Blast radius
Per-evidence record finalized during the outage. Evidence finalization proceeds without TSA proof; the `tsaStatus` field records the failure honestly. **Evidence integrity is preserved** — TSA is a supplementary timestamp, not the integrity primitive.

## Detection
- API logs: `requestRfc3161Timestamp` exceptions.
- `/admin/runtime/readiness` does NOT currently surface TSA — operator notices via per-evidence `tsaStatus: FAILED` clustering.
- Provider status page for the configured TSA (DigiCert, GlobalSign, FreeTSA, internal).

## Logs to inspect
- API logs: `services/api/src/services/timestamp.service.ts` per call.
- TSA provider's status page or admin panel.

## Rollback procedure
None — timestamping is forward-only against the canonical state.

## Safe recovery procedure
1. **Confirm with the TSA provider's status page.** If the provider has declared an incident: post customer communication (if customer-visible at the per-evidence level) acknowledging the timestamp may be unavailable for newly-finalized evidence during the window.
2. **Confirm `TSA_ENABLED=true`** and `TSA_URL` correct. The 20 s default timeout (`TSA_TIMEOUT_MS`) bounds each request; consider lowering for the duration of the outage if hangs are persistent.
3. **Confirm `TSA_USERNAME` / `TSA_PASSWORD` are not expired** (some TSA providers rotate credentials periodically).
4. **For evidence finalized with `tsaStatus: FAILED`**: re-stamping is a future bounded phase (currently not implemented). The honest record stands — `tsaStatus: FAILED` is a first-class field reflecting reality.
5. **For sustained outages**: switching to a different TSA provider is a deployment-config change, NOT an in-flight workaround. Document the switch in the operator log + customer-notify if the change affects record-history continuity.

## Validation steps
- A test evidence finalize succeeds with `tsaStatus: STAMPED` + the TSA token populated.
- TSA token verification (operator-driven; OpenSSL `ts -verify`) succeeds against the recorded message imprint.
- `tsaStatus: FAILED` count for the last hour returns to baseline.

## Escalation conditions
- Outage > 4 hours during business hours → customer-wide notification if customers' evidence will be missing TSA proof for that window.
- A named pilot customer requires TSA proof for their specific legal posture → escalate immediately + document the missing-TSA evidence.
- The TSA provider's certificate changes (re-issuance) → a future bounded phase handles cert rotation; for now, escalate.

## DO NOT DO THIS
- Do NOT mark `tsaStatus: STAMPED` manually. The status is the audit of what actually happened.
- Do NOT bypass the TSA call to "speed up finalization". The timeout (`TSA_TIMEOUT_MS`) bounds it already.
- Do NOT change `TSA_URL` to an untrusted provider "to keep stamping". TSA trust is the integrity contract — only use providers the customer has approved.
- Do NOT silently disable TSA (`TSA_ENABLED=false`) without customer communication. The platform's per-evidence `tsaStatus` field becomes `UNAVAILABLE` and customers may not notice the regression until later.
