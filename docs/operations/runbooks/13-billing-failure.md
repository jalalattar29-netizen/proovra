# Runbook 13 — Billing failure

**Scope:** customer reports incorrect billing state, failed payment, plan mismatch, or unexpected charge / refund. Coordinates with Stripe — the source of truth for all billing events.

**Prerequisites:**

- Operator access to the Stripe dashboard (production mode).
- Read access to the workspace `Team` / `Subscription` / `Payment` rows.
- Operator account with billing-management capability.

**Forbidden:**

- Manually mutating `Team.billingPlan` / `Subscription.status` / `Payment.amountCents` to "fix" a discrepancy. Stripe is source of truth; the platform mirrors. If the DB and Stripe disagree, reconcile from Stripe.
- Issuing refunds outside the Stripe dashboard.
- Pasting any `sk_live_*` / `whsec_*` value into the incident channel.

---

## Steps

1. **Capture the customer's expectation.** What plan did they expect? What did they see charged? What action did they take immediately before?

2. **Read the workspace's billing snapshot.** `Team.billingPlan`, `Team.billingStatus`, `Subscription.status`, `Subscription.stripeSubscriptionId`, the most recent 5 `Payment` rows.

3. **Open the corresponding Stripe subscription.** Compare the canonical states:

| Property | Team (DB) | Stripe (truth) | Action if mismatched |
|---|---|---|---|
| Plan code | `billingPlan` | Active price / product | Sync via webhook re-fire if needed |
| Status | `billingStatus` | Subscription status | Re-fire the latest webhook from Stripe dashboard |
| Subscription id | `stripeSubscriptionId` | Subscription id | If DB null but Stripe active → check webhook history for missed event |
| Seats included | `includedSeats` | Quantity on the subscription item | DEF-041 known gap; reconcile by hand |

4. **Drift root cause.** Common shapes:
   - Missed webhook (Stripe → server) — check Stripe dashboard for the most recent event delivery status. If FAILED, re-deliver from the Stripe UI.
   - Duplicate webhook (Stripe → server twice with same `event.id`) — **DEF-038 (BLOCKS_LAUNCH)** is currently OPEN. The handler may have created duplicate payment rows. Identify duplicates by `(stripeEventId, paymentIntentId)`; manually mark one as superseded. Do NOT refund or void on Stripe side without confirming the customer was double-charged.
   - Stripe test key was used in production — `runStartupConfigValidation()` rejects `pk_*` shape but not `sk_test_*` shape. If the customer's payment was processed against a test key, escalate to incident response (runbook 11).
   - Plan downgrade — operator-driven; check audit log for the downgrade action + actor.

5. **Failed payment specific:**
   - `invoice.payment_failed` event handler updates `Payment.status = "FAILED"` (line 577 of `webhooks.routes.ts`). The subscription remains in its current Stripe status until Stripe transitions it (typically to `PAST_DUE` after the first retry).
   - Customer-facing message: "the payment did not succeed; please update your payment method via the billing page." Do NOT cancel the subscription manually.
   - Stripe retries automatically per the merchant's smart-retry config. Do not duplicate the retry server-side.

6. **Subscription cancellation specific:**
   - `customer.subscription.deleted` event handler calls `syncPlanForSubscription()` (line 500 of `webhooks.routes.ts`). Plan transitions to `CANCELED`; personal users downgrade to `FREE`.
   - Evidence access semantics on downgrade: existing evidence remains readable; new captures gate on the post-downgrade plan's capability set.
   - Customer asking "where did my evidence go?" — re-read the workspace's `Evidence` rows. Evidence is NEVER deleted by a plan change. Re-confirm with the customer that they can still see the evidence; if not, escalate (runbook 11).

7. **Workspace plan vs Stripe subscription mismatch (DEF-041):** if the team's `billingPlan` shows TEAM but no active Stripe subscription is found, the most likely cause is a missed webhook. Re-fire the latest `customer.subscription.*` event from Stripe. If still mismatched, escalate to incident response with the Stripe subscription id.

8. **Refund request:** check the customer's refund policy entitlement. Issue the refund in Stripe. The `charge.refunded` webhook event will update the corresponding `Payment.status` to `REFUNDED` automatically (handler line ~620 of `webhooks.routes.ts`).

9. **Document.** Update the support ticket: actual customer-facing event, root cause classification (missed webhook / duplicate webhook / drift / customer-driven), remediation, customer notification.

---

## Honest gaps

- **DEF-038 (BLOCKS_LAUNCH):** Stripe webhook event idempotency NOT implemented. Duplicate events can create duplicate payment rows. Pre-launch fix REQUIRED; until then, double-check duplicate-event scenarios manually.
- **DEF-041 (POST_LAUNCH):** No automatic reconciliation between `Team.billingPlan` and active Stripe subscription. Operator action required when drift is detected.
- Stripe test key in production: `runStartupConfigValidation()` rejects publishable-key shape (`pk_*`) but does not reject `sk_test_*` in production. Pre-launch: confirm `STRIPE_SECRET_KEY` starts with `sk_live_` in production environments.
