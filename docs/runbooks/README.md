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
| [lifecycle-bypass](./lifecycle-bypass.md) | Suspected lifecycle state bypass (FM-LIFE-001/002) |
| [hold-override](./hold-override.md) | Legal hold appears to have been overridden (FM-HOLD-001/002/003) |
| [immutable-drift](./immutable-drift.md) | `immutable_storage_drift_open` alert (FM-RET-001) |
| [retention-precedence](./retention-precedence.md) | Operator reports wrong retention policy in force (FM-RET-002) |
| [export-blocked](./export-blocked.md) | Operator reports compliance export blocked or failing (FM-EXP-001/002/003) |
| [audit-chain-drift](./audit-chain-drift.md) | `audit_chain_drift` CRITICAL alert (FM-AUD-001/002) |
| [worker-wedged](./worker-wedged.md) | Queue not draining / `queue_oldest_pending_age` HIGH (FM-Q-001/002) |
| [ots-degradation](./ots-degradation.md) | `ots_failure_rate` rising or anchor evidence missing (FM-OTS-001/002) |
| [observability-degraded](./observability-degraded.md) | Metrics endpoint not scraping / Sentry silent (FM-OBS-001) |
| [privacy-leak](./privacy-leak.md) | Suspected privileged-data leak in metrics / logs / ledger (FM-PRIV-001/002, FM-OBS-003) |

## Phase Z failure-mode coverage

The right-hand `FM-*` column above maps each runbook to entries in
[`packages/shared/src/failure-mode-audit.ts`](../../packages/shared/src/failure-mode-audit.ts).
That audit map is the canonical catalog of failure modes the platform is
designed to survive. Test coverage lives in
[`services/api/test/phase-z-hardening.test.ts`](../../services/api/test/phase-z-hardening.test.ts).

## Wording invariant

Every runbook MUST use operational language only. Do **not** add words like "breach", "compromise", "verdict", "forensic conclusion", "fraud proof", "court-approved", "legally admissible". Incidents describe **system behaviour**, never legal or forensic conclusions.

Allowed wording: issue, failure, anomaly, outage, increased error rate, restricted, revoked, paused.
