# Existing-data repair plan

**Status: prepared, not executed.** No migration rewrites a row, and no repair below runs by itself. **But deploying the images does change existing rows**, through the sweep and ordinary reads. Section A lists every such write. Section B lists historical repairs, each needing its own approval after its dry-run count is known.

**Lowering a plan and starting an add-on cancellation are held until switched on, whatever a deployment approval says.** `automatic-effects.md` gives their exact predicates, dates and limits, and supersedes the lines for them here. Approving a deployment approves the rest of section A and nothing in section B.

## Dry run (read-only)

Inside the API container. Before the migrations it is partial: a line that needs them prints `"count":null` and the script exits 3. That null is unknown, not zero. Exit 0 means every line was counted.

```bash
docker exec -w /app/services/api docker-proovra-api-1 node scripts/billing-repair-dry-run.mjs
```

It uses one READ ONLY transaction with timeouts, calls no provider, and prints counts and dates only, no person's identity.

The `AUTO_` lines count what section A will touch. They are previews: the code decides row by row, and a provider read can change the answer.

## A. Automatic convergence after deployment

Each write below needs no operator. Every one is idempotent: a row already converged is not written again.

| Write | Trigger | Eligibility | Scope | Audit | Rollback consequence | Preview |
|---|---|---|---|---|---|---|
| **R3** Entitlement moved to the plan paid for. **Lowering is held (P1)** | Hourly sweep, plan checkout | Live subscription, entitlement differs, provider read agrees | One account's entitlement | Plan-change audit row | Stays; the old image can drift again | `R3_ENTITLEMENT_DRIFT`, `AUTO_R3_WOULD_LOWER_PLAN` |
| **R4** Past-date downgrade landed. **Held (P2)** | Hourly sweep | Pending change past its date, provider bills the lower price | Subscription and entitlement | Plan-change audit row | Stays | `R4_STRIPE_PENDING_DOWNGRADE_PAST_DUE_DATE` |
| **R5** Renewal date restored | Next read of the subscription | Active Stripe row with no date | `current_period_end` only | None; a provider date restored | Stays | `R5_ACTIVE_WITHOUT_PERIOD_END` |
| **R11** Internal grant closed | Hourly sweep | Unrevoked and past expiry | One grant row. Add-ons recorded as depending on it get an obligation, and pre-release rows have none | `billing.internal_grant.expired`, same transaction | Stays | `R11_INTERNAL_GRANTS_PAST_EXPIRY` |
| Provider binding checks | First read that gets a 404 | A stored reference the provider does not know | New `billing_provider_binding_checks` row. Nothing revoked | Row itself; review item after three misses | Stays, unread | `AUTO_PROVIDER_REFERENCES_NOT_YET_CHECKED` (upper bound, the rest depends on the provider) |
| **Add-on cancellation at the provider. Starting one is held (A1). Retrying a recorded one is not (A2)** | Hourly sweep | Paid-plan SKU, its base has ended or is ending, no live plan offers it | Stripe period-end cancel, or PayPal cancel with the paid month kept | Obligation columns; Operations condition | Provider cancellation stays | `AUTO_ADDON_CANCELLATION_WOULD_BE_OWED`, `AUTO_ADDON_OBLIGATIONS_OPEN` |
| Unsupported obligations withdrawn | Before any attempt | The rule no longer supports the obligation | Obligation columns | `OBLIGATION_WITHDRAWN_NOT_DEPENDENT` | Stays | Not separately counted |
| Add-on closed after its paid date | Hourly sweep | `expires_at_utc` passed | Status to CANCELED | Row itself | The old image will not close these | `AUTO_ADDONS_PAST_PAID_END` |
| Superseded duplicate cancelled at the provider | Hourly sweep | Recorded supersession with a retry due | Provider cancel of the duplicate | Supersession columns; review after exhaustion | Provider cancellation stays | `AUTO_SUPERSEDED_CANCELS_DUE` |
| Abandoned PayPal attempts re-read | Hourly sweep, 30 days | R9 rows | May activate storage the provider proves live | Attempt state | Stays | `R9_BOUND_PAYPAL_ATTEMPTS_ABANDONED` |

