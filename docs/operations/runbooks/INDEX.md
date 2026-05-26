# Runbook Index

Phase E10.2 — canonical mapping of every required operational runbook to its file in this directory.

The runbooks are numbered (00–29) by introduction order; this index gives the topical names that the operational playbook references.

| Topical name | File | Phase |
|---|---|---|
| incident-response | `11-incident-response.md` | E10 |
| reviewer-queue-failure | `20-reviewer-queue-failure.md` | E10.2 |
| upload-stall-recovery | `12-failed-upload-report-package.md` (Failed upload section) | E10 |
| immutable-storage-drift | `21-immutable-storage-drift.md` | E10.2 |
| billing-provider-outage | `22-billing-provider-outage.md` | E10.2 |
| stripe-webhook-recovery | `13-billing-failure.md` (Stripe section) | E10 |
| paypal-webhook-recovery | `23-paypal-webhook-recovery.md` | E10.2 |
| resend-email-failure | `24-resend-email-failure.md` | E10.2 |
| twilio-failure | `25-twilio-failure.md` | E10.2 |
| SAML-login-failure | `15-saml-sso-failure.md` | E10 |
| redis-outage | `26-redis-outage.md` | E10.2 |
| search-index-recovery | `27-search-index-recovery.md` | E10.2 |
| retention-job-failure | `28-retention-job-failure.md` | E10.2 |
| governance-reconciliation | `29-governance-reconciliation.md` | E10.2 |
| TSA-provider-failure | `30-tsa-provider-failure.md` | E10.2 |
| OTS-anchor-delay | `31-ots-anchor-delay.md` | E10.2 |
| report-render-failure | `12-failed-upload-report-package.md` (Failed report section) | E10 |
| verification-package-failure | `12-failed-upload-report-package.md` (Failed package section) | E10 |
| AI-provider-outage | `16-ai-unavailable.md` | E10 |
| recovery-restore-validation | `01-db-restore.md` + `09-audit-custody-validation.md` | E6 |

Total: **20 mandatory topical runbooks**, all reachable.

## All runbooks in this directory

| # | File | Domain |
|---|---|---|
| 00 | rehearsal-log | DR rehearsal log |
| 01 | db-restore | DR |
| 02 | object-storage-restore | DR |
| 03 | worker-restart | Worker runtime |
| 04 | automation-recovery | Automation |
| 05 | webhook-retry-recovery | Webhook delivery |
| 06 | signing-key-recovery | Signing |
| 07 | degraded-mode-startup | Boot |
| 08 | report-package-regen | Reports / packages |
| 09 | audit-custody-validation | Integrity |
| 10 | support-triage | Support |
| 11 | incident-response | Incident |
| 12 | failed-upload-report-package | Upload / report / package |
| 13 | billing-failure | Billing |
| 14 | external-intake-failure | External intake |
| 15 | saml-sso-failure | SSO |
| 16 | ai-unavailable | AI |
| 17 | monitoring-readiness | Monitoring |
| 18 | production-secret-audit | Ops procedure |
| 19 | saml-pilot-rehearsal | Ops procedure |
| 20 | reviewer-queue-failure | Reviewer ops |
| 21 | immutable-storage-drift | Storage |
| 22 | billing-provider-outage | Billing |
| 23 | paypal-webhook-recovery | Billing |
| 24 | resend-email-failure | Notifications |
| 25 | twilio-failure | Notifications |
| 26 | redis-outage | Infra |
| 27 | search-index-recovery | Search |
| 28 | retention-job-failure | Governance |
| 29 | governance-reconciliation | Governance |
| 30 | tsa-provider-failure | Timestamping |
| 31 | ots-anchor-delay | Timestamping |
