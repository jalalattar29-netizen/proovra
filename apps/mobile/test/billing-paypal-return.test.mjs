/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the private-build mobile PayPal
 * redirect, and truthful re-check wording.
 *
 * THE DEFECTS
 * -----------
 *   1. After the in-app browser closed, the app only refreshed: an approved
 *      evidence-credit order was never captured unless a webhook did it, and a
 *      plan or storage subscription was never confirmed server-side.
 *   2. A plan purchase refused with SUBSCRIPTION_ALREADY_ACTIVE was silently
 *      turned into a plan CHANGE of the existing subscription.
 *   3. A re-check refused because one was already running read "Billing was
 *      checked. Nothing was changed." (before that, "Your provider is still
 *      settling a payment").
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule } from "./support/render.mjs";

let P;
let A;

before(async () => {
  P = await loadModule("src/product/billing-purchase.ts", []);
  A = await loadModule("src/product/billing-account.ts", []);
});

test("a PayPal checkout names the server confirmation to run when the browser closes", () => {
  assert.deepEqual(P.payPalReturnConfirmation({ provider: "PAYPAL", order: { id: "5O190127TN364715T" } }, "paypal"), {
    kind: "ORDER_CAPTURE",
    path: "/v1/billing/credits/checkout/paypal/5O190127TN364715T/capture",
  });
  assert.deepEqual(P.payPalReturnConfirmation({ provider: "PAYPAL", subscription: { id: "I-BW452GLLEP1G" } }, "paypal"), {
    kind: "SUBSCRIPTION_CONFIRM",
    path: "/v1/billing/checkout/paypal/subscriptions/I-BW452GLLEP1G/confirm",
  });
  // Stripe is settled by its webhook; a malformed id is never asked about.
  assert.equal(P.payPalReturnConfirmation({ session: { id: "cs_1" } }, "stripe"), null);
  assert.equal(P.payPalReturnConfirmation({ order: { id: "../../admin" } }, "paypal"), null);
});

test("the confirmation is described truthfully — closed without approving is not a payment", () => {
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", { outcome: "GRANTED" }), /credit has been added/);
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", { outcome: "PENDING", reason: "AWAITING_APPROVAL" }), /Nothing is charged unless you approve it/);
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", { outcome: "PENDING", reason: "CAPTURE_PENDING" }), /keeps checking/);
  assert.match(P.payPalReturnNotice("SUBSCRIPTION_CONFIRM", { outcome: "AWAITING_APPROVAL" }), /Nothing is charged unless you approve it/);
  assert.match(P.payPalReturnNotice("SUBSCRIPTION_CONFIRM", { outcome: "PENDING" }), /activating/);
  assert.match(P.payPalReturnNotice("SUBSCRIPTION_CONFIRM", { outcome: "ACTIVE", superseded: true }), /second PayPal subscription was cancelled/);
  assert.match(P.payPalReturnNotice("SUBSCRIPTION_CONFIRM", null, { code: "PAYPAL_STORAGE_ACTIVATION_REFUSED", statusCode: 409 }), /cancelled it at PayPal/);
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", null, { statusCode: 404 }), /nothing was added/);
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", null, { statusCode: 502 }), /keeps checking/);
});

