# Runbook — Webhook invalid signature burst

**Incident slug**: `webhook-invalid-signature-burst` · **Category**: `WEBHOOK` · **Default severity**: `HIGH`

## Symptoms
- Operational incident with `fingerprint` containing `webhook:security_event:communication_webhook_invalid_signature`.
- `/v1/ops/metrics` → `webhook_invalid_signature_total` counter rising.
- Phase 18 SecurityEvent `communication_webhook_invalid_signature` (HIGH).

## Dashboards / metrics
- `/v1/ops/metrics` → counters `webhook_invalid_signature`, `webhook_invalid_signature_total`.
- /security UI → filter by event type `communication_webhook_invalid_signature`.

## Safe commands / routes
1. Inspect inbound IPs from the SecurityEvent details (we redact bodies; the IP is operator-visible).
2. Confirm `TWILIO_API_SECRET` is set and matches the configured Twilio account.
3. Confirm proxy / load balancer is preserving the `X-Twilio-Signature` header.
4. If a NEW load balancer was introduced recently, check that the public callback URL Twilio POSTs to matches the URL we reconstruct (the signature base includes the full URL).

## What NOT to do
- **Do not** disable the signature check. The Phase 18 webhook routes are signature-gated; turning off validation lets arbitrary callers update message state.
- **Do not** rotate `TWILIO_API_SECRET` without coordinating with the Twilio dashboard — mid-rotation we will fail every callback for the rotation window.

## Rollback / retry guidance
- If the burst correlates with a recent infra change (LB / DNS / proxy), roll back the infra change first.
- Twilio retries failed status callbacks; once signature validation passes, state will catch up.

## Escalation
- > 100 invalid signatures / hour → page on-call. Treat as either a misconfigured proxy OR a malicious probe; the source IP determines which.
