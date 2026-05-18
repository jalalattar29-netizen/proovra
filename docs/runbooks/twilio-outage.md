# Runbook — Twilio outage / sustained failure

**Incident slug**: `twilio-outage` · **Category**: `COMMUNICATIONS` · **Default severity**: `HIGH`

## Symptoms
- `operational_incidents` row with `fingerprint` containing `communication_message_failed` or `verification_check_failed`.
- `/v1/ops/metrics` → `communication_message_failed` counter rising; `communications_retry_scheduled` gauge climbing.
- /communications UI shows messages stuck in `RETRY_SCHEDULED` or `FAILED`.

## Dashboards / metrics
- `/v1/ops/metrics` → `communication_message_failed`, `verification_check_failed`, gauge `communications_retry_scheduled`.
- /communications UI provider-health card → should show `Twilio` + `ready`. If shown `noop`, config violation.

## Safe commands / routes
1. Check Twilio status page out-of-band.
2. `POST /v1/communications/process-retries` (cron secret) — drains the retry queue.
3. `GET /v1/ops/health` → confirms `snapshot.communications.configured = true` and the provider health.

## What NOT to do
- **Do not** rotate `TWILIO_API_SECRET` to "force a reconnect" — the provider holds no long-lived state.
- **Do not** mass-cancel `RETRY_SCHEDULED` rows. The Phase 18 retry processor is bounded; let it drain.
- **Do not** disable `COMMUNICATIONS_ENABLED` in prod — that turns OTP send to a fail-closed Noop and locks operators out of step-up.

## Rollback / retry guidance
- If Twilio status page reports an incident: wait. Retries respect exponential backoff.
- If our IPs are blocked: contact Twilio support; do NOT change provider env without an outage decision.

## Escalation
- > 50% provider failure rate for > 15 minutes → page on-call. If SMS / WhatsApp + Verify all fail, OTP-based step-up is impacted; consider temporarily suspending sensitive operator actions.
