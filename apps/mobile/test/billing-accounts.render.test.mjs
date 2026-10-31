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

/* ---- BILLING ACTIVITY (2026-09-28) ---- */

test("open purchases are listed as Billing activity beside 'No payments yet', in the server's words and without provider ids", async () => {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "FREE" } } });
  const item = (id) => ({
    id,
    product: "STORAGE",
    description: "+50 GB storage add-on",
    providerLabel: "PayPal",
    createdAtUtc: "2026-09-26T09:46:37.000Z",
    state: "PROVIDER_NO_RECORD",
    statusLabel: "No record at PayPal",
    explanation: "PayPal no longer has a record of this checkout, and it was never approved through PROOVRA.",
    recurring: true,
    lastCheckedAtUtc: null,
    actions: { canRecheck: true, canAbandon: true },
  });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({
    body: { items: [], activity: [item("a-1"), item("a-2")] },
  });
  const r = await render();
  assert.ok(r.hasText("Billing activity"));
  assert.equal(r.byTestId("billing-activity-a-1").length, 1);
  assert.equal(r.byTestId("billing-activity-a-2").length, 1);
  assert.ok(r.hasText("No record at PayPal"));
  assert.ok(r.hasText("No payments yet"));
  assert.ok(!r.hasText("I-4P6XLPVJEMBK"));
});

test("the account re-check never calls a provider 404 'settling'", async () => {
  const B = await loadModule("app/(stack)/billing.tsx", ["src/product/billing-account.ts"]);
  const reconcileMessage = B.reconcileMessage;
  assert.equal(typeof reconcileMessage, "function");
  const res = reconcileMessage({
    outcome: "ACTION_REQUIRED",
    summary: {
      checked: 2, creditsRestored: 0, paymentsRecorded: 0, subscriptionsUpdated: 0, attemptsUpdated: 0,
      pending: 0, actionRequired: 2, unavailable: 0, discrepancies: 0,
      attempts: [{ outcome: "PROVIDER_REFERENCE_NOT_FOUND" }, { outcome: "PROVIDER_REFERENCE_NOT_FOUND" }],
    },
  });
  assert.doesNotMatch(res.message, /settling|pending/i);
  assert.match(res.message, /2 purchases could not be confirmed/);
  assert.match(res.message, /Checked 2 items/);
});

/* ---- BILLING REMEDIATION (2026-10-31, AUD-19) — recovery on the row ---- */

const openAttempt = (over = {}) => ({
  id: "a-1",
  product: "STORAGE",
  description: "+50 GB storage add-on",
  providerLabel: "PayPal",
  createdAtUtc: "2026-09-26T09:46:37.000Z",
  state: "AWAITING_APPROVAL",
  statusLabel: "Waiting for approval",
  explanation: "This is waiting for your approval at PayPal.",
  recurring: true,
  lastCheckedAtUtc: null,
  actions: { canRecheck: true, canAbandon: true },
  ...over,
});

function openPurchaseAccount(activity) {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({ body: { plan: { planKey: "FREE" } } });
  routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [], activity: activity() } });
}

const ATTEMPT = "/v1/billing/accounts/PERSONAL/p-1/checkout-attempts/a-1";
const posted = (suffix) => requests.filter((p) => p === `${ATTEMPT}/${suffix}`).length;
const LABEL = "+50 GB storage add-on";
const drain = async () => { for (let i = 0; i < 4; i += 1) await settle(); };

test("Check status answers on the row, survives the refresh it causes, and the row stays mounted", async () => {
  openPurchaseAccount(() => [openAttempt()]);
  routes[`${ATTEMPT}/recheck`] = () => ({ body: { outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "ACTIVATION" } });
  const r = await render();
  await r.press(`Check status: ${LABEL}`);
  await drain();
  assert.equal(posted("recheck"), 1);
  assert.ok(r.hasText("You approved this at PayPal and PayPal is activating it."), "the answer is shown");
  assert.equal(r.byTestId("billing-activity-a-1").length, 1, "the row is still there after the re-read");
  assert.equal(r.byLabel(`Abandon: ${LABEL}`).length, 0, "abandon is not offered once approved");
});

test("settlement clears the row with the server's next read, and says so", async () => {
  let open = true;
  openPurchaseAccount(() => (open ? [openAttempt()] : []));
  routes[`${ATTEMPT}/recheck`] = () => {
    open = false;
    return { body: { outcome: "UPDATED", provider: "PAYPAL", currentStatus: "ACTIVE" } };
  };
  const r = await render();
  await r.press(`Check status: ${LABEL}`);
  await drain();
  assert.equal(r.byTestId("billing-activity-a-1").length, 0);
  assert.equal(r.byTestId("billing-notice").length, 1);
  assert.ok(r.hasText("PayPal confirmed this purchase. Billing is updated."));
});

test("Abandon asks the server first, and only the confirmation records it", async () => {
  let open = true;
  openPurchaseAccount(() => (open ? [openAttempt()] : []));
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/abandon")) bodies.push(init?.body);
    return realFetch(url, init);
  };
  routes[`${ATTEMPT}/abandon`] = () => {
    if (bodies.at(-1) !== JSON.stringify({ confirmed: true })) {
      return { body: { outcome: "ABANDON_CONFIRMATION_REQUIRED", cancelsAtProvider: false, warning: "This only changes PROOVRA." } };
    }
    open = false;
    return { body: { outcome: "ABANDONED", cancelsAtProvider: false } };
  };
  const r = await render();
  await r.press(`Abandon: ${LABEL}`);
  await drain();
  assert.ok(r.hasText("This only changes PROOVRA."));
  assert.equal(posted("abandon"), 1);
  await r.press("Abandon in PROOVRA");
  await drain();
  assert.equal(posted("abandon"), 2);
  assert.ok(r.hasText("This did not cancel anything at the payment provider."));
  assert.ok(!r.hasText("Nothing was charged"));
});

