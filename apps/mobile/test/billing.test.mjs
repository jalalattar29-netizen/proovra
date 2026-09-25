/**
 * BILLING — the transaction matrix, enforced.
 *
 * "App-store rules" is not evidence, and it is not a reason to remove a
 * surface. Every billing action is classified by what it actually does, and
 * exactly three — the subscription, storage and credit CHECKOUTS — are a
 * distribution-policy question. Reads and cancellations are not: no store
 * takes a position on letting a customer stop paying, and none on showing
 * somebody their own payment history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/billing.ts"), "utf8");
const js = ts.transpileModule(SRC.replace(/^import type .*$/m, ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const B = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/* -------------------------------------------------------------------- paths */

test("the paths are the canonical billing endpoints", () => {
  assert.equal(B.BILLING_ACCOUNTS_PATH, "/v1/billing/accounts");
  assert.equal(B.BILLING_OVERVIEW_PATH, "/v1/billing/overview");
  assert.equal(B.SUBSCRIPTION_CANCEL_PATH, "/v1/billing/subscription/cancel");
  assert.equal(B.STORAGE_ADDON_CANCEL_PATH, "/v1/billing/storage-addons/cancel");
  assert.equal(B.buildBillingAccountPath("PERSONAL", "a1"), "/v1/billing/accounts/PERSONAL/a1");
  assert.equal(
    B.buildBillingHistoryPath("PERSONAL", "a1"),
    "/v1/billing/accounts/PERSONAL/a1/history",
  );
});

/* -------------------------------------------------------- the matrix itself */

test("exactly three transactions are unresolved, and they are the checkouts", () => {
  assert.deepEqual(
    [...B.PURCHASE_TRANSACTIONS],
    ["SUBSCRIPTION_CHECKOUT", "STORAGE_ADDON_CHECKOUT", "EVIDENCE_CREDIT_CHECKOUT"],
  );
});

test("the module never justifies a removal with a store-policy claim", () => {
  // An unsourced assertion about Apple or Google is not product evidence, and
  // it was previously used to remove reads and cancellations wholesale.
  assert.doesNotMatch(SRC, /Apple|Google|App Store|Play Store/i);
});

test("cancellation is treated as management, not as a purchase", () => {
  // It is offered, and it sits on the MANAGE row of the matrix. A test that
  // could pass with the cancel paths deleted would not be testing this.
  assert.match(SRC, /subscription\/cancel/);
  assert.match(SRC, /storage-addons\/cancel/);
  assert.match(SRC, /retry-storage-cancellation/);
});

/* ----------------------------------------------------------------- overview */

test("an empty overview is null, not an account with no plan", () => {
  assert.equal(B.parseBillingOverview({}), null);
  assert.equal(B.parseBillingOverview(null), null);
});

test("the overview reads plan, credits, storage and add-ons", () => {
  const o = B.parseBillingOverview({
    // The server's real shape (billing-overview.service.ts): the summary carries a
    // COUNT; the rows are storageAddons.active. This test used to put an array at
    // summary.activeStorageAddons, a shape the server never sends.
    summary: {
      personalPlan: "PRO",
      personalCredits: 12,
      activeStorageAddons: 2,
      payments: { total: 9, failed: 1 },
    },
    storageAddons: {
      active: [
        { id: "a1", addonKey: "storage_100gb", extraStorageBytes: String(100 * 1024 ** 3), status: "ACTIVE" },
        { id: "a2", addonKey: "storage_1tb", extraStorageBytes: String(1024 ** 4), status: "PAST_DUE" },
        { addonKey: "no id" },
      ],
    },
    workspaces: { personal: { storage: { usedLabel: "12 GB", limitLabel: "100 GB" } } },
  });

  assert.equal(o.plan, "PRO");
  assert.equal(o.credits, 12);
  assert.equal(o.storageLabel, "12 GB");
  assert.equal(o.activeAddons.length, 2, "the active add-on rows were not read");
  assert.equal(o.activeAddons[0].label, "+100 GB storage");
  assert.equal(o.activeAddons[1].label, "+1 TB storage");
  assert.equal(o.paymentsFailed, 1);
});

test("only an ACTIVE add-on is offered a cancel", () => {
  // Offering it again on one already ending is an action with nothing to do.
  assert.equal(B.isCancellableAddon({ status: "ACTIVE" }), true);
  assert.equal(B.isCancellableAddon({ status: "CANCELLING" }), false);
  assert.equal(B.isCancellableAddon({ status: "ENDED" }), false);
});

/* ------------------------------------------------------------------ history */

test("a withheld amount is absent, never zero", () => {
  // The server withholds amounts from a viewer who may not see them. Showing
  // a payment as costing nothing is worse than showing it without a figure.
  const [withheld] = B.parsePaymentHistory({
    items: [{ id: "p1", description: "Subscription", status: "SUCCEEDED" }],
  });
  assert.equal(withheld.amountCents, null);
  assert.equal(B.formatPaymentAmount(withheld), null);

  const [shown] = B.parsePaymentHistory({
    items: [{ id: "p2", description: "x", status: "SUCCEEDED", amountCents: 2900, currency: "USD" }],
  });
  assert.match(B.formatPaymentAmount(shown), /29/);
});

test("a payment row with no id is dropped", () => {
  assert.equal(B.parsePaymentHistory({ items: [{ id: "p1" }, {}, null] }).length, 1);
});

test("a failed payment never renders as successful", () => {
  assert.equal(B.paymentStatusTone("SUCCEEDED"), "verified");
  assert.equal(B.paymentStatusTone("FAILED"), "risk");
  assert.equal(B.paymentStatusTone("REFUNDED"), "neutral");
  assert.equal(B.paymentStatusTone("PENDING"), "pending");
  assert.equal(B.paymentStatusTone("SOMETHING_NEW"), "neutral");
});

test("an unknown currency shows its code rather than a bare number", () => {
  const row = { amountCents: 2900, currency: "NOT_A_CURRENCY" };
  assert.match(B.formatPaymentAmount(row), /NOT_A_CURRENCY/);
});

test("the pending note names what is missing and what is not", () => {
  assert.match(B.PURCHASE_PENDING_NOTE, /not available in the app yet/i);
  // It must say the rest works, or it reads as "billing is unavailable".
  assert.match(B.PURCHASE_PENDING_NOTE, /cancelling/i);
});
