/**
 * BILLING REMEDIATION (2026-10-31, AUD-19) — an open purchase, recovered on
 * native, in the web's words (billingMessages.ts), from what the API returns.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadModule } from "./support/render.mjs";

let A;
let P;

before(async () => {
  A = await loadModule("src/product/billing-account.ts", []);
  P = await loadModule("src/product/billing-purchase.ts", []);
});

const check = (result, resumeAllowed = false) => A.describeAttemptCheck(result, { resumeAllowed });
const CHARGE_CLAIM = /nothing (was|has been) (charged|billed)|no charge was|not been charged/i;

test("an older workspace keeps its own storage figures, apart from the meter", () => {
  const p = A.parseBillingProjection({
    storageAddons: {
      offers: [],
      active: [],
      legacyWorkspaces: [{ name: "Acme archive", addonLabel: "200 GB", usedLabel: "12 GB", limitLabel: "300 GB", planLabel: "100 GB" }],
    },
  });
  assert.deepEqual(p.storageAddons.legacyWorkspaces, [
    { name: "Acme archive", addonLabel: "200 GB", usedLabel: "12 GB", limitLabel: "300 GB", planLabel: "100 GB" },
  ]);
});

test("the attempt paths are the account-scoped checkout-attempt routes", () => {
  assert.equal(A.buildAttemptRecheckPath("PERSONAL", "p 1", "a/1"), "/v1/billing/accounts/PERSONAL/p%201/checkout-attempts/a%2F1/recheck");
  assert.equal(A.buildAttemptAbandonPath("PERSONAL", "p1", "a1"), "/v1/billing/accounts/PERSONAL/p1/checkout-attempts/a1/abandon");
});

test("activity keeps the server's own affordances", () => {
  const [row] = A.parseBillingActivity({
    activity: [{ id: "a", description: "d", statusLabel: "s", state: "ACTIVATING", actions: { canRecheck: true, canAbandon: false } }],
  });
  assert.equal(row.canRecheck, true);
  assert.equal(row.canAbandon, false);
  assert.equal(row.state, "ACTIVATING");
  const [bare] = A.parseBillingActivity({ activity: [{ id: "a", description: "d", statusLabel: "s" }] });
  assert.equal(bare.canRecheck, false, "an absent affordance is not offered");
});

test("pending approval: waits for the buyer, is abandonable, and blocks another purchase", () => {
  const c = check({ outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "APPROVAL" });
  assert.equal(c.state, "WAITING_APPROVAL");
  assert.equal(c.blocked, true);
  assert.equal(c.canAbandon, true);
  assert.match(c.message, /Nothing is charged unless you approve it/);
});

test("approved and activating, or processing: never told to approve, and not abandonable", () => {
  const activating = check({ outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "ACTIVATION" });
  assert.equal(activating.state, "ACTIVATING");
  assert.equal(activating.canAbandon, false);
  assert.match(activating.message, /You approved this at PayPal/);
  assert.doesNotMatch(activating.message, CHARGE_CLAIM);
  const processing = check({ outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "PAYMENT_PROCESSING" });
  assert.equal(processing.state, "PROCESSING");
  assert.equal(processing.canAbandon, false);
});

test("unresolved provider states stay open and never claim what happened to the money", () => {
  for (const outcome of ["PROVIDER_UNAVAILABLE", "PROVIDER_AUTHORIZATION_FAILED", "PROVIDER_MALFORMED", "PROVIDER_REFERENCE_INVALID", "PROVIDER_REFERENCE_NOT_FOUND", "NOT_PROVIDER_BOUND"]) {
    for (const provider of ["PAYPAL", "STRIPE"]) {
      const c = check({ outcome, provider });
      assert.equal(c.state, "UNRESOLVED", outcome);
      assert.equal(c.blocked, true, outcome);
      assert.doesNotMatch(c.message, CHARGE_CLAIM, outcome);
      assert.doesNotMatch(c.message, /settling|still waiting/i, outcome);
    }
  }
  assert.equal(A.attemptNeedsSupport("UNRESOLVED"), true);
  assert.equal(A.attemptNeedsSupport("WAITING_APPROVAL"), false);
});

test("settlement, failure and a closed attempt stop blocking, each said as itself", () => {
  const paid = check({ outcome: "UPDATED", provider: "PAYPAL", currentStatus: "ACTIVE" });
  assert.equal(paid.state, "PAID");
  assert.equal(paid.blocked, false);
  assert.equal(paid.tone, "success");
  assert.match(paid.message, /PayPal confirmed this purchase/);
  assert.equal(check({ outcome: "UPDATED", provider: "STRIPE", currentStatus: "FAILED" }).state, "FAILED");
  assert.equal(check({ outcome: "NO_CHANGE", provider: "STRIPE", currentStatus: "EXPIRED" }).blocked, false);
  const local = check({ outcome: "UPDATED", provider: "PAYPAL", currentStatus: "ABANDONED" });
  assert.equal(local.state, "CLOSED_LOCALLY");
  assert.match(local.message, /PayPal did not confirm this and nothing was cancelled there/);
});

test("Continue is a private-build hand-over; any other build is told where to finish", () => {
  const open = { outcome: "STILL_PENDING", provider: "STRIPE", waitingFor: "PAYMENT_PAGE", resumeUrl: "https://checkout.stripe.com/c/pay/cs_1" };
  assert.equal(check(open, true).resumeUrl, open.resumeUrl);
  assert.match(check(open, true).message, /continue checkout/);
  const store = check(open, false);
  assert.equal(store.resumeUrl, null);
  assert.match(store.message, /use Billing on the web, or abandon it here/);
  assert.match(A.billingActivityNote(false), /use Billing on the web/);
  assert.doesNotMatch(A.billingActivityNote(true), /on the web/);
});

test("a link that is not the provider's own page is never offered", () => {
  const c = check({ outcome: "STILL_PENDING", provider: "PAYPAL", resumeUrl: "https://paypal.com.evil.example/x" }, true);
  assert.equal(c.resumeUrl, null);
});

test("local abandonment speaks for PROOVRA only", () => {
  const local = A.describeAttemptAbandon({ outcome: "ABANDONED", cancelsAtProvider: false });
  assert.match(local.message, /This did not cancel anything at the payment provider/);
  assert.doesNotMatch(local.message, CHARGE_CLAIM);
  assert.equal(local.resolved, true);
  assert.doesNotMatch(A.describeAttemptAbandon({ outcome: "ABANDONED", cancelsAtProvider: true }).message, CHARGE_CLAIM);
  assert.match(A.abandonMessage("ABANDONED").message, /did not cancel anything/);
  assert.doesNotMatch(A.abandonMessage("ABANDONED").message, CHARGE_CLAIM);
});

test("a refused abandon stays open and stops offering what was refused", () => {
  const refused = A.describeAttemptAbandon({ outcome: "ABANDON_NOT_ALLOWED" });
  assert.equal(refused.resolved, false);
  assert.equal(refused.canAbandon, false);
  const failed = A.describeAttemptAbandon({ outcome: "PROVIDER_CANCEL_FAILED" });
  assert.equal(failed.resolved, false);
  assert.equal(failed.canAbandon, true);
  assert.match(A.abandonMessage("ABANDON_NOT_ALLOWED").message, /cannot be abandoned/);
});

test("the confirmation carries the server's warning, with an honest fallback", () => {
  assert.deepEqual(A.attemptAbandonConfirmation({ warning: "W", cancelsAtProvider: true }), { warning: "W", cancelsAtProvider: true });
  assert.match(A.attemptAbandonConfirmation({}).warning, /does not cancel anything at the payment provider/);
});

test("a storage refusal's details decide the way forward", () => {
  assert.deepEqual(A.storageRefusalAction({ details: { retry: "CONFIRM_ADDITIONAL", activeCount: 2 } }), { kind: "CONFIRM_ADDITIONAL", activeCount: 2 });
  assert.deepEqual(
    A.storageRefusalAction({ details: { retry: "RECONCILE_STORAGE_ATTEMPT", attemptId: "a1", createdAtUtc: "2026-10-30T00:00:00Z" } }),
    { kind: "RECOVER", attemptId: "a1", pendingProvider: "PAYPAL", createdAtUtc: "2026-10-30T00:00:00Z" },
  );
  assert.equal(A.storageRefusalAction({ details: { retry: "RECONCILE_STORAGE_ATTEMPT" } }), null);
  assert.equal(A.storageRefusalAction({ code: "STORAGE_ADDON_NOT_OFFERED" }), null);
  assert.match(A.storageRecoveryIntroduction("STRIPE", "30 Oct"), /already open by card \(started 30 Oct\)/);
});

test("every storage refusal has its own sentence, and an unknown code has none", () => {
  for (const code of ["STORAGE_ADDON_ALREADY_HELD", "STORAGE_PURCHASE_PENDING", "PAYPAL_STORAGE_APPROVAL_PENDING", "STORAGE_ADDON_PREREQUISITE_ENDING", "STORAGE_ADDON_NOT_INCLUDED", "STORAGE_ADDON_NOT_OFFERED", "CHECKOUT_TARGET_NOT_SUPPORTED"]) {
    assert.ok(A.billingRefusalMessage({ code }), code);
  }
  assert.equal(A.billingRefusalMessage({ code: "SOMETHING_ELSE" }), null);
  assert.doesNotMatch(A.billingRefusalMessage({ code: "PLAN_CHANGE_OUTCOME_UNKNOWN" }), /nothing changed/i);
});

test("stacking is sent only after the customer agreed to the second charge", () => {
  const first = P.checkoutRequest({ kind: "STORAGE", addonKey: "PERSONAL_50_GB", currency: "EUR" }, "stripe");
  assert.equal("confirmAdditional" in first.body, false);
  const second = P.checkoutRequest({ kind: "STORAGE", addonKey: "PERSONAL_50_GB", currency: "EUR", confirmAdditional: true }, "stripe");
  assert.equal(second.body.confirmAdditional, true);
  assert.match(A.storageAdditionalPrompt(1, "€9.00"), /separate recurring charge of €9\.00 per month/);
});

test("PayPal's return words say what is known, not that nothing was charged", () => {
  for (const [kind, response] of [
    ["ORDER_CAPTURE", { outcome: "PENDING", reason: "AWAITING_APPROVAL" }],
    ["ORDER_CAPTURE", { outcome: "CANCELED" }],
    ["SUBSCRIPTION_CONFIRM", { outcome: "AWAITING_APPROVAL" }],
  ]) {
    assert.doesNotMatch(P.payPalReturnNotice(kind, response), CHARGE_CLAIM);
  }
});

test("the store build gets no checkout: Continue is gated and only the check returns a link", () => {
  const src = readFileSync(new URL("../app/(stack)/billing.tsx", import.meta.url), "utf8");
  assert.match(src, /describeAttemptCheck\(result, \{ resumeAllowed: privateCheckout \}\)/);
  assert.match(src, /if \(!privateCheckout \|\| !checked\) return;/);
});

test("the stale pre-fix copies are gone", () => {
  for (const path of ["../app/(stack)/billing.tsx.before-plan-fix", "../src/ui/billing-plan-sheets.tsx.before-plan-fix"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});
