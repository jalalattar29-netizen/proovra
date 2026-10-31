# Billing remediation ledger

Finding IDs come from the audit of `569fe2e114864e2ad6d42e035e8ad2bc6edf9577`.

**Source remediation and Production billing verification are different milestones.** This ledger records source work. Nothing here has run in Production, and nothing has run against Stripe or PayPal.

**Status words:** FIXED means changed in code and tested locally. PARTIAL means source work is done and something outside it remains. PRODUCT DECISION means the behaviour follows a recorded decision. DISPROVEN means the claim did not hold. **Provider-unproven** means written to the provider's documented contract and tested against synthetic responses only.

## Decisions

| ID | Decision | Implemented as | Limits |
|---|---|---|---|
| D1 | Team storage after a downgrade: keep what is paid for, stop the renewal | A downgrade that drops a SKU needs `confirmStorageEnding`, recorded on the subscription before the provider call. After the provider confirms, the durable obligation stops each add-on at its own paid date. An add-on nothing can cancel refuses the downgrade (`PLAN_CHANGE_STORAGE_MUST_END_FIRST`). Nothing is replaced or repriced, and no evidence is touched | A downgrade scheduled before this release carries no agreement, so it ends nothing. A confirmed provider cancellation is not undone if the customer later withdraws the downgrade. A PayPal change takes effect only after buyer approval, and the sweep then records it |
| D2 | Storage funded by an internal grant | Activation records `dependsOnPlanGrantId` from the payer, when the paid plan does not offer the SKU. Expiry or revocation records the obligation in the same transaction that closes the grant. A live plan or another grant that covers the SKU keeps it | Add-ons activated before this release have no recorded dependency and are left alone (R6) |
| D3 | Administrative credit grants | The route takes a fresh, single-use `CAPABILITY_GRANT` approval bound to the account credited. The grant and its audit commit in one transaction | A retry needs a new approval and moves nothing |
| D4 | Stripe customer reuse | `billing_provider_customers`, one row per owner, environment and recurring currency, written before the provider call and verified at each checkout. See **Stripe customers and currency** | PayPal has no equivalent. Existing customers are never merged. Provider-unproven |
| D5 | Credits and failure | No change to when a credit is spent. The spend commits inside the finalization transaction, so a failed completion leaves no debit to compensate. A failed report or package retries without another credit, and the record says so | See below |

**D5 in detail.** No compensating ledger entry was added, because no path needs one: a completion that rolls back takes its debit with it. Nothing automatic returns a credit after a successful completion. An integrity-rejected record, a user trash or a record whose output is terminally refused keeps its spend, and any exception goes through support under the refund policy.

**Stacking.** Stacking stays. The confirm panel shows capacity now, add-ons billed now, and what this purchase adds. `heldCount` ties the confirmation to the count the customer saw, so a purchase made in another tab or device asks again. An open purchase on the other provider stops a confirmed addition too.

## Stripe customers and currency

