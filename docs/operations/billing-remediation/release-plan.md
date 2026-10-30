# Billing remediation release plan

**Status: prepared, not executed.** No migration, deployment or provider change has been made.

The order is: configuration repair (independent, can go first), then migration, then API and worker image, then web.

## 1. Discover what is running (read-only)

Do not reuse any previously recorded revision. Production's API restarted on 2026-10-30, and a published image is not a deployed one.

```bash
docker inspect --format '{{.Name}} image={{.Config.Image}} revision={{ index .Config.Labels "org.opencontainers.image.revision" }} started={{.State.StartedAt}}' docker-proovra-api-1 docker-proovra-worker-1
```

Everything between that revision and the release commit ships with the release. Review that range:

```bash
git log --oneline <running revision>..<release commit>
```

The angle brackets above are **an example, not a command to paste**. Fill both from the discovered and approved values.

## 2. Prerequisites

| Item | Required before | Notes |
|---|---|---|
| Decisions D1 to D5 in the ledger | Release, or accept the stated default | The defaults change no customer subscription |
| Stripe webhook endpoint events | API image | Add `charge.dispute.created`, `charge.refunded`, `charge.dispute.closed` if not already enabled. Check `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.*` |
| Stripe API version | API image | The code sends `2025-03-31.basil`. The webhook endpoint's version is set in the Dashboard; both older and Basil payloads are parsed, so it need not change |
| External test plan | Merge to main, recommended | Without S3, the schedule payload is proven against documentation only |

## 3. Migration first

`20281030000000_billing_remediation_convergence` is EXPAND and adds columns and tables only. An older image ignores it. A newer image without it fails every billing read, and `runtime-schema-gate` refuses to start one.

Apply it through the migration runbook (`docs/operations/internal-grant-production-rollout.md`). `deploy-prod-pull.sh` does not migrate.

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
| First sweep after release | Entitlement drift and past-date downgrades repair themselves. Expect a one-off rise in `subscriptionsUpdated` and in plan-change audit rows |

**Expected customer-visible changes:** add-ons cancelled through PayPal now stay until their paid date. A repeat purchase of a held SKU now asks first. Plans with drift move to the plan actually paid for.

## 7. Post-release verification

Each step is read-only unless it says otherwise.

1. Revision and health: the discovery command, `/readyz`.
2. Offers: `docker exec docker-proovra-api-1 node dist/scripts/verify-billing-offers.js`.
3. Data: `billing-repair-dry-run.mjs`. R3 and R4 should fall after the first sweeps.
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

## 9. What this release does not do

- Touch any existing record.
- Cancel, refund or change anything at a provider, apart from what customers and the sweep's existing obligations do.
- Fix the PayPal hosted error.
- Configure the missing Team prices (see `configuration-repair.md`).
