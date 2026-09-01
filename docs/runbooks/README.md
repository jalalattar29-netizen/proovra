# PROOVRA Operational Runbooks

These runbooks are the operator's first stop when an incident fires. Each one is referenced from the corresponding `OperationalIncident.runbookSlug` (Phase 21).

## Index

This table is complete against `docs/runbooks/` and is gated by
`apps/web/__tests__/runbook-catalog-freshness.test.ts`, which also builds the
in-product reader at `/admin/platform/runbooks` from these same files. If you
add a runbook, add a row here, add a curation entry in
`apps/web/scripts/generate-runbook-catalog.mjs`, and re-run that generator.

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
| [reviewer-escalation-storm](./reviewer-escalation-storm.md) | `runReconcile()` created ≥ threshold escalations in a single sweep |
| [search-index-degraded](./search-index-degraded.md) | The workspace search index is out of step with its records and nothing is closing the gap. Nothing evidential is affected |
| [signing-backlog](./signing-backlog.md) | Uploaded evidence is unsigned past the aged cutoff — the upload finished, the signing step did not |
| [tsa-timestamp-failure](./tsa-timestamp-failure.md) | `Evidence.tsaStatus = FAILED` — the RFC3161 timestamp could not be obtained. There is no retry, by design |
| [production-diagnostic-handoff](./production-diagnostic-handoff.md) | Operator procedure for running the read-only production diagnostic and destroying its output |
| [reviewer-sla-breach](./reviewer-sla-breach.md) | A reviewer SLA cycle breached its due time |
| [reviewer-escalation-backlog](./reviewer-escalation-backlog.md) | Escalations accumulating faster than they are cleared |
| [reviewer-inactivity](./reviewer-inactivity.md) | An assigned reviewer has gone quiet on live work |
| [reviewer-queue-stuck](./reviewer-queue-stuck.md) | The reviewer queue stopped draining |
| [disaster-recovery](./disaster-recovery.md) | DR posture, targets, and the restore procedure. Not incident-fired — read before you need it |
| [security-review](./security-review.md) | Security review / procurement checklist. Not incident-fired |
| [pentest-readiness](./pentest-readiness.md) | Penetration-test readiness. Not incident-fired |
| [sre-runbooks](./sre-runbooks.md) | Index of SRE operator procedures. Not incident-fired |


## Phase Z failure-mode coverage

The right-hand `FM-*` column above maps each runbook to entries in
[`packages/shared/src/failure-mode-audit.ts`](../../packages/shared/src/failure-mode-audit.ts).
That audit map is the canonical catalog of failure modes the platform is
designed to survive. Test coverage lives in
[`services/api/test/phase-z-hardening.test.ts`](../../services/api/test/phase-z-hardening.test.ts).

## Wording invariant

Every runbook MUST use operational language only. Do **not** add words like "breach", "compromise", "verdict", "forensic conclusion", "fraud proof", "court-approved", "legally admissible". Incidents describe **system behaviour**, never legal or forensic conclusions.

Allowed wording: issue, failure, anomaly, outage, increased error rate, restricted, revoked, paused.