test("the billing screen runs the confirmation after the browser and never converts a purchase into a plan change", () => {
  const src = readFileSync(new URL("../app/(stack)/billing.tsx", import.meta.url), "utf8");
  assert.match(src, /payPalReturnConfirmation\(response, provider\)/);
  assert.match(src, /apiFetch\(confirmation\.path/);
  const refused = src.slice(src.indexOf('code === "SUBSCRIPTION_ALREADY_ACTIVE"'), src.indexOf('code === "SUBSCRIPTION_ALREADY_ACTIVE"') + 600);
  assert.doesNotMatch(refused, /\/v1\/billing\/subscription\/plan/);
});

test("a refused re-check says nothing was checked, never 'settling' or 'was checked'", () => {
  for (const outcome of ["BUSY", "RATE_LIMITED"]) {
    const res = A.reconcileMessage({ outcome, summary: null });
    assert.match(res.message, /Nothing new was checked/);
    assert.doesNotMatch(res.message, /settling|Billing was checked/i);
    assert.equal(res.refresh, false);
  }
});

test("the account re-check claims no settlement and speaks for no provider", () => {
  const res = A.reconcileMessage({
    outcome: "UPDATED",
    summary: {
      checked: 2, creditsRestored: 0, paymentsRecorded: 0, subscriptionsUpdated: 0, attemptsUpdated: 1,
      pending: 0, actionRequired: 0, unavailable: 0, discrepancies: 0,
      attempts: [
        { outcome: "UPDATED", currentStatus: "ABANDONED", provider: "PAYPAL" },
        { outcome: "STILL_PENDING", waitingFor: "PAYMENT_PAGE", provider: "STRIPE" },
      ],
    },
  });
  assert.doesNotMatch(res.message, /Nothing was charged/);
  assert.doesNotMatch(res.message, /updated from what the provider confirmed/);
  assert.match(res.message, /PROOVRA closed it here\. PayPal did not confirm this/);
  assert.match(res.message, /1 card payment page is still open and unpaid/);
  assert.doesNotMatch(res.message, /approved and still/);
});

test("a cancellation the provider never answered is recognised, by code", () => {
  assert.equal(A.cancellationOutcomeUnknown({ code: "PROVIDER_CANCELLATION_OUTCOME_UNKNOWN" }), true);
  assert.equal(A.cancellationOutcomeUnknown({ code: "PROVIDER_CANCELLATION_FAILED" }), false);
  assert.doesNotMatch(A.CANCELLATION_UNCONFIRMED_COPY, /nothing has changed/i);
});

test("storage a Free account may keep is not said to end with the plan", () => {
  const lines = A.subscriptionCancelConsequence(
    {
      plan: { displayName: "Pro", paymentProviderLabel: "PayPal" },
      storageAddons: {
        active: [
          { legacyOneTime: false, status: "ACTIVE", endsWithPlan: false },
          { legacyOneTime: false, status: "ACTIVE", endsWithPlan: true },
        ],
      },
    },
    null,
  );
  const text = lines.join(" ");
  assert.match(text, /PayPal ends a subscription immediately/);
  assert.match(text, /1 recurring storage add-on will be cancelled/);
  assert.match(text, /1 storage add-on you can keep on Free stays active/);
});

test("F-09: only the private build with private billing can check out; store profiles cannot", () => {
  const saved = { d: process.env.EXPO_PUBLIC_DISTRIBUTION, b: process.env.EXPO_PUBLIC_PRIVATE_BILLING };
  try {
    delete process.env.EXPO_PUBLIC_DISTRIBUTION;
    delete process.env.EXPO_PUBLIC_PRIVATE_BILLING;
    assert.equal(P.purchaseAvailability(), "NOT_IN_THIS_BUILD");
    process.env.EXPO_PUBLIC_DISTRIBUTION = "PRIVATE";
    assert.equal(P.purchaseAvailability(), "NOT_IN_THIS_BUILD");
    process.env.EXPO_PUBLIC_PRIVATE_BILLING = "enabled";
    assert.equal(P.purchaseAvailability(), "EXTERNAL_CHECKOUT");
  } finally {
    if (saved.d === undefined) delete process.env.EXPO_PUBLIC_DISTRIBUTION; else process.env.EXPO_PUBLIC_DISTRIBUTION = saved.d;
    if (saved.b === undefined) delete process.env.EXPO_PUBLIC_PRIVATE_BILLING; else process.env.EXPO_PUBLIC_PRIVATE_BILLING = saved.b;
  }
  // The store profile still sets neither flag (no preview flags leak into store builds).
  const eas = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8"));
  assert.equal(eas.build.production.env.EXPO_PUBLIC_DISTRIBUTION, undefined);
  assert.equal(eas.build.production.env.EXPO_PUBLIC_PRIVATE_BILLING, undefined);
  assert.equal(eas.build.preview.env.EXPO_PUBLIC_PRIVATE_BILLING, "enabled");
});

/*
 * AUDIT E-09 / F-P1-06 (2026-11-15) — the private build's card return asks the
 * server about the attempt the Stripe checkout response named.
 */
const ATTEMPT_ID = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";

test("the Stripe checkout response names its attempt; anything else names none", () => {
  const session = (extra) => ({ provider: "STRIPE", session: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", ...extra } });
  assert.equal(P.stripeCheckoutAttemptId(session({ client_reference_id: ATTEMPT_ID, metadata: { attemptId: ATTEMPT_ID } }), "stripe"), ATTEMPT_ID);
  assert.equal(P.stripeCheckoutAttemptId(session({ metadata: { attemptId: ATTEMPT_ID } }), "stripe"), ATTEMPT_ID);
  assert.equal(P.stripeCheckoutAttemptId(session({ client_reference_id: ATTEMPT_ID }), "stripe"), ATTEMPT_ID);
  // Disagreeing, malformed, PayPal, or a plan change with no session: never a guess.
  assert.equal(P.stripeCheckoutAttemptId(session({ client_reference_id: ATTEMPT_ID, metadata: { attemptId: "7f9619ff-8b86-4d11-b42d-00c04fc964ff" } }), "stripe"), null);
  assert.equal(P.stripeCheckoutAttemptId(session({ client_reference_id: "../../admin" }), "stripe"), null);
  assert.equal(P.stripeCheckoutAttemptId(session({ client_reference_id: ATTEMPT_ID }), "paypal"), null);
  assert.equal(P.stripeCheckoutAttemptId({ outcome: "PROVIDER_TRANSITION_STARTED", approvalUrl: "https://checkout.stripe.com/x" }, "stripe"), null);
});

test("closing the browser: re-check first; only an open, unpaid page asks abandon (confirmed: false); a paid or settling one never does", async () => {
  const run = async (recheck, abandon) => {
    const calls = [];
    const answer = await A.confirmStripeCheckoutReturn({
      accountType: "PERSONAL",
      accountId: "p-1",
      attemptId: ATTEMPT_ID,
      resumeAllowed: true,
      request: async (path, init) => {
        calls.push({ path, body: init.body });
        if (path.endsWith("/recheck")) {
          if (recheck instanceof Error) throw recheck;
          return recheck;
        }
        return abandon;
      },
    });
    return { answer, calls };
  };
  const base = `/v1/billing/accounts/PERSONAL/p-1/checkout-attempts/${ATTEMPT_ID}`;

  const open = await run(
    { provider: "STRIPE", outcome: "STILL_PENDING", waitingFor: "PAYMENT_PAGE", resumeUrl: "https://checkout.stripe.com/c/pay/cs_1" },
    { outcome: "ABANDON_CONFIRMATION_REQUIRED", cancelsAtProvider: true, warning: "Abandoning asks Stripe to close it." },
  );
  assert.deepEqual(open.calls, [
    { path: `${base}/recheck`, body: "{}" },
    { path: `${base}/abandon`, body: JSON.stringify({ confirmed: false }) },
  ]);
  assert.deepEqual(open.answer.confirmAbandon, { attemptId: ATTEMPT_ID, warning: "Abandoning asks Stripe to close it.", cancelsAtProvider: true });

  for (const recheck of [
    { provider: "STRIPE", outcome: "UPDATED", currentStatus: "COMPLETED" },
    { provider: "STRIPE", outcome: "STILL_PENDING", waitingFor: "PAYMENT_PROCESSING" },
    { provider: "STRIPE", outcome: "NO_CHANGE", currentStatus: "EXPIRED" },
  ]) {
    const r = await run(recheck, null);
    assert.equal(r.calls.length, 1, JSON.stringify(recheck));
    assert.equal(r.answer.confirmAbandon, null);
  }
  const failed = await run(new Error("offline"), null);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.answer.notice, A.STRIPE_RETURN_UNCONFIRMED);
});

test("store builds keep no purchase path: the return runs only after a private-build checkout", () => {
  const saved = { d: process.env.EXPO_PUBLIC_DISTRIBUTION, b: process.env.EXPO_PUBLIC_PRIVATE_BILLING };
  delete process.env.EXPO_PUBLIC_DISTRIBUTION;
  delete process.env.EXPO_PUBLIC_PRIVATE_BILLING;
  try {
    assert.equal(P.purchaseAvailability(), "NOT_IN_THIS_BUILD");
  } finally {
    if (saved.d !== undefined) process.env.EXPO_PUBLIC_DISTRIBUTION = saved.d;
    if (saved.b !== undefined) process.env.EXPO_PUBLIC_PRIVATE_BILLING = saved.b;
  }
  const src = readFileSync(new URL("../app/(stack)/billing.tsx", import.meta.url), "utf8");
  // The attempt is remembered only where a checkout URL was obtained (executePurchase,
  // which refuses without privateCheckout), and the return re-checks it only on a private build.
  assert.match(src, /pendingStripeAttempt\.current = stripeCheckoutAttemptId\(response, provider\)/);
  assert.match(src, /else if \(stripeAttempt && account && privateCheckout\)/);
  assert.equal(src.match(/stripeCheckoutAttemptId\(/g)?.length, 1);
});
