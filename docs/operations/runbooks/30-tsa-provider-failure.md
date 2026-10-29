# Runbook 30 — TSA (RFC 3161 timestamping) provider failure

## Symptoms
- Evidence finalization shows `tsaStatus: FAILED` on a recent batch of records.
- API log lines `"event":"tsa.timestamp.failed"` cluster in time, typically with
  `"category":"NOT_ISSUED"` (the provider returned no usable token).
- Evidence-integrity conditions with fingerprint `tsa_failure:<evidenceId>`
  (Operations → Evidence Operations, cohort *Timestamp failed only*).

## Blast radius
Per-evidence record finalized during the outage. Evidence finalization proceeds without TSA proof; the `tsaStatus` field records the failure honestly. **Evidence integrity is preserved** — TSA is a supplementary timestamp, not the integrity primitive. The record remains sealed and signed, and OpenTimestamps anchoring proceeds independently.

## Detection
- API logs: one structured JSON line per TSA request, written by
  `services/api/src/services/timestamp.service.ts` (`TSA_LOG_EVENTS`):
  - `tsa.timestamp.stamped` (level `info`) — a validated token was obtained.
  - `tsa.timestamp.failed` (level `warn`) — no validated token.
  - `tsa.timestamp.error` (level `warn`) — the request never reached a provider
    (configuration or input error; `errorName` only). Completion fails loudly
    in this case, so it also shows as a failed `/complete`.
- Trace: span `proovra.tsa.timestamp.request` carries `proovra.tsa.outcome`,
  `proovra.tsa.duration_ms` and, on failure, `proovra.tsa.failure_code` /
  `proovra.tsa.failure_category`.
- Custody: every `TIMESTAMP_APPLIED` / `TIMESTAMP_FAILED` event written since
  2026-10-29 carries `tsaDurationMs` beside `tsaFailureCode`.
- `/admin/runtime/readiness` reports a TSA trust-anchor misconfiguration, not provider health.
- Provider status page for the configured TSA (DigiCert, GlobalSign, FreeTSA, internal).

## Logs to inspect
Filter the API container's stdout on `"event":"tsa.timestamp.`. Each line has
only bounded fields — never the TSA URL, username, password, provider response
body, token or digest:

| field | meaning |
|---|---|
| `provider` | the `TSA_PROVIDER` label (non-identifier values print `UNRECOGNISED_LABEL`) |
| `outcome` | `STAMPED` or `FAILED` |
| `category` | `QUOTA`, `NOT_ISSUED`, `NOT_VALIDATED`, `VALIDATION_FAILED`, `UNSPECIFIED` (shared `tsaFailureCategory`) |
| `failureCode` | the persisted `tsa_failure_code`, e.g. `tsa_provider_unreachable`, `tsa_provider_timeout`, `tsa_provider_http_error`, `tsa_response_parse_failed`, `tsa_token_missing`, `tsa_response_not_granted`, `tsa_token_untrusted` |
| `stage` | where it stopped: `transport`, `reply`, `validation` (`complete` on success) |
| `inputKind` | `FILE_SHA256` or `CANONICAL_PACKAGE_SHA256` |
| `durationMs` | whole round-trip; near `TSA_TIMEOUT_MS` means the provider is hanging |
| `httpStatusClass` | `2xx`/`4xx`/`5xx` when the provider answered; `null` when it was never reached |
| `replyKept` | whether the reply bytes were kept (every failure after the provider answered keeps them, for offline triage) |

Reading it: `stage: transport` + `httpStatusClass: null` → network/DNS/egress;
`5xx` → provider outage; `4xx` → credentials, quota or access; `stage: reply` →
the provider answered with no usable token; `stage: validation` → a token came
back but did not validate (trust anchor, signer, imprint, nonce, policy).

## Rollback procedure
None — timestamping is forward-only against the canonical state.

## Safe recovery procedure
1. **Confirm with the TSA provider's status page.** If the provider has declared an incident: post customer communication (if customer-visible at the per-evidence level) acknowledging the timestamp may be unavailable for newly-finalized evidence during the window.
2. **Confirm `TSA_ENABLED=true`** and `TSA_URL` correct. The 20 s default timeout (`TSA_TIMEOUT_MS`) bounds each request; consider lowering for the duration of the outage if hangs are persistent.
3. **Confirm `TSA_USERNAME` / `TSA_PASSWORD` are not expired** (some TSA providers rotate credentials periodically).
4. **For evidence finalized with `tsaStatus: FAILED`**: nothing restores the timestamp, by design. There is no re-stamp and none may be added (`services/api/test/tsa-no-retry-repo-wide.gate.test.ts`): a token issued now would certify a later moment than the sealing. The honest record stands — `tsaStatus: FAILED` is a first-class field reflecting reality. Only a token that was *received and kept* (`replyKept: true` with category `NOT_VALIDATED`, e.g. `tsa_trust_anchor_not_configured`) can be validated later, offline, by the retained-token repair (`repair-tsa-failed-with-token.ts`), which never contacts the provider.
5. **For sustained outages**: switching to a different TSA provider is a deployment-config change, NOT an in-flight workaround. Document the switch in the operator log + customer-notify if the change affects record-history continuity.

## Validation steps
- A test evidence finalize succeeds with `tsaStatus: STAMPED` + the TSA token populated.
- TSA token verification (operator-driven; OpenSSL `ts -verify`) succeeds against the recorded message imprint.
- `tsaStatus: FAILED` count for the last hour returns to baseline.
- New `tsa.timestamp.stamped` lines appear and `tsa.timestamp.failed` lines stop; `durationMs` is back well under `TSA_TIMEOUT_MS`.

## Escalation conditions
- Outage > 4 hours during business hours → customer-wide notification if customers' evidence will be missing TSA proof for that window.
- A named pilot customer requires TSA proof for their specific legal posture → escalate immediately + document the missing-TSA evidence.
- The TSA provider's certificate changes (re-issuance) → a future bounded phase handles cert rotation; for now, escalate.

## DO NOT DO THIS
- Do NOT mark `tsaStatus: STAMPED` manually. The status is the audit of what actually happened.
- Do NOT bypass the TSA call to "speed up finalization". The timeout (`TSA_TIMEOUT_MS`) bounds it already.
- Do NOT change `TSA_URL` to an untrusted provider "to keep stamping". TSA trust is the integrity contract — only use providers the customer has approved.
- Do NOT silently disable TSA (`TSA_ENABLED=false`) without customer communication. The platform's per-evidence `tsaStatus` field becomes `UNAVAILABLE` and customers may not notice the regression until later.
