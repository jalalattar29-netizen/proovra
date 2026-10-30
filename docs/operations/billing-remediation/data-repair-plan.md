# Existing-data repair plan

**Status: prepared, not executed.** Nothing here runs automatically. The release changes no existing row. Each repair below needs its own approval, after its dry-run count is known.

## Dry run (read-only)

After the migration is applied, inside the API container:

```bash
docker exec -w /app/services/api docker-proovra-api-1 node scripts/billing-repair-dry-run.mjs
```

It uses one READ ONLY transaction with timeouts, calls no provider, and prints counts and dates only, no person's identity.

## Findings and what each one needs

| ID | What it finds | What the release does by itself | Separate repair, if approved |
|---|---|---|---|
| R1 | One storage charge recorded twice (session + invoice) | New purchases write one row | Mark the session row with a non-revenue `product` value, after confirming each pair. Never delete. Revenue reports change, so finance should see the count first |
| R2 | Stripe plan CANCELED, never activated, with a paid invoice | Nothing reads CANCELED rows, so these stay | Read each subscription live. If Stripe says active, apply the live state through the normal writer. Requires a re-check tool run per account |
| R3 | Live plan with stale entitlement | **The sweep repairs these** | None. A falling count after release is the proof |
| R4 | Stripe downgrade past its date, not landed | The sweep reads the billed price and lands it | None. Watch the count fall. A remaining row means the schedule never existed: review it |
| R5 | Active Stripe row with no renewal date | The next read restores it | None |
| R6 | Team-size add-on with no live Team plan | Nothing. This is decision D1/D2 | Depends on the decision. **Do not cancel customer subscriptions to apply a policy** |
| R7 | Refunded payments with `refunded_amount_cents` 0 | New refunds record it | Set the column to `amount_cents` only where a provider read confirms a full refund. Reports should keep treating status REFUNDED as authoritative |
| R8 | Negative wallet | New reversals cannot produce one | Review each with its ledger. Never adjust a balance without a ledger entry |
| R9 | Locally closed PayPal attempts that may still be approvable | The sweep re-reads them for 30 days | None automatically |

## Rules for any repair

1. Run the dry run first, and record the counts.
2. Read the provider for each row before writing. A local inference is not a reason to change money or entitlement.
3. Go through the normal writers, not raw `UPDATE`s, so audit and analytics stay truthful.
4. Keep the original amounts and history. Nothing is deleted.
5. Do not revoke an entitlement because a provider answered 404.

## The ten PayPal ids and the open attempt

- **Ten 404 ids:** on first read after release, each gets a `billing_provider_binding_checks` row, and after three misses a review item. Nothing is revoked, and the rows are not deleted.
- **Attempt `b9f4246d-cf80-4b75-b02c-a6d0c4cfe4ac`:** untouched by this release, and not to be reconciled or abandoned without approval.
