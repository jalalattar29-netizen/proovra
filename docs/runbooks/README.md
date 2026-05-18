# PROOVRA Operational Runbooks

These runbooks are the operator's first stop when an incident fires. Each one is referenced from the corresponding `OperationalIncident.runbookSlug` (Phase 21).

## Index

| Slug | When it fires |
|---|---|
| [stuck-upload](./stuck-upload.md) | Upload session has been UPLOADING > 1 hour with no finalize event |
| [failed-report-generation](./failed-report-generation.md) | Report generation job failed or stuck in PROCESSING > 1 hour |
| [failed-verification-package](./failed-verification-package.md) | Verification package job failed |
| [twilio-outage](./twilio-outage.md) | Twilio SMS / WhatsApp / Verify sustained failure rate |
| [webhook-invalid-signature-burst](./webhook-invalid-signature-burst.md) | Invalid Twilio / Stripe / PayPal webhook signature burst |
| [database-readiness-failure](./database-readiness-failure.md) | `/readyz` returns 503 with `db_unreachable` |
| [suspicious-login-burst](./suspicious-login-burst.md) | Phase 19 identity-security risk signals (FAILED_OTP_BURST, IMPOSSIBLE_TRAVEL, ...) |
| [storage-write-failure](./storage-write-failure.md) | S3 put/head/get failure burst |
| [workflow-stuck](./workflow-stuck.md) | Phase 22 workflow stuck in SUBMITTED / NEEDS_REVIEW too long |
| [workflow-intake-abuse](./workflow-intake-abuse.md) | Phase 22 intake link abuse / contributor token failure burst |

## Wording invariant

Every runbook MUST use operational language only. Do **not** add words like "breach", "compromise", "verdict", "forensic conclusion", "fraud proof", "court-approved", "legally admissible". Incidents describe **system behaviour**, never legal or forensic conclusions.

Allowed wording: issue, failure, anomaly, outage, increased error rate, restricted, revoked, paused.
