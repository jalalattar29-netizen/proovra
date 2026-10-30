# Billing configuration repair

**Status: prepared, not executed.** This repairs the Team storage configuration. It changes one file and one container. It needs no release.

**What is established:**
- The latest Production diagnostic shows all three Team storage prices `UNSET`, and their cents overrides `SET`. The override values have not been read.
- That diagnostic does not show which revision is running: the API restarted at 2026-10-30T14:09:20Z. Step 1 finds out.
- On every audited revision, these ids are read only from `process.env`. AWS Secrets Manager cannot supply them, so this file is the one authority.

**What it does not establish:** which SKU the original incident requested, or that a Live Price exists.

## Step 1. Read what is running (read-only)

On the Production host, from `/opt/proovra/app`:

```bash
./scripts/billing-config-repair.sh discover
```

The script is on the server only after this branch is merged and fetched. Until then, copy it from the branch to the host, or run the discovery from section "Without the script" below.

Record `revision`, `effective_cents` and `source` for each SKU. **Use `effective_cents`, not the catalogue.** The catalogue says TEAM_100_GB 999, TEAM_500_GB 3499, TEAM_1_TB 5999, but the overrides are set, so those may differ.

Stop here if:
- `stripe_key_mode` is not `live`.
- `revision` is not what you expect. A newer revision may have different code; read `getStripeStorageAddonPriceId` at that revision before continuing.

## Step 2. Create or select the Live Prices (Stripe Dashboard, owner only)

Do this in the Live account that `STRIPE_SECRET_KEY` belongs to. One Price per SKU:

| Property | Required value |
|---|---|
| Active | yes |
| Currency | EUR |
| Amount | that SKU's `effective_cents` from step 1 |
| Type | recurring |
| Interval | every 1 month |
| Pricing model | flat, per unit, not tiered, not package |
| Usage | licensed, not metered |
| Price reuse | not used by any other offer |
| Product | if `product` was not `UNSET` in step 1, this Product |

## Step 3. Add the ids

Takes each id at a prompt, validates its shape, and backs the file up first. It refuses to touch a key that already exists.

```bash
./scripts/billing-config-repair.sh set-prices
```

It prints a command that lists changed variable names without printing their values. Run it, and confirm that only the new price variables changed. Every changed key takes effect in step 4.

## Step 4. Recreate the API only

A running container keeps the environment it was created with, so a plain restart does nothing here.

```bash
./scripts/billing-config-repair.sh recreate-api
```

This uses the image already running, refuses a non-immutable tag, and fails if the image changed. The worker is not touched, and it does not read these variables.

**Effects:**
- The API restarts, so a short interruption.
- The hourly sweep's minute moves. **Before this step**, check whether the ten PayPal ids recur at about :58 on other hours in the PayPal dashboard. That evidence is harder to read afterwards.

`deploy-prod-pull.sh` is **not** used for this: it checks out a commit and recreates both services.

## Step 5. Verify

```bash
./scripts/billing-config-repair.sh discover
```

All three Team rows should show a price id. Then the account owner opens one TEAM_500_GB card checkout page. Opening it creates a Stripe Session and charges nothing. Do not pay unless a real purchase is wanted: it is a recurring charge, stacking means a second purchase adds a second charge, and the open PayPal attempt should be resolved first.

If it still answers 503, the API log line carries `reason`:

| `reason` | Meaning |
|---|---|
| `plan_not_configured` | Still unset, or Stripe does not know the id (wrong account or mode) |
| `plan_price_mismatch` | The Price disagrees; the log names the field |
| `provider_unreachable_before_create` | Stripe could not be reached, or (older images) the key was refused |

## After the billing release

The new image carries a complete read-only check of every offer, including PayPal plans. It makes one GET per configured id and prints no secret:

```bash
docker exec docker-proovra-api-1 node dist/scripts/verify-billing-offers.js
```

`PRODUCT_NOT_CONFIGURED` is advice, not a failure. Exit code 0 means every offer on sale agrees.

## Without the script

Read-only discovery that needs nothing from the branch:

```bash
docker inspect --format 'image={{.Config.Image}} revision={{ index .Config.Labels "org.opencontainers.image.revision" }} started={{.State.StartedAt}}' docker-proovra-api-1
```

```bash
docker exec docker-proovra-api-1 node -e 'for (const s of ["TEAM_100_GB","TEAM_500_GB","TEAM_1_TB"]) console.log(s, (process.env["BILLING_STORAGE_"+s+"_EUR_PRICE_CENTS"]||"no_override").trim())'
```
