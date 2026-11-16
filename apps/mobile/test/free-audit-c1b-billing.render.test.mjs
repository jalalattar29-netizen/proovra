/**
 * Free-user audit 0ea0 — WEB-C1B-BILLING-AI-UI, the native Billing SCREEN.
 *
 *   B6-F-63  a store build's "View Pricing" opens the in-app read-only plans, never the web pricing page
 *   B6-F-65  that sheet states the served Free allowance (3 records, 250 MB) and no "0 seats"
 *   B6-F-61  an ending add-on reads "Ends … — not renewing" and offers no Cancel
 *   B6-F-62  a managed payer reaches Manage plan → Cancel, and is offered add-on Cancel; no Re-check they cannot run
 *   B6-F-71  a private-build TEAM → PRO move confirms the server's effect and the storage it ends, then sends
 *            confirmStorageEnding, with no provider picker
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];

before(async () => {
  M = await loadModule("app/(stack)/billing.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  routes = Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [p, () => ({ body: f() })]));
  routes["/v1/billing/pricing"] = () => ({ body: CATALOGUE });
  routes["/v1/billing/overview"] = () => ({ body: {} });
  routes["/v1/me/inbox/summary"] = () => ({ body: { unread: 0 } });
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [] } });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});

const CATALOGUE = {
  currency: "USD",
  free: { plan: "FREE", displayName: "Free", monthlyPriceCents: 0, storageLabel: "250 MB", seats: 0, reportsIncluded: true, publicVerifyIncluded: true, maxEvidenceRecords: 3, maxEvidenceRecordsPerMonth: null },
  pro: { plan: "PRO", displayName: "Pro", monthlyPriceCents: 1900, storageLabel: "100 GB", seats: 0, reportsIncluded: true, maxEvidenceRecords: 100, maxEvidenceRecordsPerMonth: null },
  team: { plan: "TEAM", displayName: "Team", monthlyPriceCents: 9900, storageLabel: "1 TB", seats: 5, reportsIncluded: true, maxEvidenceRecords: null, maxEvidenceRecordsPerMonth: 500 },
  storageAddons: [{ key: "PERSONAL_10_GB", label: "+10 GB", storageBytes: 10 * 1024 ** 3, priceCents: 300, currency: "USD", billingCycle: "MONTHLY" }],
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const drain = async () => { for (let i = 0; i < 6; i += 1) await settle(); };
async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await drain();
  return r;
}
/** The next sheet opens when the last one has gone; the renderer has no animation to end. */
const dismissSheets = (r) =>
  act(async () => {
    for (const n of r.root.findAll((x) => typeof x.props?.onDismiss === "function")) n.props.onDismiss();
  });

async function privateBuild(run) {
  const saved = { d: process.env.EXPO_PUBLIC_DISTRIBUTION, b: process.env.EXPO_PUBLIC_PRIVATE_BILLING };
  process.env.EXPO_PUBLIC_DISTRIBUTION = "PRIVATE";
  process.env.EXPO_PUBLIC_PRIVATE_BILLING = "enabled";
  try {
    await run();
  } finally {
    if (saved.d === undefined) delete process.env.EXPO_PUBLIC_DISTRIBUTION; else process.env.EXPO_PUBLIC_DISTRIBUTION = saved.d;
    if (saved.b === undefined) delete process.env.EXPO_PUBLIC_PRIVATE_BILLING; else process.env.EXPO_PUBLIC_PRIVATE_BILLING = saved.b;
  }
}

const ADDON = {
  id: "addon-1",
  addonKey: "PERSONAL_50_GB",
  storageLabel: "50 GB",
  status: "ACTIVE",
  billingCycle: "MONTHLY",
  legacyOneTime: false,
  endsWithPlan: false,
  canCancel: true,
  currentPeriodEndUtc: "2026-12-01T12:00:00.000Z",
  priceCents: 900,
  currency: "USD",
};

test("B6-F-63 / B6-F-65: a store build's View Pricing opens the in-app plans with the served Free allowance", async () => {
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "FREE", accessKind: "FREE" } } });
  const r = await render();
  await r.press("View Pricing");
  await drain();
  assert.equal(M.calls.openURL.filter((u) => String(u).includes("/pricing")).length, 0, "the store build opened the web pricing page");
  assert.equal(r.byTestId("billing-pricing").length, 1, "the in-app plans did not open");
  assert.ok(r.hasText("3 complete evidence records in total · 250 MB storage"), r.texts().join(" | "));
  assert.ok(r.hasText("reports and verification packages included for 3 records"));
  assert.ok(!r.hasText("0 seats"));
  assert.ok(r.hasText("10 GB"));
  assert.ok(!r.hasText("11 GB"));
  assert.ok(!r.texts().some((t) => /on the web/.test(t)), "store copy signposts the web");
});