**Writes that only happen for new customer actions, never to existing rows at deployment:** a downgrade agreement and its obligations, grant dependencies, legacy workspace closure when a subscription ends, and Stripe customer creation or adoption at a checkout. Adoption reads Stripe and writes one local row. Creation writes one Live customer.

**Not automatic, even after deployment:** R1, R2, R6, R7, R8, R10.

## B. Findings and what each one needs

| ID | What it finds | What the release does by itself | Separate repair, if approved |
|---|---|---|---|
| R1 | One storage charge recorded twice (session + invoice) | New purchases write one row | Mark the session row with a non-revenue `product` value, after confirming each pair. Never delete. Revenue reports change, so finance should see the count first |
| R2 | Stripe plan CANCELED, never activated, with a paid invoice | Nothing reads CANCELED rows, so these stay | Read each subscription live. If Stripe says active, apply the live state through the normal writer. Requires a re-check tool run per account |
| R3 | Live plan with stale entitlement | The sweep raises a plan paid for and holds one it would lower | If held, a decision per `automatic-effects.md` |
| R4 | Stripe downgrade past its date, not landed | Held by the sweep. A provider webhook still lands it | A decision per `automatic-effects.md`. A remaining row after that means the schedule never existed: review it |
| R5 | Active Stripe row with no renewal date | The next read restores it | None |
| R6 | Team-size add-on with no live Team plan | Rows with an ended base get the cancellation in section A. Rows with no identifiable base get nothing. D1 and D2 apply to future changes only | Each remaining row needs an owner's decision. **Do not cancel customer subscriptions to apply a policy retroactively** |
| R7 | Refunded payments with `refunded_amount_cents` 0 | New refunds record it | Set the column to `amount_cents` only where a provider read confirms a full refund. Reports should keep treating status REFUNDED as authoritative |
| R8 | Negative wallet | New reversals cannot produce one | Review each with its ledger. Never adjust a balance without a ledger entry |
| R9 | Locally closed PayPal attempts that may still be approvable | The sweep re-reads them for 30 days | None automatically |
| R10 | Owned workspace live on TEAM with no live subscription scoped to it | Nothing for existing rows. Only a subscription ending after release closes one | Read each payer's provider state first. Closing one moves that workspace to Free limits, so each needs an owner decision. Nothing is deleted |
| R11 | Internal grants past expiry, not yet closed | **The sweep closes and audits these** | None. The count should reach zero after the first sweep. Add-ons bought under them have no recorded dependency, so they stay as R6 |
| R12 | Payers with several historical Stripe customers | Nothing to existing records. Their next checkout binds one customer per the rules in the ledger, so the count stops growing | None proposed, because none is needed: old customers keep paying their own subscriptions. Merging is not authorised |
| Q1 to Q4 | Where live add-ons are counted | Q1 rows start counting in the personal quota | Q3 rows need a person: billed to the buyer and now shown to them, but counted by no quota |

## Rules for any repair

1. Run the dry run first, and record the counts.
2. Read the provider for each row before writing. A local inference is not a reason to change money or entitlement.
3. Go through the normal writers, not raw `UPDATE`s, so audit and analytics stay truthful.
4. Keep the original amounts and history. Nothing is deleted.
5. Do not revoke an entitlement because a provider answered 404.

## The ten PayPal ids and the open attempt

- **Ten 404 ids:** on first read after release, each gets a `billing_provider_binding_checks` row, and after three misses a review item. Nothing is revoked, and the rows are not deleted.
- **The open PayPal storage attempt from the incident:** untouched by this release, and not to be reconciled or abandoned without approval.
