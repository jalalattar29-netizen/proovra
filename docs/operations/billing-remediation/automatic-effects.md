# Automatic effects on existing billing records

**Status: prepared, nothing has run.** No count below comes from Production, because none has been read. The preview produces them.

Approving a deployment does **not** approve the actions in section 1. They stay off until a person has read the preview and turned them on. Section 2 runs without a switch, so it is listed for approval with the release.

## The switches

| Variable | Unset or anything but `on` | `on` |
|---|---|---|
| `BILLING_AUTO_PLAN_LOWERING` | The sweep leaves the plan and raises review item `AUTOMATIC_PLAN_LOWERING_HELD` | The sweep lowers it |
| `BILLING_AUTO_ADDON_CANCELLATION` | The sweep starts no cancellation and raises review item `AUTOMATIC_ADDON_CANCELLATION_HELD` | The sweep records the obligation and calls the provider |

- **They hold the sweep only.** A Stripe or PayPal webhook still applies the provider's own fact, a renewal webhook included. A customer's own cancellation, an agreed downgrade (D1) and an ended grant (D2) still record their obligations.
- **Raising a plan is never held.** A customer who paid for more than their entitlement shows is corrected at once.
- Setting either switch is a Production configuration change and needs its own approval.
- **Unverified on the host:** which container runs the sweep. Set a switch on both the API and worker services.

## Preview (read-only)

Run after the migrations, before the new image serves anything, as a one-off container of the new image. `$ROLLOUT` is defined in `docs/operations/internal-grant-production-rollout.md`.

```bash
$ROLLOUT dist/scripts/billing-automatic-effects-preview.js
```

- It decides with the functions the sweep calls, so it cannot describe a different set. `billing-automatic-effects-preview.integration.test.ts` compares its list with what the sweep then records.
- Its database connection is held read-only by Postgres, and it refuses to run otherwise.
- Output: one JSON line per record, with record ids, dates and counts. No name, email or user id. Summary lines give the count and recurring amount per action, provider and month.
- Exit 0: complete. Exit 3: some provider reads did not answer. Exit 2: failed, do not rely on it.

`P2` and `P3` need the provider, which the local rows cannot answer for. This form makes one read-only GET per live subscription against Live Stripe and PayPal, so run it only with that approved:

```bash
$ROLLOUT dist/scripts/billing-automatic-effects-preview.js --with-provider-reads
```

Without it, the `SWITCHES` line reports how many subscriptions were not checked at the provider.

## 1. Held until switched on

### Actions that can lower a plan

Switch: `BILLING_AUTO_PLAN_LOWERING`. All three need a provider read that succeeded and is not older than the row's last provider fact. All three take effect at the sweep that finds them: **there is no paid-through protection, because the provider is already billing less or nothing.**

| ID | Preview action | Exact predicate | Audit | Rollback limit |
|---|---|---|---|---|
| P1 | `LOWER_ENTITLEMENT_TO_SUBSCRIPTION` | `findLivePersonalBaseSubscription` returns this subscription (not superseded, `provider_sub_id` set, ACTIVE or PAST_DUE), and the active entitlement's plan ranks above the subscription's plan, and that plan is FREE, PRO or TEAM. In practice TEAM to PRO | `setPersonalPlan` writes the from and to audit, with service actor `billing_reconciliation` | An older image leaves the lowered plan as it is. Restoring it is a manual plan change, and the sweep repeats the lowering while the switch is on |
| P2 | `LOWER_SUBSCRIPTION_TO_BILLED_PRICE` | Stripe only. `planFromStripePriceId` of the billed price ranks below the row's plan. Includes a downgrade past its date (R4), and any other row billed lower than it says | Same, plus the subscription row's updated plan | Same. The provider's price stays what it was: nothing is changed there |
| P3 | `END_PLAN_PROVIDER_REPORTS_ENDED` | The provider reports cancelled or expired while the row is ACTIVE or PAST_DUE. The plan moves to a surviving subscription's plan, or to FREE | Same | Same. Add-ons that depended on it then fall under A1 |

### Actions that cancel an add-on at the provider

| ID | Preview action | Exact predicate | Effective date | Paid-through | Audit | Rollback limit |
|---|---|---|---|---|---|---|
| A1 | `CANCEL_ADDON_AT_PROVIDER` | `owedDependentCancellations`: MONTHLY, provider subscription set, ACTIVE or PAST_DUE, payer owns it, state `NONE`, the SKU is not in the Free catalogue, and no live not-ending plan offers it, and no live internal grant offers it, and either the base it recorded has ended, or it recorded none and an ended base carried a paid entitlement on a plan that offered the SKU | **Stripe:** `cancel_at_period_end`, so it stops at `paidThroughUtc`. **PayPal:** PayPal has no period-end cancel, so renewal stops at the sweep | **Stripe:** kept to `paidThroughUtc`. **PayPal:** kept to `paidThroughUtc` only when the row is ACTIVE, activated, and that date is in the future. Otherwise **capacity ends at the sweep**: the preview shows `capacityKeptUntilPaidThrough: false`, and that covers every PAST_DUE PayPal row | Obligation columns on the row (state, requested and confirmed times, trigger subscription), and an Operations condition while unresolved | The provider cancellation stays. An image rollback does not resume it, and Stripe or PayPal cannot be un-cancelled by this system. An older image will not close rows held for their paid month |

## 2. Runs without a switch

Listed so that approving the release is informed. Each is either a recorded intent or nothing a customer holds.

| ID | Preview action | Why it is not held | Paid-through | Rollback limit |
|---|---|---|---|---|
| A2 | `RETRY_RECORDED_CANCELLATION` | An obligation already recorded before this release, from a customer cancelling or an earlier sweep. The retry worker already exists at the audited revision. **Review these lines before release:** this is a Live provider write | As A1 | As A1 |
| A3 | `REFUSE_PENDING_PURCHASE_IF_PROVIDER_ACTIVE` | A purchase still PENDING that the provider reports active on an account that cannot hold it. Stopped immediately, nothing having been granted, with a refund review item. An add-on already ACTIVE or PAST_DUE is never refused this way | None: no capacity was granted | The provider cancellation stays |
| A4 | Dry run `AUTO_SUPERSEDED_CANCELS_DUE` | A duplicate subscription already recorded as superseded. The customer's plan is the other subscription | Not applicable | The provider cancellation stays |
| A5 | Dry run `AUTO_ADDONS_PAST_PAID_END` | Closes a row whose provider has already cancelled it, once its paid date has passed | Paid date has passed | An older image leaves these open |

## Sequence

1. Apply the migrations.
2. Run the preview. Keep the output with the release record.
3. Approve section 2 with the release. Deploy.
4. Read the held review items against the preview. They should be the same rows.
5. For each section 1 action, decide separately. Changing a customer's plan or cancelling their add-on on a historical inconsistency may instead be a repair for `data-repair-plan.md`.
6. If a switch is turned on, run the preview again first, because the rows move.
