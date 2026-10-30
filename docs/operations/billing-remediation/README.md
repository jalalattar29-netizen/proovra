# Billing remediation ledger

Finding IDs come from the audit of `569fe2e114864e2ad6d42e035e8ad2bc6edf9577`.

**Billing is not "fully fixed".** Source paths are repaired and tested locally against fakes at the provider boundary. Not done yet: the missing Team prices, Stripe and PayPal behaviour in test mode, the PayPal hosted error, and any Live payment-to-entitlement check.

**Status words:** FIXED means changed in code and tested locally. PROVIDER-UNPROVEN means fixed to the documented contract, with no run against the provider. DECISION means a product choice is needed. BLOCKED means it needs evidence or configuration outside this repository.

## Remediation matrix

| Finding | Status | Change | Test | Release requirement |
|---|---|---|---|---|
| AUD-01 Downgrade did not land | FIXED, PROVIDER-UNPROVEN | Plan comes from the billed price. Schedule id stored before editing. Phases restate the current phase from its own start, with the billed price and phase metadata. Failed edits release the schedule | `billing-plan-transition`, `billing-remediation-convergence` | External S3 |
| AUD-02 Event ordering | FIXED, PROVIDER-UNPROVEN | `incomplete` is pending. An event no newer than the record is resolved by a live read, and a read failure makes Stripe redeliver. A paid session applies the plan from the live subscription | `billing-remediation-convergence` | External S1, S2 |
| AUD-03 Entitlement drift | FIXED | Reconciliation repairs it. A plan checkout checks first, answering `PLAN_ALREADY_ACTIVE` | `billing-remediation-convergence` | Dry run R3 |
| AUD-04 Legacy-scoped cancel | FIXED | Dependants resolve by payer, whichever way the row is scoped | `billing-remediation-convergence` | None |
| AUD-05 Refunds, disputes | FIXED, PROVIDER-UNPROVEN | Refunds and disputes recorded for every product, attributed through session or `/v1/invoice_payments` | `billing-remediation-convergence` | External S7 |
| AUD-06 FAILED to SUCCEEDED | FIXED | Allowed on provider proof, with ordering kept | contracts, convergence | None |
| AUD-07 Double storage row | FIXED for new charges | The invoice is the one writer | convergence | Data repair R1 |
| AUD-08 Managed payer | FIXED | A managed identity with a live charge keeps view and cancel only | `billing-account-authorization` | None |
| AUD-09 Cancel state | FIXED | `cancel_at_period_end` projected from every fact. Schedules released before cancel. Unattempted obligations withdrawn on resume. Paid month kept after a provider cancel | convergence | None |
| AUD-10 Eligibility | PART FIXED, DECISION | Purchases refused while the prerequisite plan is ending. D1, D2 open | convergence | Decisions |
| AUD-11 Abandon captured | FIXED | Check modes: `SETTLE` and `OBSERVE`. Abandon only observes | convergence | None |
| AUD-12 Duplicate handling | FIXED | Supersession is durable, retried for ever, and never takes the plan | convergence | None |
| AUD-13 Ambiguous outcomes | FIXED | Timeouts on every provider call. Idempotency keys on plan change, cancel, schedule and revise. Unknown outcomes say so | `billing-plan-transition` | None |
| AUD-14 Permanent 404s | FIXED | Durable check with backoff, review after three misses, excluded from the sweep's queue, nothing revoked | convergence | None |
| AUD-14a API version | FIXED, PROVIDER-UNPROVEN | Pinned to `2025-03-31.basil`. Readers accept both shapes. A missing field no longer erases a date | contracts, convergence | External S9 |
| AUD-15 "Nothing was charged" | FIXED | Claimed only for refusals proven to precede the request | contracts | None |
| AUD-16 Plan recovery unreachable | FIXED | Refresh keeps the projection and the drawer mounted, with a stale-response guard | `billing-recovery` render | Web deploy |
| AUD-17 Refusal copy | FIXED | Every named code has its own copy. An unmapped 409 no longer reads as an input error | `billing-recovery` render | Web deploy |
| AUD-18 Storage recovery | FIXED | In-path Check status, Abandon and Continue. Waiting, activating, paid, failed and unresolved are distinct, and activating survives a reload | render, convergence | Web deploy |
| AUD-19 Other recovery gaps | FIXED | Stripe return read. Unsupported claims removed. Approval links validated. Support reference shown | render | Web deploy |
| AUD-20 Abandoned attempts | FIXED | Back in the sweep for 30 days | convergence | None |
| AUD-21 Catalogue | FIXED in code, BLOCKED in Production | Stricter price checks, per-SKU availability, templates, preflight | contracts | `configuration-repair.md` |
| AUD-22 Error collapse | FIXED | Key refusal separated from outage. Reason stored on the attempt | contracts | None |
| AUD-23 Confirm | FIXED | Bound to a local reference before PayPal is asked. Expected 404 no longer a 500 | convergence | None |
| AUD-24 Rate limits | FIXED | Checkout, capture, confirm, return and payment actions | convergence | Edge limits unknown |
| AUD-25 Isolation | FIXED | PayPal in the credential list. An isolated stack defaults to Sandbox | shared-runtime | None |
| AUD-26 Webhook edges | FIXED | Storage failures no longer swallowed. FAILED recorded. Verifier outage answers 503, not a signature failure. Unattributable events marked | convergence | None |
| AUD-27 Provider text | FIXED | Stripe errors carry status and code only | unit | None |
| AUD-28 Customer reuse | NOT CHANGED, DECISION | Each checkout makes a separate customer. Reusing one needs a binding per payer | | D4 |
| AUD-29 Lower items | PART | Reversal race, crash window, partial refunds, analytics on no-ops, abandoning a pending PayPal capture and the missing owner on admin add-on rows fixed. Three audit items not changed: see known gaps. D3, D5 open | convergence | Decisions |

