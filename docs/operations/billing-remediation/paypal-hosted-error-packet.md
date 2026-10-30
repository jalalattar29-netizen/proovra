# PayPal hosted approval error: diagnostic and support packet

**Status: cause unknown.** No code change in this release is claimed to fix it. Better local recovery means a customer who hits this page can see and resolve what happened. It does not explain why PayPal showed it.

## What was observed

- Page: `https://www.paypal.com/webapps/billing/error`, with a generic system-error message in German.
- Attempt: `b9f4246d-cf80-4b75-b02c-a6d0c4cfe4ac`, TEAM_500_GB, created 2026-10-30T04:19:51.842Z, provider-bound.
- No failed API request appears locally. That is expected: the hosted page reports nothing to PROOVRA, so it proves no cause.

## What is established from source

- The approval link came straight from PayPal's create response, and each attempt creates a fresh subscription.
- PayPal's plan read and create both succeeded for this attempt.
- The link is not stored and not reused.

## What is not established

Provider outage, buyer or merchant account conflict, cancellation, a charge, or absence of one. None of these should be claimed.

## Read-only evidence to gather

From the attempt row (the audit's Q2 query, section G, reads these without printing a user id):

| Field | Why it matters |
|---|---|
| `providerDebugId` | PayPal's correlation id for the create call. Support needs this |
| `providerEnvironment` | Confirms LIVE |
| `providerPlanId` | The plan the buyer was sent to approve |
| `approvalLinkIdentity.host`, `.path`, `.rel` | Shows the link's shape, not its token |
| `lastProviderCheck` | What PayPal last said about it |

From the owner, by hand:
1. The time of the error, in a known timezone.
2. Whether the buyer's PayPal account is the merchant's own account. This is a question to answer, not a conclusion.
3. Buyer's country, and whether the card or balance can pay in EUR.
4. In the PayPal dashboard: the subscription's status, and whether the ten 404 ids recur hourly.

## Message for PayPal Merchant Technical Support

Send only after filling the debug id from the row above. Do not send tokens, full approval URLs, or customer data.

> We create billing subscriptions through the REST API. One buyer reached `/webapps/billing/error` with a generic system error during approval. Create returned success. Plan id, subscription id, debug id and time are attached. Please tell us why the hosted approval failed, and whether this subscription can still be approved.

## Separately: is the hosted failure recurring?

After release, Billing activity shows the attempt's real state, and approvals left open are re-read by the sweep. A rising count of `AWAITING_CUSTOMER_APPROVAL` attempts closed as `LOCALLY_EXPIRED` would suggest a wider problem. One attempt does not.
