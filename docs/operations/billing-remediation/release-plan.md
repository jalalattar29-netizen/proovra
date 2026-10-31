# Billing remediation release plan

**Status: prepared, not executed.** No migration, deployment or provider change has been made.

The order is: configuration repair (independent, can go first), then migration, then API and worker image, then web.

## 1. Discover what is running (read-only)

Do not reuse any previously recorded revision. Production's API restarted on 2026-10-30, and a published image is not a deployed one.

```bash
docker inspect --format '{{.Name}} image={{.Config.Image}} revision={{ index .Config.Labels "org.opencontainers.image.revision" }} started={{.State.StartedAt}}' docker-proovra-api-1 docker-proovra-worker-1
```

Everything between that revision and the release commit ships with the release. Review that range on the host, from the application checkout, after `git fetch`. This shows what the checkout's `origin/main` would add:

```bash
git log --oneline "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' docker-proovra-api-1)..origin/main"
```

**Unverified on the host:** the container names, the checkout path `/opt/proovra/app`, the compose file and project name `docker` come from repository defaults. Confirm them against the discovery output before relying on any command here.

## 2. Prerequisites

| Item | Required before | Notes |
|---|---|---|
| Stripe webhook endpoint events | API image | Add `charge.dispute.created`, `charge.refunded`, `charge.dispute.closed` if not already enabled. Check `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.*` |
| Stripe API version | API image | The code sends `2025-03-31.basil`. The webhook endpoint's version is set in the Dashboard; both older and Basil payloads are parsed, so it need not change |
| External test plan | API image, recommended | **Not executed.** Code landed on main without it, so the schedule, customer reuse and refund payloads are proven against documentation only |
| Automatic-write preview | Approval of the release | Run the dry run in section 3a and record the counts |

## 3. Migration first

Three migrations, in order. All are EXPAND, and none rewrites a row:

1. `20281030000000_billing_remediation_convergence`
2. `20281031000000_billing_product_decisions`
3. `20281101000000_stripe_customer_per_currency`

The third replaces the owner key on `billing_provider_customers`, the table the second creates, so apply them together while it is empty.

**All go before the image.** An older image ignores them. A newer image without them fails every billing read, and `runtime-schema-gate` refuses to start one. The worker's `EXPECTED_MIGRATION_HEAD` is `20281101000000_stripe_customer_per_currency`, so it also waits for all three.

Apply it through the migration runbook (`docs/operations/internal-grant-production-rollout.md`). `deploy-prod-pull.sh` does not migrate.

## 3a. Preview what the release will write (read-only)

Deploying is not only a code change: the sweep and ordinary reads then write to existing rows. **`data-repair-plan.md` lists each automatic write.** Run the preview before approving the release:

```bash
docker exec -w /app/services/api docker-proovra-api-1 node scripts/billing-repair-dry-run.mjs
```

The script ships with the release image. Against an older image, copy it into the container first, or run it from a checkout with `DATABASE_URL` set to a read-only connection.

Then read `automatic-effects.md` and run its preview, which decides each record with the sweep's own functions. It needs the migrations and the new image. The counts above are the earlier, coarser estimate.

**Before the migrations, the dry run is partial.** A line that needs them prints `"count":null` with `"unavailable":"NEEDS_MIGRATION"`, and the script exits 3. That null is unknown, not zero. Those lines include R3 and `AUTO_R3_WOULD_LOWER_PLAN`, so a decision that depends on them needs a run after the migrations, which change no rows, and before the image. Exit 0 means every line was counted. Exit 2 means the run failed and its output cannot be relied on.

Approving the release approves `automatic-effects.md` section 2 and nothing else. **It does not approve lowering a plan or starting an add-on cancellation (section 1, held by default), or any repair marked "separate approval".**

## 4. API and worker

Only with an approved, published release commit:

- `deploy-prod-pull.sh --plan` first, then the real run. It checks image revision labels and the schema gate, and recreates the API, then the worker.
- Confirm the images were actually built: a green `deploy-images` run may have skipped `build-and-push`. Check the jobs and the GHCR digests.

The worker must take the same image: it shares Prisma models.

## 5. Web