## Disproven or policy

- Stacking is product behaviour, not a defect. It is kept, with a warning and an intentional-addition statement.
- Import or fixture origin of the ten PayPal ids: disproven by the audit.
- Stripe plan and PayPal payments are single-row: disproven as doubled.

## Decisions needed

Defaults change no customer subscription. Continuing is safe with them.

| ID | Question | Default in this code | Consequence of the default |
|---|---|---|---|
| D1 | Team to Pro: do Team-size add-ons continue? | They continue and keep billing. The plan drawer warns | Customers may pay for a SKU their plan no longer sells |
| D2 | When an internal Team grant ends, what happens to Team-size add-ons? | Nothing, and real charges continue on a lower plan | Same as D1, with no customer action having caused it |
| D3 | Must admin credit grants need step-up? | No: platform admin plus audit, unchanged | Plan grants need step-up and credit grants do not. Adding it needs an admin UI change |
| D4 | Reuse one Stripe customer per payer? | No | Separate customers, and no portal. Changing it must not merge existing owners |
| D5 | Refund of a credit after a post-consumption failure? | None exists; a shortfall goes to review | Handled by support |

## Known gaps in this change

- No real-browser check of the Billing page at phone width or in either theme. Interaction is covered by render tests only.
- Private mobile builds show generic copy for the new storage refusals. No payment behaviour was added there, and the mobile payment policy remains `COMMERCIAL_POLICY_PENDING`.
- AUD-29, not changed: expired grants lack a timely audit record, legacy workspace TEAM never clears, and legacy payments and add-ons stay hidden. These are open audit items, not closed by this branch.
- Two stale files stay in the mobile tree (`billing.tsx.before-plan-fix` and one under `src/ui`).

## Blocked

| Item | Needs |
|---|---|
| Team storage checkout | Live prices, then `configuration-repair.md` |
| PayPal hosted error | `paypal-hosted-error-packet.md` |
| PayPal 404 batch origin | Dashboard recurrence check, audit Q2 |
| Provider behaviour | Approval of `external-test-plan.md` |
| Payment to entitlement in Live | Release, then an owner purchase |

## Documents

- [Configuration repair](configuration-repair.md)
- [Release plan](release-plan.md)
- [Existing-data repair](data-repair-plan.md)
- [PayPal hosted error packet](paypal-hosted-error-packet.md)
- [External test plan](external-test-plan.md)