**The contract.** `customer.currency` is the currency a customer "can be charged in for recurring billing purposes". Stripe's support article lists what locks a customer to it: subscriptions not cancelled, schedules not started or active, discounts, draft or open quotes, and pending invoice items. The lock lifts when those are gone. It concerns recurring billing: Stripe's guide states that two active subscriptions cannot have different currencies, and it is not a rule against one-time payments. Sources: [Customer object](https://docs.stripe.com/api/customers/object), [currency lock](https://support.stripe.com/questions/why-are-customers-locked-to-a-specific-currency-and-can-not-be-moved-to-a-price-in-another-currency), [multi-currency customers](https://docs.stripe.com/invoicing/multi-currency-customers).

| Situation | Behaviour |
|---|---|
| Plan or storage checkout | The customer bound for that currency. A new one is created and bound if there is none |
| Credit purchase (one-time) | Any verified customer of the owner, whatever its currency |
| Adopted customer already billed in another currency | Bound under that currency. This checkout gets its own |
| Bound customer later billed in another currency | CONFLICT and a review item. Checkouts in that currency go without a customer until a person resolves it |
| Two checkouts at once, same currency | One row by unique index, one key, one customer |
| Two checkouts at once, different currencies | Two rows and two customers, so neither can lose a race for a first currency |
| Response lost after Stripe created the customer | Retried once on the same key, which Stripe answers with the original |
| Response still lost | The checkout is refused with `CHECKOUT_CUSTOMER_UNRESOLVED` before any session exists, and the row stays CREATING. The next checkout finishes the same creation |
| Creation older than 5 minutes | A key stops being proof: Stripe stores a 500 against it and may prune it after 24 hours. The customer is searched by its `proovraCustomerKey` metadata. Found, it is bound. Not found, the key is replaced |
| Several old customers, or one that does not name the owner | A new customer is created and bound once. Old references stay where they are, so the count stops growing |

**The remaining duplicate.** Stripe Search can lag during an outage. A customer created then could be missed after 5 minutes, leaving one empty, tagged customer that is never charged. Search is also unavailable to Indian businesses, in which case an old creation stays refused.

**The deliberate trade.** A Stripe read failure now refuses that checkout instead of proceeding without a customer. No session exists at that point, so nothing is charged, and proceeding would have created a duplicate.

## Remediation matrix

| Finding | Status | Change | Test | Remaining |
|---|---|---|---|---|
| AUD-01 Downgrade did not land | FIXED | Plan comes from the billed price. Schedule id stored before editing. Failed edits release the schedule | `billing-plan-transition`, `billing-remediation-convergence` | Provider-unproven (S3) |
| AUD-02 Event ordering | FIXED | `incomplete` is pending. A stale event is resolved by a live read | convergence | Provider-unproven (S1, S2) |
| AUD-03 Entitlement drift | FIXED | Reconciliation repairs it. A plan checkout checks first | convergence | Takes effect after deployment. See automatic writes |
| AUD-04 Legacy-scoped cancel | FIXED | Dependants resolve by payer | convergence | None |
| AUD-05 Refunds, disputes | FIXED | Recorded for every product | convergence | Provider-unproven (S7). Webhook events must be enabled. Old rows are R7 |
| AUD-06 FAILED to SUCCEEDED | FIXED | Allowed on provider proof | contracts, convergence | None |
| AUD-07 Double storage row | PARTIAL | The invoice is the one writer for new charges | convergence | Existing doubles stay (R1) |
| AUD-08 Managed payer | FIXED | View and cancel only | `billing-account-authorization` | None |
| AUD-09 Cancel state | FIXED | Projected from every fact. Paid month kept | convergence | None |
| AUD-10 Eligibility | FIXED | Refused while the prerequisite is ending. D1 and D2 decided | `billing-product-decisions` | R6 rows are not changed |
| AUD-11 Abandon captured | FIXED | Abandon only observes, and is refused during a settling capture | convergence | None |
| AUD-12 Duplicate handling | FIXED | Durable supersession that never takes the plan | convergence | A rollback loses this protection |
| AUD-13 Ambiguous outcomes | FIXED | Timeouts and idempotency keys. Unknown outcomes say so | `billing-plan-transition` | None |
| AUD-14 Permanent 404s | FIXED | Durable check with backoff and review, nothing revoked | convergence | Provider-unproven |
| AUD-14a API version | FIXED | Pinned to `2025-03-31.basil`. Both shapes read | contracts, convergence | Provider-unproven (S9) |
| AUD-15 "Nothing was charged" | FIXED | Claimed only when proven | contracts | None |
| AUD-16 Plan recovery unreachable | FIXED | Refresh keeps the drawer | `billing-recovery` render | Web must deploy |
| AUD-17 Refusal copy | FIXED | Every named code has its own copy | `billing-recovery` render | Web must deploy |
| AUD-18 Storage recovery | FIXED | In-path recovery on web and mobile | render, convergence, mobile `billing-recovery` | Web and native must ship |
| AUD-19 Other recovery gaps | FIXED | Web closed earlier. Mobile activity now has Check status, Abandon, and a support path | mobile `billing-recovery`, `billing-accounts.render` | Not run on a device. Continue checkout appears only on private builds; other builds point to the web |
| AUD-20 Abandoned attempts | FIXED | Back in the sweep for 30 days | convergence | None |
| AUD-21 Catalogue | PARTIAL | Stricter price checks and preflight | contracts | Production prices missing |
| AUD-22 Error collapse | FIXED | Key refusal separated from outage | contracts | None |
| AUD-23 Confirm | FIXED | Bound to a local reference | convergence | None |
| AUD-24 Rate limits | FIXED | Payment actions bounded | convergence | Edge limits unknown |
| AUD-25 Isolation | FIXED | PayPal credentials in the isolation list | `test-stack-isolation` | None |
| AUD-26 Webhook edges | FIXED | Failures no longer swallowed | convergence | None |
| AUD-27 Provider text | FIXED | Status and code only | unit | None |
| AUD-28 Customer reuse | FIXED | D4, per currency, written before the call | `billing-product-decisions` | Provider-unproven (S11, S13) |
| AUD-29 Lower items | PARTIAL | All source items closed, including D3, D5, grant expiry, legacy workspace close, and legacy holdings | convergence, decisions | `legacyRecordCapOverride` on grant expiry stays policy, because the audit classed it as not a lockout. Stuck workspaces: R10 |

## Disproven or policy

- Stacking is product behaviour, not a defect.
- Import or fixture origin of the ten PayPal ids: disproven by the audit.
- Stripe plan and PayPal payments are single-row: disproven as doubled.
- Schema comment that a REVERSAL undoes a CONSUMPTION: no such writer existed, and the unique index could not hold one. The comment is corrected.

## Known limits of the source work

- **No dark theme was implemented on web Billing.** `billing.css` has no dark rules, so a dark preference shows the same light page. The real-browser check at 390 and 1440 wide (`e2e/billing-layout`, stubbed API) proves that light page stays readable and on screen under that preference, and nothing more. Other Billing interaction is covered by render tests.
- The mobile app is fixed to one dark appearance (`userInterfaceStyle: "dark"`), with no light mode to compare. Its screens have not been run on a device or simulator. They are covered by Node tests, and `native-build` proves they compile.
- Each older workspace has its own quota, so its capacity never joins the personal total. Billing states each one with its own used, limit, plan and add-on figures, from the same calculation that enforces it, and the monthly total includes its cost because the payer pays it.
- An add-on whose workspace now has another owner is billed to the buyer and counted by no quota. It needs a person (`Q3_ADDONS_COUNTED_BY_NO_QUOTA`).
- A public-store mobile build shows no checkout link. Its copy points to Billing on the web.

## Blocked outside source

| Item | Needs |
|---|---|
| Team storage checkout | Live prices, then `configuration-repair.md` |
| PayPal hosted error | `paypal-hosted-error-packet.md`. Recovery screens do not fix it |
| PayPal account limitation | Support's PDF, then scope and relationship to checkout confirmed |
| PayPal 404 batch origin | Dashboard recurrence check, audit Q2 |
| Provider behaviour | Approval of `external-test-plan.md`. None of it has been run |
| Existing inconsistent records | Separate approval, per `data-repair-plan.md` |
| Automatic lowering and add-on cancellation | Preview, then separate decisions, per `automatic-effects.md` |
| Payment to entitlement in Live | Release, then an owner purchase |

## Documents

- [Configuration repair](configuration-repair.md)
- [Release plan](release-plan.md)
- [Automatic effects](automatic-effects.md)
- [Existing-data repair](data-repair-plan.md)
- [PayPal hosted error packet](paypal-hosted-error-packet.md)
- [External test plan](external-test-plan.md)
