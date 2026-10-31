#!/usr/bin/env node
// BILLING REPAIR DRY RUN — READ-ONLY. Previews what the release writes by itself,
// and lists existing records it does not fix, as counts for an operator to review.
//
//   node scripts/billing-repair-dry-run.mjs
//
// Runs in one READ ONLY transaction with a statement timeout. It changes nothing,
// calls no provider and prints no user id, email or amount of any one person.
// Exit 0: every line counted. Exit 3: some lines need the migrations and print
// `"count":null` with `"unavailable":"NEEDS_MIGRATION"`. Exit 2: the run failed.
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
    id: "R10_LEGACY_WORKSPACE_TEAM_UNPAID",
    meaning: "owned workspaces still live on TEAM with no live subscription scoped to them (AUD-29)",
    sql: `
      select count(*)::int as n, min(t.updated_at) as first_at, max(t.updated_at) as last_at
        from teams t
       where t.workspace_kind = 'OWNED' and t.billing_plan = 'TEAM'
         and t.billing_status in ('ACTIVE', 'PAST_DUE')
         and not exists (
           select 1 from subscriptions s
            where s.team_id = t.id and s.status in ('ACTIVE', 'PAST_DUE'))`,
  },
  {
    id: "R11_INTERNAL_GRANTS_PAST_EXPIRY",
    meaning: "internal grants past expiry and not yet closed; the sweep closes and audits these",
    sql: `
      select count(*)::int as n, min(expires_at_utc) as first_at, max(expires_at_utc) as last_at
        from plan_grants
       where revoked_at_utc is null and expires_at_utc <= now()`,
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

// What the sweep and ordinary reads will write by themselves once the release is
// deployed (data-repair-plan.md, section A). A preview, not a promise: the code
// decides row by row and a provider read can change the answer.
const AUTOMATIC = [
  {
    id: "Q1_ADDONS_NOW_COUNTED_IN_PERSONAL_QUOTA",
    meaning: "live add-ons stamped with the owner's personal workspace. Billed, counted by no quota until this release, which raises that personal limit",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
        join teams t on t.id = a.team_id
       where a.status in ('ACTIVE','PAST_DUE') and t.owner_user_id = a.owner_user_id
         and t.workspace_kind = 'PERSONAL'`,
  },
  {
    id: "Q2_ADDONS_ON_OWNED_WORKSPACES",
    meaning: "live add-ons counted by an older workspace's own quota. Shown per workspace, never in the personal total",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
        join teams t on t.id = a.team_id
       where a.status in ('ACTIVE','PAST_DUE') and t.owner_user_id = a.owner_user_id
         and t.workspace_kind = 'OWNED'`,
  },
  {
    id: "Q3_ADDONS_COUNTED_BY_NO_QUOTA",
    meaning: "live add-ons whose workspace now has another owner. Still billed to the buyer, counted by no quota and absent from their Billing page. Needs review",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
        join teams t on t.id = a.team_id
       where a.status in ('ACTIVE','PAST_DUE') and t.owner_user_id is distinct from a.owner_user_id`,
  },
  {
    id: "Q4_ADDONS_ON_ORGANIZATION_WORKSPACES",
    meaning: "live add-ons on an organization workspace. Counted by that workspace's quota and shown on the organization's account, not the payer's Personal page",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
        join teams t on t.id = a.team_id
       where a.status in ('ACTIVE','PAST_DUE') and t.owner_user_id = a.owner_user_id
         and t.workspace_kind = 'ORGANIZATION'`,
  },
  {
    id: "AUTO_R3_WOULD_LOWER_PLAN",
    meaning: "estimate: of R3, entitlement above the plan paid for; held until enabled. billing-automatic-effects-preview lists the exact rows",
    sql: `
      select count(*)::int as n, min(s.updated_at) as first_at, max(s.updated_at) as last_at
        from subscriptions s
        join entitlements e on e.user_id = s.user_id and e.active
       where s.status in ('ACTIVE','PAST_DUE') and s.superseded_by_subscription_id is null
         and e.plan = 'TEAM' and s.plan = 'PRO'`,
  },
  {
    id: "AUTO_ADDON_CANCELLATION_WOULD_BE_OWED",
    meaning: "estimate: paid-plan add-ons with no obligation whose base has ended; held until enabled. billing-automatic-effects-preview lists the exact rows",
    sql: `
      select count(*)::int as n, min(a.created_at) as first_at, max(a.created_at) as last_at
        from workspace_storage_addons a
       where a.addon_key in ('TEAM_100_GB','TEAM_500_GB','TEAM_1_TB')
         and a.status in ('ACTIVE','PAST_DUE') and a.billing_cycle = 'MONTHLY'
         and a.external_subscription_id is not null
         and a.dependent_cancellation_state = 'NONE'
         and not exists (select 1 from subscriptions s
                          where s.user_id = a.owner_user_id and s.plan = 'TEAM'
                            and s.status in ('ACTIVE','PAST_DUE') and s.cancel_at_period_end = false)
         and exists (select 1 from subscriptions s
                      where s.user_id = a.owner_user_id and s.plan = 'TEAM'
                        and (s.status = 'CANCELED' or s.cancel_at_period_end = true or s.canceled_at_utc is not null))`,
  },
  {
    id: "AUTO_ADDON_OBLIGATIONS_OPEN",
    meaning: "cancellation obligations already open; retried against the provider",
    sql: `
      select count(*)::int as n, min(dependent_cancellation_requested_at_utc) as first_at, max(dependent_cancellation_requested_at_utc) as last_at
        from workspace_storage_addons
       where dependent_cancellation_state in ('PENDING','RETRY_SCHEDULED','ACTION_REQUIRED','MANUAL_INTERVENTION')`,
  },
  {
    id: "AUTO_ADDONS_PAST_PAID_END",
    meaning: "add-ons past their paid date, closed by the sweep",
    sql: `
      select count(*)::int as n, min(expires_at_utc) as first_at, max(expires_at_utc) as last_at
        from workspace_storage_addons
       where status in ('ACTIVE','PAST_DUE') and expires_at_utc <= now()`,
  },
  {
    id: "AUTO_SUPERSEDED_CANCELS_DUE",
    meaning: "superseded duplicates whose provider cancellation is due",
    sql: `
      select count(*)::int as n, min(supersession_cancel_next_retry_at_utc) as first_at, max(supersession_cancel_next_retry_at_utc) as last_at
        from subscriptions
       where superseded_by_subscription_id is not null
         and supersession_cancel_next_retry_at_utc <= now()`,
  },
  {
    id: "AUTO_PROVIDER_REFERENCES_NOT_YET_CHECKED",
    meaning: "upper bound on new binding-check rows: live provider references not yet checked; only a 404 writes one",
    sql: `
      select count(*)::int as n, min(s.created_at) as first_at, max(s.created_at) as last_at
        from subscriptions s
       where s.status in ('ACTIVE','PAST_DUE') and s.provider_sub_id <> ''
         and not exists (select 1 from billing_provider_binding_checks c
                          where c.provider = s.provider and c.provider_resource_id = s.provider_sub_id)`,
  },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
let failed = false;
let partial = false;
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = 15000");
  await client.query("SET LOCAL lock_timeout = 2000");
  for (const finding of [...AUTOMATIC, ...FINDINGS]) {
    // The preview runs before approval, so possibly before the migrations. One
    // missing column must cost that line only, not the transaction. Nothing else
    // is tolerated: a count that could not be read is never printed as zero.
    await client.query("SAVEPOINT finding");
    try {
      const { rows } = await client.query(finding.sql);
      const row = rows[0] ?? {};
      console.log(JSON.stringify({ id: finding.id, count: row.n ?? 0, first: row.first_at ?? null, last: row.last_at ?? null, meaning: finding.meaning }));
    } catch (err) {
      if (err?.code !== "42703" && err?.code !== "42P01") throw err;
      partial = true;
      await client.query("ROLLBACK TO SAVEPOINT finding");
      console.log(JSON.stringify({ id: finding.id, count: null, unavailable: "NEEDS_MIGRATION", meaning: finding.meaning }));
    }
    await client.query("RELEASE SAVEPOINT finding");
  }
  await client.query("ROLLBACK");
} catch (err) {
  failed = true;
  console.error("dry_run_failed", err?.code ?? "unknown");
  await client.query("ROLLBACK").catch(() => {});
} finally {
  await client.end().catch(() => {});
}
process.exit(failed ? 2 : partial ? 3 : 0);
