/**
 * CLIENT-X — B6-F-02 (native half).
 *
 * `POST /v1/billing/checkout/stripe` (credit) and the PayPal credit start can
 * now answer `{ code: "PREVIOUS_PURCHASE_CONFIRMING", message, details }` when
 * the previous credit purchase is paid/approved but not yet confirmed. The
 * billing screen's checkout catch reads `billingRefusalMessage(err)` first;
 * before, this code had no sentence and the person got the generic "Checkout
 * could not be started" text (or the raw server message).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let A;
before(async () => {
  A = await loadModule("src/product/billing-account.ts", []);
});

test("B6-F-02: PREVIOUS_PURCHASE_CONFIRMING says the previous purchase is being confirmed", () => {
  assert.equal(
    A.billingRefusalMessage({ code: "PREVIOUS_PURCHASE_CONFIRMING", statusCode: 409 }),
    "Your previous purchase is being confirmed — it will appear under Billing activity in a moment.",
  );
  // The in-progress code keeps its own sentence.
  assert.match(A.billingRefusalMessage({ code: "CHECKOUT_IN_PROGRESS" }), /already starting/);
});

test("B6-F-02: the credit checkout's refusal path reads billingRefusalMessage first", () => {
  const screen = readFileSync(resolve(HERE, "../app/(stack)/billing.tsx"), "utf8");
  assert.match(screen, /setPurchaseError\(\s*billingRefusalMessage\(err\) \?\?/);
});
