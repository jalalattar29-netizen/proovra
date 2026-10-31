# External test plan: Stripe test mode and PayPal Sandbox

**Status: prepared, not executed, including S10 to S13. Needs approval.** Local tests fake both providers at their module boundary, so they cannot prove what the providers actually do. Everything here uses test or sandbox resources only, against a non-Production stack holding only test credentials.

## Isolation

- Stripe `sk_test_` key, and PayPal Sandbox credentials with `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
- A dedicated database. No Production data.
- Webhooks delivered by `stripe listen` and a Sandbox webhook pointing at that stack.
- Before starting, `/health` must show no live credential names.

## Stripe scenarios

| # | Scenario | Proves | Resources created |
|---|---|---|---|
| S1 | Checkout with a card, record each event's `type`, `created`, `status` | Whether `incomplete` and `active` can tie (AUD-02); the real event order | 1 customer, 1 subscription |
| S2 | Same with a 3DS card, and with a failing card | `incomplete` to `active`, and `incomplete_expired` | 2 subscriptions |
| S3 | Team to Pro downgrade, advance a test clock past period end | **AUD-01: Stripe accepts the schedule update, the phase lands, plan and entitlement move** | 1 schedule, 1 test clock |
| S4 | Downgrade, then upgrade back before landing | Schedule release, no charge | Same clock |
| S5 | Downgrade, then cancel | Release then cancel; no landing | Same clock |
| S6 | Failed renewal then paid retry | FAILED to SUCCEEDED on one invoice (AUD-06) | Test clock |
| S7 | Partial then full refund of an invoice; a lost dispute with the test card | AUD-05, including `/v1/invoice_payments` attribution at the pinned version | Refunds |
| S8 | Metered and yearly prices configured as an offer | Refused before any Session | 2 test prices |
| S9 | Webhook endpoint on an older API version | Shape tolerance | 1 test endpoint |
| S10 | Team to Pro with a Team add-on, agreeing to the end of its renewal, then advance the clock | D1: the add-on keeps its paid date and stops, the plan lands, no substitute is bought | 1 add-on, same clock |
| S11 | Two checkouts by one owner; a plan checkout in a second currency; a credit purchase in a second currency on a customer with an active subscription; a deleted customer | D4: one customer per recurring currency, one-time reuse across currencies, safe replacement | 3 customers |
| S12 | Add-on bought under an internal grant, then the grant ends | D2: cancels at period end | 1 add-on |
| S13 | Same idempotency key sent twice at once, and again after a dropped connection; search by `metadata['proovraCustomerKey']` after five minutes | D4: the 409 and the replay behave as documented, and the search finds the customer | 1 customer |

## PayPal Sandbox scenarios

| # | Scenario | Proves |
|---|---|---|
| P1 | Storage subscription, approve, return | Activation and the return route |
| P2 | Create, leave unapproved past 24 hours, then approve the old link | Whether a late approval works, and what PayPal's GET returns meanwhile (undocumented) |
| P3 | Abandon an approved credit order | No capture |
| P4 | Revise with and without approval | Pending state; `PayPal-Request-Id` behaviour on revise |
| P5 | Cancel a storage subscription mid-period | Paid month kept, then closed |
| P6 | Two partial refunds of a sale | Refund resource shape, and that the amounts add up |

## Cleanup

Delete test clocks, which also removes their customers and subscriptions. Cancel Sandbox subscriptions. Remove the temporary webhook endpoints. Destroy the test database.

## What this still would not prove

Live account configuration, or the original hosted error. Only the post-release Live verification addresses the first, and PayPal support the second.
