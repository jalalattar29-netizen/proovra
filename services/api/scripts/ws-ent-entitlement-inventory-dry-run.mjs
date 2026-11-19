#!/usr/bin/env node
// WS-ENT ENTITLEMENT INVENTORY — READ-ONLY (RG-13; PRO-R3-07, PRO-G1-14,
// PRO-W2-05, PRO-G1-04, PRO-W2C2-03, PRO-K1-03).
//
//   DATABASE_URL=... node scripts/ws-ent-entitlement-inventory-dry-run.mjs
//
// Counts, per finding, the existing rows the RG-13 release changes the
// treatment of, for an operator to review BEFORE the API/worker deploy. It runs
// in one READ ONLY transaction with a statement timeout, writes nothing, calls
// no provider and prints no user id, email or workspace name. Workspace ids are
// printed only with --ids (bounded to 200 per finding) for the review list.
//
// Enterprise contract-derived values are not modelled here: workspaces on the
// ENTERPRISE plan with an ACTIVE contract are excluded from the "will pause"
// counts, so those counts are an upper bound for everyone else.
//
// Exit 0: every line counted. Exit 3: a line needs a migration. Exit 2: failed.

import pg from "pg";

const WITH_IDS = process.argv.includes("--ids");

const NOT_CONTRACT_ACTIVE = `
  not exists (select 1 from teams tt join enterprise_contracts c on c.organization_id = tt.organization_id
               where tt.id = %T% and tt.billing_plan = 'ENTERPRISE' and c.status = 'ACTIVE')`;
const notContract = (col) => NOT_CONTRACT_ACTIVE.replace("%T%", col);
const liveGrant = (col, key) => `
  exists (select 1 from entitlement_grants g where g.team_id = ${col} and g.key = '${key}'
           and (g.expires_at_utc is null or g.expires_at_utc > now())
           and (g.value_bool is true or coalesce(g.value_number, 0) > 0))`;