test("B6-F-61: an ending add-on says when it ends and offers no Cancel", async () => {
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({
    body: {
      account: { type: "PERSONAL", capabilities: ["BILLING_MANAGE", "BILLING_CANCEL"] },
      plan: { planKey: "FREE", accessKind: "FREE" },
      storageAddons: { offers: [], active: [{ ...ADDON, ending: true, endsAtUtc: "2026-12-01T12:00:00.000Z" }] },
    },
  });
  const r = await render();
  assert.ok(r.texts().some((t) => /^Ends .+ — not renewing$/.test(t)), r.texts().join(" | "));
  assert.ok(!r.texts().some((t) => t.startsWith("Renews ")), "an ending add-on still reads Renews");
  assert.equal(r.byLabel("Cancel storage add-on 50 GB").length, 0, "an already-cancelled add-on offers Cancel");
});

test("B6-F-62: a managed payer reaches Cancel through Manage plan and may cancel an add-on", async () => {
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({
    body: {
      account: { type: "PERSONAL", capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"] },
      plan: { planKey: "PRO", displayName: "Pro", accessKind: "SUBSCRIPTION", model: "MONTHLY", currentPeriodEndUtc: "2026-12-01T12:00:00.000Z" },
      actions: { planManagement: { label: "Manage plan", mode: "MANAGE", enabled: false }, canRequestCancellation: true },
      storageAddons: { offers: [], active: [{ ...ADDON, canCancel: false }] },
    },
  });
  const r = await render();
  assert.equal(r.byLabel("Cancel storage add-on 50 GB").length, 1, "BILLING_CANCEL did not offer the add-on Cancel");
  assert.equal(r.byLabel("Re-check purchases and billing").length, 0, "a re-check the server refuses was offered");
  await r.press("Manage plan");
  await drain();
  assert.equal(r.byTestId("billing-manage-plan").length, 1, "Manage plan stayed unreachable");
  assert.ok(r.byLabel("Cancel subscription").some((n) => n.props.onPress), "Cancel was not reachable");
});

test("B6-F-71: a private-build TEAM → PRO move confirms the effect and the storage it ends, with no provider picker", async () => {
  await privateBuild(async () => {
    routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({
      body: {
        account: { type: "PERSONAL", capabilities: ["BILLING_MANAGE", "BILLING_CANCEL"] },
        plan: { planKey: "TEAM", displayName: "Team", accessKind: "SUBSCRIPTION", model: "MONTHLY", currentPeriodEndUtc: "2026-12-01T12:00:00.000Z" },
        planOffers: [{ planKey: "PRO", displayName: "Pro", action: "DOWNGRADE", effect: "AT_PERIOD_END", actionLabel: "Move to Pro", effectSummary: "Lower limits than you have now, from your next billing date." }],
        actions: { planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true }, canRequestCancellation: true },
        storageAddons: { offers: [], active: [{ ...ADDON, id: "addon-t", addonKey: "TEAM_100_GB", storageLabel: "100 GB", endsWithPlan: true }] },
      },
    });
    routes["/v1/billing/subscription/plan"] = () => ({ body: { outcome: "DOWNGRADE", providerConfirmed: true, effectiveAtUtc: "2026-12-01T12:00:00.000Z" } });
    const r = await render();
    await r.press("Manage plan");
    await drain();
    await r.press("Change plan");
    await dismissSheets(r);
    await drain();
    await r.press("Choose Pro");
    await dismissSheets(r);
    await drain();
    assert.equal(r.byTestId("billing-plan-change").length, 1, "the plan change had no confirmation of its own");
    assert.ok(r.hasText("Lower limits than you have now, from your next billing date."));
    assert.ok(r.texts().some((t) => t.includes("does not include your Team-size storage add-on (100 GB)")), "the storage it ends was not named");
    assert.equal(r.byLabel("Pay with Stripe").length, 0, "a provider picker was offered for a transition");
    await r.press("Move to Pro");
    await drain();
    const change = requests.filter((q) => q.path === "/v1/billing/subscription/plan");
    assert.equal(change.length, 1);
    assert.deepEqual(change[0].body, { plan: "PRO", confirmStorageEnding: true });
    assert.equal(requests.filter((q) => q.path.startsWith("/v1/billing/checkout/")).length, 0, "a new checkout was started");
  });
});
