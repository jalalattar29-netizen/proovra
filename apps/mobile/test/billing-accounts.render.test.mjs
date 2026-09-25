/**
 * T-12 / RC-13 — billing accounts on native.
 *
 * THE DEFECTS
 * -----------
 *   1. With no billing account (an organization handles billing) native showed
 *      "Current plan FREE · Active" — a plan it had never read. The web says
 *      "Billing is managed for you" (billing/page.tsx:945-958).
 *   2. Native hard-picked the PERSONAL account; a person who is billing owner
 *      of an organization account had no "Billing account" selector
 *      (AccountSelector.tsx).
 *   3. A failed or refused payment-history read rendered as "No payments have
 *      been recorded." — an outage and a permission boundary both reading as
 *      an empty ledger.
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

function install() {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

beforeEach(async () => {
  requests = [];
  routes = Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [p, () => ({ body: f() })]));
  routes["/v1/billing/pricing"] = () => ({ body: {} });
  routes["/v1/billing/overview"] = () => ({ body: {} });
  routes["/v1/me/inbox/summary"] = () => ({ body: { unread: 0 } });
  install();
  await signIn(M);
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 4; i += 1) await settle();
  return r;
}

test("no billing account: 'Billing is managed for you', never an invented FREE plan", async () => {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [] } });
  const r = await render();
  assert.ok(r.hasText("Billing is managed for you"));
  assert.ok(r.hasText("Your organization looks after billing for this account. Your administrator can make changes."));
  assert.ok(!r.hasText("FREE"), "a plan was claimed for an account whose billing was never read");
});

test("two accounts: the web's 'Billing account' selector switches the projection read", async () => {
  routes["/v1/billing/accounts"] = () => ({
    body: {
      accounts: [
        { type: "PERSONAL", id: "p-1", displayName: "Me" },
        { type: "ORGANIZATION", id: "o-1", displayName: "Acme" },
      ],
    },
  });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "PRO" } } });
  routes["/v1/billing/accounts/ORGANIZATION/o-1"] = () => ({ body: { plan: { planKey: "TEAM" } } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [] } });
  routes["/v1/billing/accounts/ORGANIZATION/o-1/history"] = () => ({ body: { items: [] } });
  const r = await render();
  assert.ok(r.hasText("PRO"));
  await r.press("Billing account: Acme · Organization");
  for (let i = 0; i < 4; i += 1) await settle();
  assert.ok(r.hasText("TEAM"), "the selected organization account's plan is not shown");
  assert.ok(requests.includes("/v1/billing/accounts/ORGANIZATION/o-1/history"), "history did not follow the selected account");
});

test("history: 403 says the records belong to the billing owner; an empty list says 'No payments yet'", async () => {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "PRO" } } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ status: 403, body: { error: { code: "forbidden" } } });
  let r = await render();
  assert.ok(r.hasText("Payment records for this account are visible to its billing owner."));
  assert.ok(!r.hasText("No payments yet"), "a refused read rendered as an empty ledger");
  r.unmount();

  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [] } });
  r = await render();
  assert.ok(r.hasText("No payments yet"));
});

test("history: an outage offers a retry and does not read as empty", async () => {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "PRO" } } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ status: 503, body: { error: { code: "down" } } });
  const r = await render();
  assert.ok(r.hasText("We could not load payment history just now."));
  assert.ok(r.byLabel("Try again").length > 0);
});

/* ---- T-14 (BillingOverview.tsx:640 Above the, :687 existing evidence) ---- */

test("the account projection's evidence allowance is stated, with records above it and newly eligible history", async () => {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", label: "Personal" }] } });
  // billing-account-projection.service.ts: evidenceAdmission, usage.evidence, historicalOutputEligibility.
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({
    body: {
      plan: { planKey: "PRO", displayName: "Pro" },
      evidenceAdmission: { planIncludedLifetime: 100, effectiveLifetimeCap: 120, capSource: "LEGACY_RECORD_CAP_OVERRIDE", recordsHeld: 125, creditsAvailable: 3 },
      usage: { evidence: { state: "MEASURED", used: 125, limit: 120, window: "ROLLING_30_DAYS" } },
      historicalOutputEligibility: { eligibleWithoutOutputs: 7, reviewHref: "/reports" },
    },
  });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [] } });
  M.calls.reset();
  const r = await render();
  assert.equal(r.byTestId("billing-evidence-allowance").length, 1);
  assert.ok(r.hasText("Included with Pro") && r.hasText("100"));
  assert.ok(r.hasText("Agreed account limit") && r.hasText("120"));
  assert.ok(r.hasText("Above the agreed limit") && r.hasText("5"));
  assert.ok(r.hasText("Rolling 30-day window") && r.hasText("Credits available"));
  assert.ok(r.hasText("7 existing evidence records are now eligible for a report and verification package."));
  await r.press("Open Reports");
  assert.equal(M.calls.push.at(-1), "/reports");
});

/* ---- T-14 (StorageAndHistory.tsx:475 Actions, :562 Re-check) ---- */

test("a pending payment offers the server's Re-check and Cancel payment, each said in the web's words", async () => {
  const posts = [];
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", label: "Personal" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "PRO" } } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({
    body: {
      items: [
        { id: "pay-1", occurredAtUtc: "2026-09-20T00:00:00Z", description: "Pro — monthly", status: "PENDING", providerLabel: "Stripe", actions: { canRecheck: true, canCancel: true, canAbandon: false } },
        { id: "pay-2", occurredAtUtc: "2026-08-20T00:00:00Z", description: "Pro — monthly", status: "SUCCEEDED", providerLabel: "Stripe", actions: { canRecheck: false, canCancel: false, canAbandon: false } },
      ],
    },
  });
  routes["/v1/billing/accounts/PERSONAL/p-1/payments/pay-1/recheck"] = () => { posts.push("recheck"); return { body: { outcome: "PROVIDER_REFERENCE_NOT_FOUND" } }; };
  routes["/v1/billing/accounts/PERSONAL/p-1/payments/pay-1/cancel"] = () => { posts.push("cancel"); return { body: { outcome: "CANCELLED" } }; };
  const r = await render();
  assert.equal(r.byLabel("Re-check payment: Pro — monthly").length, 1, "only the unsettled payment offers Re-check");
  await r.press("Re-check payment: Pro — monthly");
  for (let i = 0; i < 4; i += 1) await settle();
  assert.ok(r.texts().some((t) => t.startsWith("Your payment provider could not find this payment attempt.")));
  await r.press("Cancel payment: Pro — monthly");
  assert.ok(r.hasText("Stop this payment?"));
  const confirm = r.byLabel("Stop payment").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  for (let i = 0; i < 4; i += 1) await settle();
  assert.deepEqual(posts, ["recheck", "cancel"]);
  assert.ok(r.hasText("Your provider has closed this payment. Nothing was charged."));
});
