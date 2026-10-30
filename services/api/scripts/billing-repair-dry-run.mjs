#!/usr/bin/env node
// BILLING REPAIR DRY RUN — READ-ONLY. Lists existing records this release does not
// fix by itself, as counts and shortened references for an operator to review.
//
//   node scripts/billing-repair-dry-run.mjs
//
// Runs in one READ ONLY transaction with a statement timeout. It changes nothing,
// calls no provider and prints no user id, email or amount of any one person.
// See docs/operations/billing-remediation/data-repair-plan.md for what each
// finding means and which repair, if any, needs separate approval.

import pg from "pg";

const FINDINGS = [
  {
    id: "R1_STRIPE_STORAGE_DOUBLE_PAYMENT",
    meaning: "one first-month storage charge recorded as a session row AND an invoice row (AUD-07)",
    sql: `
      select count(*)::int as n, min(s.created_at) as first_at, max(s.created_at) as last_at
        from payments s
        join payments i on i.provider = s.provider
                       and i.provider_resource_id = s.provider_resource_id
                       and i.provider_payment_id like 'in\\_%'
                       and i.status = 'SUCCEEDED'
                       and i.amount_cents = s.amount_cents
       where s.provider = 'STRIPE' and s.product = 'STORAGE_ADDON'
         and s.provider_payment_id like 'cs\\_%' and s.status = 'SUCCEEDED'`,
  },
  {
    id: "R2_STRIPE_CANCELED_NEVER_ACTIVATED",
    meaning: "Stripe plan rows CANCELED with no activation while a paid invoice exists (AUD-02)",
    sql: `
      select count(*)::int as n, min(s.updated_at) as first_at, max(s.updated_at) as last_at
        from subscriptions s
       where s.provider = 'STRIPE' and s.status = 'CANCELED' and s.activated_at_utc is null
         and exists (select 1 from payments p
                      where p.provider = 'STRIPE' and p.provider_resource_id = s.provider_sub_id
                        and p.status = 'SUCCEEDED')`,
  },
  {
    id: "R3_ENTITLEMENT_DRIFT",
    meaning: "live self-service subscription whose entitlement differs (AUD-03; the sweep repairs these)",
    sql: `
      select count(*)::int as n, min(s.updated_at) as first_at, max(s.updated_at) as last_at
        from subscriptions s
        join entitlements e on e.user_id = s.user_id and e.active
       where s.status in ('ACTIVE','PAST_DUE') and s.plan in ('PRO','TEAM') and e.plan <> s.plan
         and s.superseded_by_subscription_id is null`,
  },
  {
    id: "R4_STRIPE_PENDING_DOWNGRADE_PAST_DUE_DATE",
    meaning: "scheduled downgrade whose date passed without landing (AUD-01)",
    sql: `
      select count(*)::int as n, min(pending_plan_effective_at_utc) as first_at, max(pending_plan_effective_at_utc) as last_at
        from subscriptions
       where provider = 'STRIPE' and pending_plan is not null
         and pending_plan_effective_at_utc < now()`,
  },
  {
    id: "R5_ACTIVE_WITHOUT_PERIOD_END",
    meaning: "active Stripe rows with no renewal date, erased by a payload without the field (AUD-14a)",
    sql: `
      select count(*)::int as n, min(updated_at) as first_at, max(updated_at) as last_at
        from subscriptions
       where provider = 'STRIPE' and status = 'ACTIVE' and current_period_end is null`,
  },
  {
    id: "R6_ORPHANED_PAID_ADDON",
    meaning: "live TEAM-size add-on on a payer with no live plan offering it (AUD-04, AUD-10: product decision)",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
       where a.addon_key in ('TEAM_100_GB','TEAM_500_GB','TEAM_1_TB')
         and a.status in ('ACTIVE','PAST_DUE') and a.billing_cycle = 'MONTHLY'
         and not exists (select 1 from subscriptions s
                          where s.user_id = a.owner_user_id and s.plan = 'TEAM'
                            and s.status in ('ACTIVE','PAST_DUE') and s.cancel_at_period_end = false)`,
  },
  {
    id: "R7_REFUNDED_PAYMENT_WITHOUT_ADJUSTMENT",
    meaning: "payments already REFUNDED before adjustments existed; refunded_amount_cents reads 0",
    sql: `
      select count(*)::int as n, min(p.created_at) as first_at, max(p.created_at) as last_at
        from payments p
       where p.status = 'REFUNDED' and p.refunded_amount_cents = 0`,
  },
  {
    id: "R8_NEGATIVE_WALLET",
    meaning: "credit balances below zero (AUD-29)",
    sql: `select count(*)::int as n, null::timestamptz as first_at, null::timestamptz as last_at from entitlements where credits < 0`,
  },
  {
    id: "R9_BOUND_PAYPAL_ATTEMPTS_ABANDONED",
    meaning: "locally closed PayPal storage attempts that may still be approvable; re-read by the sweep for 30 days",
    sql: `
      select count(*)::int as n, min(created_at) as first_at, max(created_at) as last_at
        from workspace_storage_addons
       where status = 'ABANDONED' and payment_provider = 'PAYPAL'
         and external_subscription_id is not null`,
  },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
let failed = false;
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = 15000");
  await client.query("SET LOCAL lock_timeout = 2000");
  for (const finding of FINDINGS) {
    const { rows } = await client.query(finding.sql);
    const row = rows[0] ?? {};
    console.log(JSON.stringify({ id: finding.id, count: row.n ?? 0, first: row.first_at ?? null, last: row.last_at ?? null, meaning: finding.meaning }));
  }
  await client.query("ROLLBACK");
} catch (err) {
  failed = true;
  console.error("dry_run_failed", err?.code ?? "unknown");
  await client.query("ROLLBACK").catch(() => {});
} finally {
  await client.end().catch(() => {});
}
process.exit(failed ? 2 : 0);