Deployed separately, and its state is unknown today. The API can go first: the page ignores new fields it does not read. If the web goes first, `checkoutAvailability` is undefined and the offer is treated as available, which is today's behaviour, and the new 409 codes appear only once the API ships.

## 6. Feature behaviour during rollout

| Moment | Behaviour |
|---|---|
| Migration applied, old image | No change |
| New API, old web | Buying a held storage SKU answers 409, and the old page shows a generic message. Keep this window short |
| New API, new web | Full behaviour |
| First sweep after release | Automatic writes in `data-repair-plan.md` run, except those held by `automatic-effects.md`. Expect new `AUTOMATIC_*_HELD` review items |

**Expected customer-visible changes:** add-ons cancelled through PayPal now stay until their paid date. A repeat purchase of a held SKU now asks first. A plan below what was paid for is raised. A plan above it is **held**, not lowered, until enabled, except through a provider webhook. A new downgrade that drops Team storage asks for agreement and stops that storage renewing. A new Stripe checkout reuses the payer's customer for that currency, or creates one, **which writes to Live Stripe at the customer's own checkout**. A checkout is refused and can be retried when Stripe cannot confirm the customer. An add-on stamped with the owner's personal workspace starts counting in their personal limit, which raises it. Billing shows held add-ons even on a plan with nothing to buy, and shows each older workspace separately.

## 7. Post-release verification

Each step is read-only unless it says otherwise.

1. Revision and health: the discovery command, `/readyz`.
2. Offers: `docker exec docker-proovra-api-1 node dist/scripts/verify-billing-offers.js`.
3. Data: `billing-repair-dry-run.mjs`. R5 and R11 should fall after the first sweeps. R3 and R4 fall only for what raises a plan until the switches in `automatic-effects.md` are on.
4. Logs: no `billing.reconciliation.account_failed`, and a `sweep_completed` line each hour.
5. Provider fact to entitlement, by the account owner, only if a real purchase is wanted:
   - One storage purchase through Stripe: the page says processing, then the add-on appears, one payment row, capacity increases.
   - Same for a plan: subscription ACTIVE, entitlement matches, one payment row.
   - Only this step proves payment to entitlement in Live. Nothing else in this plan does.

## 8. Rollback

Run `scripts/deploy-prod-pull.sh` with `--rollback --plan`, with `GHCR_OWNER` set to the owner in the discovered image name. The owner is the path segment after `ghcr.io/`. Do not run it from a saved command: take the value from the running image first.

**Limits of a rollback:**
- The migration stays: it is additive, and the old image ignores it. Do not reverse it.
- Refunds recorded in `payment_adjustments` stay. The old image will not add to them, so a refund during the rollback window must be reconciled later.
- A Stripe schedule created with phase metadata keeps working under the old image, except the original defect returns: the landing is not recorded.
- Superseded rows lose their protection under the old image, because it does not read the column. Keep a rollback window short.
- Add-ons held for their paid month stay ACTIVE until `finalizeEndedStorageAddons` runs again, so the old image will not close them. Run a re-release, or close them through the next provider webhook.
- A provider cancellation already confirmed stays cancelled. An add-on stopped by an agreed downgrade does not resume because the image rolled back.
- The switches do not exist in an older image, which reconciles without any hold. A rollback to one therefore starts whatever it did before, so check that against the preview first.
- `billing_provider_customers` rows stay and are ignored. The old image goes back to one customer per checkout, so any customer created in the window stays at Stripe, unused.
- Downgrade agreements and grant dependencies stay unread. A recorded obligation is still on the add-on row and the old retry worker still attempts it.

## 8a. Native release

Mobile recovery and the older-workspace storage lines ship only in a new build. It is separate from the API release, needs its own build and distribution, and the store build must keep its payment restrictions. Its logic and screens are covered by Node tests, and `native-build` proves it compiles. It has not been run on a device or simulator. The API must ship first, because the screens call its recovery routes.

## 9. What this release does not do

- Repair any historical record outside the automatic writes listed in `data-repair-plan.md`.
- Cancel, refund or change anything at a provider, apart from what customers do and the automatic writes listed there.
- Fix the PayPal hosted error.
- Configure the missing Team prices (see `configuration-repair.md`).
