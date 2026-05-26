# Runbook 23 — PayPal webhook recovery

## Symptoms
- Customer reports PayPal payment succeeded but PROOVRA shows no record OR duplicate records.
- PayPal dashboard shows event delivered > 1× to PROOVRA's webhook endpoint.
- `Payment` rows with `provider=PAYPAL` and same `providerPaymentId` exist multiple times.

## Blast radius
Per-payment. PayPal events deduplicate at the `(provider, providerPaymentId)` unique index on `Payment` for capture events, but other event types (subscription-state transitions) lack equivalent dedup. **DEF-044 (OPEN) tracks the missing per-event idempotency table.**

## Detection
- Operator query: `SELECT provider_payment_id, COUNT(*) FROM payments WHERE provider='PAYPAL' AND created_at > NOW() - INTERVAL '24 hours' GROUP BY provider_payment_id HAVING COUNT(*) > 1`.
- PayPal dashboard webhook delivery panel: filter for `RESEND` / `RETRY` deliveries.
- Customer support ticket reporting unexpected charges.

## Logs to inspect
- API logs: `verifyPayPalWebhook` outcome per request.
- PayPal dashboard webhook delivery log for the customer's account.
- `webhooks.routes.ts` line ranges for PayPal handlers (lines 634+).

## Rollback procedure
**For duplicate `Payment` rows from `PAYMENT.CAPTURE.COMPLETED` retries**: the `@@unique([provider, providerPaymentId])` index on the `Payment` model should prevent duplicates at insert time. If duplicates exist anyway, investigate whether the second insert used a different `providerPaymentId` (PayPal sometimes mints child ids).

**For duplicate subscription-state transitions** (DEF-044 risk): manually reconcile via the PayPal dashboard:
1. Identify the canonical subscription state.
2. Manually re-fire the most recent legitimate webhook from the PayPal dashboard.
3. Confirm the local `Subscription` row matches.

## Safe recovery procedure
1. **Identify the customer and the event id(s)** from the PayPal dashboard.
2. **For duplicate captures**: confirm the unique-index protection actually fired by checking API logs for unique-violation errors. If present: webhook returned 5xx; PayPal will retry; expected behavior. No customer impact.
3. **For duplicate subscription state transitions**: confirm whether the second event actually changed local state (if `Subscription.status` was already `CANCELED`, the second `BILLING.SUBSCRIPTION.CANCELLED` is a no-op at the side-effect level).
4. **For genuine corruption** (rare): contact incident response (runbook 11). Reconcile from PayPal dashboard as source of truth; document in incident log.

## Validation steps
- The customer's `Payment` rows + `Subscription` row match PayPal dashboard state exactly.
- No `Payment` row has a unique-violation history without a corresponding successful row.
- No `Subscription.status` transition was applied twice.

## Escalation conditions
- A customer has been charged but no `Payment` row exists → incident response.
- A subscription was canceled by a duplicate webhook → incident response + customer-notification.
- DEF-044 (PayPal idempotency) closure is being planned → ensure runbook is updated when the dedup table lands.

## DO NOT DO THIS
- Do NOT disable PayPal webhook signature verification.
- Do NOT manually create `Payment` rows. The webhook handler is the single writer.
- Do NOT bypass the `@@unique([provider, providerPaymentId])` index. The unique violation is intentional protection.
- Do NOT delete duplicate `Payment` rows without recording the resolution in the operator log.
- Do NOT trust PayPal `event.id` for dedup until DEF-044 lands an `event_id`-keyed dedup table. Current code uses `Payment.providerPaymentId` for capture dedup only.