const FINDINGS = [
  {
    id: "DEC12_UNBOUNDED_GRANTS",
    meaning: "legacy operator grants with no expiry (inventory for review; not destroyed, not changed)",
    sql: `select g.team_id::text as team_id from entitlement_grants g where g.expires_at_utc is null`,
  },
  {
    id: "R3_07_REDACTION_GRANTS_UNBOUNDED",
    meaning: "FEATURE_REDACTION grants with no expiry (PRO-R3-07)",
    sql: `select g.team_id::text as team_id from entitlement_grants g
           where g.key = 'FEATURE_REDACTION' and g.value_bool is true and g.expires_at_utc is null`,
  },
  {
    id: "G1_14_API_KEYS_WILL_PAUSE",
    meaning: "workspaces with ACTIVE API keys and no live INTEGRATION_API_KEYS_MAX grant nor ACTIVE contract: keys answer 403 ENTITLEMENT_REQUIRED (not revoked)",
    sql: `select distinct a.team_id::text as team_id from api_credentials a
           where a.status = 'ACTIVE' and not ${liveGrant("a.team_id", "INTEGRATION_API_KEYS_MAX")}
             and ${notContract("a.team_id")}`,
  },
  {
    id: "G1_14_INTEGRATION_WEBHOOKS_WILL_PAUSE",
    meaning: "workspaces with ACTIVE integration webhook endpoints and no live FEATURE_WEBHOOKS grant nor ACTIVE contract: deliveries withheld",
    sql: `select distinct w.team_id::text as team_id from integration_webhook_endpoints w
           where w.status = 'ACTIVE' and not ${liveGrant("w.team_id", "FEATURE_WEBHOOKS")}
             and ${notContract("w.team_id")}`,
  },
  {
    id: "W2_05_LIFECYCLE_WEBHOOKS_WILL_PAUSE",
    meaning: "workspaces with ACTIVE lifecycle webhook endpoints and no live FEATURE_WEBHOOKS grant nor ACTIVE contract",
    sql: `select distinct w.team_id::text as team_id from webhook_endpoints w
           where w.state = 'ACTIVE' and not ${liveGrant("w.team_id", "FEATURE_WEBHOOKS")}
             and ${notContract("w.team_id")}`,
  },
  {
    id: "G1_04_WEBHOOKS_WITHOUT_DELIVERY_QUOTA",
    meaning: "workspaces holding FEATURE_WEBHOOKS or FEATURE_GOVERNANCE_PLATFORM by grant but no QUOTA_WEBHOOK_DELIVERIES_PER_DAY grant nor ACTIVE contract: the daily quota resolves to 0",
    sql: `select distinct g.team_id::text as team_id from entitlement_grants g
           where g.key in ('FEATURE_WEBHOOKS','FEATURE_GOVERNANCE_PLATFORM') and g.value_bool is true
             and (g.expires_at_utc is null or g.expires_at_utc > now())
             and not ${liveGrant("g.team_id", "QUOTA_WEBHOOK_DELIVERIES_PER_DAY")}
             and ${notContract("g.team_id")}`,
  },
  {
    id: "G1_05_INTEGRATION_ENDPOINTS_ABOVE_CEILING",
    meaning: "workspaces whose ACTIVE integration endpoints exceed their live INTEGRATION_WEBHOOK_ENDPOINTS_MAX grant (kept; only new creates refused)",
    sql: `select w.team_id::text as team_id from integration_webhook_endpoints w
           where w.status = 'ACTIVE' and ${notContract("w.team_id")}
           group by w.team_id
          having count(*) > coalesce((select max(g.value_number) from entitlement_grants g
                                       where g.team_id = w.team_id and g.key = 'INTEGRATION_WEBHOOK_ENDPOINTS_MAX'
                                         and (g.expires_at_utc is null or g.expires_at_utc > now())), 0)`,
  },
  {
    id: "W2C2_03_TAGGED_WITHOUT_ENTITLEMENT",
    meaning: "workspaces with auto-tier COMPLETED transitions and no live FEATURE_ARCHIVE_TIERS grant nor ACTIVE contract: candidates for a tag-only re-tag to HOT (separate approval)",
    sql: `select distinct t.team_id::text as team_id from archive_tier_transitions t
           where t.state = 'COMPLETED' and t.reason = 'AUTO_TRANSITION' and t.to_tier <> 'HOT'
             and not ${liveGrant("t.team_id", "FEATURE_ARCHIVE_TIERS")}
             and ${notContract("t.team_id")}`,
  },
  {
    id: "K1_03_NON_ENTERPRISE_SIU_PROFILES",
    meaning: "SIU profiles in workspaces that are not ENTERPRISE with an ACTIVE contract (read-only after deploy; export/delete decision)",
    sql: `select distinct p.team_id::text as team_id from case_siu_profiles p where ${notContract("p.team_id")}`,
  },
  {
    id: "K1_03_NON_ENTERPRISE_MANUAL_RELATIONSHIPS",
    meaning: "manual graph relationships in workspaces that are not ENTERPRISE with an ACTIVE contract",
    sql: `select distinct m.team_id::text as team_id from manual_relationships m where ${notContract("m.team_id")}`,
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
  for (const finding of FINDINGS) {
    await client.query("SAVEPOINT finding");
    try {
      const { rows } = await client.query(finding.sql);
      const ids = [...new Set(rows.map((r) => r.team_id))];
      console.log(
        JSON.stringify({
          id: finding.id,
          workspaces: ids.length,
          rows: rows.length,
          meaning: finding.meaning,
          ...(WITH_IDS ? { workspaceIds: ids.slice(0, 200) } : {}),
        }),
      );
    } catch (err) {
      if (err?.code !== "42703" && err?.code !== "42P01") throw err;
      partial = true;
      await client.query("ROLLBACK TO SAVEPOINT finding");
      console.log(JSON.stringify({ id: finding.id, workspaces: null, unavailable: "NEEDS_MIGRATION", meaning: finding.meaning }));
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
