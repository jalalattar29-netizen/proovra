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
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", { outcome: "PENDING", reason: "AWAITING_APPROVAL" }), /nothing has been charged/);
  assert.match(P.payPalReturnNotice("ORDER_CAPTURE", { outcome: "PENDING", reason: "CAPTURE_PENDING" }), /keeps checking/);
  assert.match(P.payPalReturnNotice("SUBSCRIPTION_CONFIRM", { outcome: "AWAITING_APPROVAL" }), /nothing has been charged/);
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
