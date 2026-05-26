# Runbook 22 — Billing provider outage (Stripe / PayPal global)

## Symptoms
- Customers report checkout failures on `/billing/checkout/*` endpoints.
- Stripe / PayPal status page declares an incident.
- Webhook deliveries dry up (no events received for > 15 min during normal-traffic window).
- New subscriptions stall mid-checkout.

## Blast radius
Global — all customers attempting to upgrade / subscribe / change plan during the outage. Existing subscriptions remain active (provider continues honoring the existing billing state).

## Detection
- Stripe status page: `https://status.stripe.com`.
- PayPal status page.
- `StripeWebhookEvent` row count for the last 60 min noticeably below normal.

## Logs to inspect
- API logs: `verifyStripeSignature` exceptions.
- API logs: `parseStripeEvent` exceptions.
- Stripe dashboard webhook delivery panel (provider-side log).

## Rollback procedure
None — billing is provider-managed. Existing customer subscriptions continue per the provider's last-known state.

## Safe recovery procedure
1. **Confirm with provider status page.** If the provider has declared an incident, post a customer communication acknowledging the outage and that new sign-ups / plan changes are temporarily unavailable. Do NOT speculate about ETA.
2. **Do NOT disable the webhook handler** on the platform side. The handler must accept events once the provider resumes delivery; disabling means losing the first wave of recovery events.
3. **Monitor `StripeWebhookEvent` insert rate.** When it returns to normal, the platform has begun processing the recovery wave. Per-event idempotency (E10.1) handles any duplicates the provider may re-deliver during their incident recovery.
4. **For PayPal**: events arriving during the outage window may not be deduplicated (DEF-044 OPEN). Manually inspect `Payment` rows created in the outage window for duplicates against the PayPal dashboard.
5. **Sync subscription state** for customers whose plan-change was in flight: re-fire the relevant webhook from the provider dashboard (Stripe supports this; PayPal requires admin contact).

## Validation steps
- New `StripeWebhookEvent` rows arrive at the normal rate.
- A test checkout (operator-driven, in a sandbox tenant) completes end-to-end.
- No `Payment` rows in the outage window are duplicated against the provider's record.
- No `Subscription` rows have `status` inconsistent with the provider's record (manual sample of ≥10 rows from the outage window).

## Escalation conditions
- A customer reports a charge with no corresponding `Payment` row → incident response (runbook 11). Provider-side audit may be required.
- A customer reports their subscription was canceled by the platform during the outage window → INCIDENT.
- The outage persists > 4 hours during a high-traffic window → consider customer-wide proactive notification.

## DO NOT DO THIS
- Do NOT manually create `Payment` rows to "reconcile" missing webhooks. The webhook handler is the single writer; bypassing it breaks the audit trail.
- Do NOT manually mutate `Subscription.status` to match what you think the provider thinks. Re-fire the webhook from the provider dashboard instead.
- Do NOT issue refunds outside the provider dashboard. The provider is the source of truth.
- Do NOT disable webhook signature verification "to test" — the signature is the only authentication of webhook source.