test("a refused action leaves the purchase open and names what happened", async () => {
  openPurchaseAccount(() => [openAttempt()]);
  routes[`${ATTEMPT}/recheck`] = () => ({ status: 409, body: { error: { code: "BILLING_ATTEMPT_BUSY", message: "x" } } });
  const r = await render();
  await r.press(`Check status: ${LABEL}`);
  await drain();
  assert.ok(r.hasText("This purchase is being checked right now."));
  assert.equal(r.byLabel(`Check status: ${LABEL}`).length, 1, "the way forward is still there");
});

test("a store build offers no Continue, even when the check returned a link, and says where to finish", async () => {
  openPurchaseAccount(() => [openAttempt()]);
  routes[`${ATTEMPT}/recheck`] = () => ({
    body: { outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "APPROVAL", resumeUrl: "https://www.paypal.com/webapps/billing/subscriptions?ba_token=x" },
  });
  const r = await render();
  assert.ok(r.hasText("To finish an open purchase, use Billing on the web."));
  await r.press(`Check status: ${LABEL}`);
  await drain();
  assert.equal(r.byLabel(`Continue checkout: ${LABEL}`).length, 0);
  assert.ok(r.hasText("To finish it, use Billing on the web, or abandon it here."));
});

test("a purchase stopped for review offers Support instead of a dead end", async () => {
  openPurchaseAccount(() => [openAttempt({ state: "REFUSED", statusLabel: "Stopped for review", actions: { canRecheck: false, canAbandon: false } })]);
  const r = await render();
  assert.equal(r.byLabel(`Contact support: ${LABEL}`).length, 1);
  assert.equal(r.byLabel(`Check status: ${LABEL}`).length, 0);
});

/* ---- the private distribution: the same recovery, plus Continue ---- */

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

/** The next sheet opens when the last one has gone; the renderer has no animation to end. */
const dismissSheets = (r) =>
  act(async () => {
    for (const n of r.root.findAll((x) => typeof x.props?.onDismiss === "function")) n.props.onDismiss();
  });

function storageOffer() {
  routes["/v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "p-1", displayName: "Me" }] } });
  routes["/v1/billing/accounts/PERSONAL/p-1"] = () => ({
    body: {
      plan: { planKey: "FREE" },
      storageAddons: { offers: [{ key: "PERSONAL_50_GB", label: "+50 GB", priceCents: 900, currency: "EUR" }], active: [] },
    },
  });
}

test("private build: Continue opens the provider's page, then asks the server again", async () => {
  await privateBuild(async () => {
    openPurchaseAccount(() => [openAttempt()]);
    routes[`${ATTEMPT}/recheck`] = () => ({
      body: { outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "APPROVAL", resumeUrl: "https://www.paypal.com/webapps/billing/subscriptions?ba_token=x" },
    });
    const r = await render();
    await r.press(`Check status: ${LABEL}`);
    await drain();
    await r.press(`Continue checkout: ${LABEL}`);
    await drain();
    assert.equal(posted("recheck"), 2);
  });
});

test("private build: a purchase open with the other provider is resolved where it was refused", async () => {
  await privateBuild(async () => {
    storageOffer();
    routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [], activity: [openAttempt()] } });
    routes["/v1/billing/storage-addons/checkout/stripe"] = () => ({
      status: 409,
      body: { error: { code: "STORAGE_PURCHASE_PENDING", message: "x", details: { retry: "RECONCILE_STORAGE_ATTEMPT", attemptId: "a-1", pendingProvider: "PAYPAL", createdAtUtc: "2026-10-30T00:00:00Z" } } },
    });
    routes[`${ATTEMPT}/recheck`] = () => ({ body: { outcome: "UPDATED", provider: "PAYPAL", currentStatus: "CANCELED" } });
    const r = await render();
    await r.press("Add storage");
    await drain();
    await r.press("Buy +50 GB · 9.00 EUR/month");
    await drain();
    await dismissSheets(r);
    await r.press("Pay with Stripe");
    await drain();
    assert.equal(r.byTestId("billing-storage-recovery").length, 1);
    await r.press("Check status: open storage purchase");
    await drain();
    assert.equal(r.byTestId("billing-storage-recovery").length, 0, "a finished attempt no longer blocks");
  });
});

test("private build: buying a held size asks once more, then sends the decision", async () => {
  await privateBuild(async () => {
    storageOffer();
    routes["/v1/billing/accounts/PERSONAL/p-1/history"] = () => ({ body: { items: [], activity: [] } });
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/storage-addons/checkout/stripe")) sent.push(JSON.parse(init.body));
      return realFetch(url, init);
    };
    routes["/v1/billing/storage-addons/checkout/stripe"] = () =>
      sent.at(-1)?.confirmAdditional === true
        ? { body: { session: { url: "https://checkout.stripe.com/c/pay/cs_2" } } }
        : { status: 409, body: { error: { code: "STORAGE_ADDON_ALREADY_HELD", message: "x", details: { retry: "CONFIRM_ADDITIONAL", activeCount: 1 } } } };
    const r = await render();
    await r.press("Add storage");
    await drain();
    await r.press("Buy +50 GB · 9.00 EUR/month");
    await drain();
    await dismissSheets(r);
    await r.press("Pay with Stripe");
    await drain();
    assert.equal(r.byTestId("billing-storage-additional").length, 1);
    assert.equal(sent.length, 1, "nothing is resent without an answer");
    await r.press("Add another");
    await drain();
    assert.equal(sent.at(-1).confirmAdditional, true);
  });
});
