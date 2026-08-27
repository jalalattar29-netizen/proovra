/**
 * BILLING COMMERCIAL CORRECTNESS — Gate B.
 *
 * Pins the billing-account model, the granular capability matrix, payment
 * ownership and renewal binding, the cancellation contract, and the recurring
 * storage add-on contract.
 *
 * These are behaviour tests over the canonical authorities plus source
 * contracts for the properties a unit test cannot observe (that a provider is
 * asked BEFORE anything local is written, that no local-only fallback exists).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  ALL_BILLING_CAPABILITIES,
  paymentWhereForAccount,
  type BillingAccountRef,
} from "../src/services/billing/billing-accounts.service.js";
import {
  cancellationModeForProvider,
} from "../src/services/billing/subscription-cancellation.service.js";
import {
  paypalSubscriptionIdFromSale,
  stripeSubscriptionIdFromInvoice,
} from "../src/services/billing/provider-subscription-binding.service.js";

const readSource = async (rel: string): Promise<string> => {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
};

const ref = (
  type: BillingAccountRef["type"],
  id: string,
  capabilities: BillingAccountRef["capabilities"],
): BillingAccountRef => ({
  type,
  id,
  displayName: id,
  capabilities,
  billingOwnerMissing: false,
});

// =============================================================================
// 1. The billing-account model
// =============================================================================

describe("billing accounts — three kinds, and a Collaboration Team is not one", () => {
  it("declares exactly six granular capabilities", () => {
    expect([...ALL_BILLING_CAPABILITIES].sort()).toEqual([
      "BILLING_ACCOUNT_VIEW",
      "BILLING_ADDON_PURCHASE",
      "BILLING_AMOUNT_VIEW",
      "BILLING_CANCEL",
      "BILLING_HISTORY_VIEW",
      "BILLING_MANAGE",
    ]);
  });

  it("never enumerates a Collaboration Team as a billing account", async () => {
    const src = await readSource(
      "../src/services/billing/billing-accounts.service.ts",
    );
    // The enumerator reads `team` (workspaces) and `organizationMembership`.
    // A `collaborationTeam` query here would be the conflation the whole
    // correction exists to remove.
    expect(src).not.toMatch(/prisma\.collaborationTeam\./);
    expect(src).toMatch(/prisma\.team\.findMany/);
  });

  it("excludes CUSTOMER-organization workspaces from the WORKSPACE list", async () => {
    const src = await readSource(
      "../src/services/billing/billing-accounts.service.ts",
    );
    // An Enterprise tenant must not get one fabricated contract per workspace:
    // its workspaces roll up to the ORGANIZATION account.
    expect(src).toMatch(/NOT:\s*\{\s*organization:\s*\{\s*kind:\s*"CUSTOMER"\s*\}\s*\}/);
  });

  it("fails closed on an account the viewer cannot see", async () => {
    const src = await readSource(
      "../src/services/billing/billing-accounts.service.ts",
    );
    // 404, not 403: a 403 would confirm the id exists and let the endpoint be
    // used to enumerate other tenants' workspaces.
    expect(src).toMatch(/httpStatus:\s*404/);
    expect(src).toMatch(/BILLING_ACCOUNT_NOT_FOUND/);
  });
});

// =============================================================================
// 2. Account-scoped payment ownership
// =============================================================================

describe("payment history is scoped to ONE billing account", () => {
  it("a PERSONAL account matches only its own team-less payments", () => {
    expect(
      paymentWhereForAccount({
        account: ref("PERSONAL", "user-1", ["BILLING_HISTORY_VIEW"]),
      }),
    ).toEqual({ userId: "user-1", teamId: null });
  });

  it("a WORKSPACE account matches that workspace's payments and no others", () => {
    // Deliberately NOT scoped by userId as well: a workspace's payments belong
    // to the workspace, whoever happened to hold the card at the time. Adding
    // `userId` would hide history from a transferred billing owner.
    expect(
      paymentWhereForAccount({
        account: ref("WORKSPACE", "ws-1", ["BILLING_HISTORY_VIEW"]),
      }),
    ).toEqual({ teamId: "ws-1" });
  });

  it("an ORGANIZATION account matches its constituent workspaces", () => {
    expect(
      paymentWhereForAccount({
        account: ref("ORGANIZATION", "org-1", ["BILLING_HISTORY_VIEW"]),
        organizationWorkspaceIds: ["ws-1", "ws-2"],
      }),
    ).toEqual({ teamId: { in: ["ws-1", "ws-2"] } });
  });

  it("an organization with no workspaces matches NOTHING, not everything", () => {
    // The failure mode this guards: an empty `in` list degrading to an
    // unfiltered read of every payment in the system.
    expect(
      paymentWhereForAccount({
        account: ref("ORGANIZATION", "org-1", ["BILLING_HISTORY_VIEW"]),
        organizationWorkspaceIds: [],
      }),
    ).toEqual({ id: { in: [] } });
  });

  it("REGRESSION: personal and workspace payments are never merged", () => {
    const personal = paymentWhereForAccount({
      account: ref("PERSONAL", "user-1", []),
    });
    const workspace = paymentWhereForAccount({
      account: ref("WORKSPACE", "ws-1", []),
    });
    // The previous projection returned ONE array containing both, labelled by
    // `teamId` in the UI — so one payer's total sat under another payer's plan.
    expect(personal).not.toEqual(workspace);
    expect(JSON.stringify(personal)).not.toContain("ws-1");
  });

  it("returns nothing at all without BILLING_HISTORY_VIEW", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    expect(src).toMatch(
      /if \(!input\.account\.capabilities\.includes\("BILLING_HISTORY_VIEW"\)\)/,
    );
  });

  it("emits a safe DTO — never a raw Prisma payment row", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    // Explicit field construction only. A spread of a database row is how a
    // column added by a future migration leaks.
    expect(src).not.toMatch(/\.\.\.row\b/);
    expect(src).not.toMatch(/\.\.\.payment\b/);
    // `userId` is never projected onto a history entry.
    expect(src).toMatch(/export type BillingHistoryEntry = \{/);
    const dto = src.slice(
      src.indexOf("export type BillingHistoryEntry = {"),
      src.indexOf("};", src.indexOf("export type BillingHistoryEntry = {")),
    );
    expect(dto).not.toMatch(/userId/);
    expect(dto).not.toMatch(/providerPaymentId/);
  });
});

// =============================================================================
// 3. Renewal ownership
// =============================================================================

describe("renewals are bound to the stored subscription, not to metadata", () => {
  it("reads a Stripe invoice's subscription id in both payload shapes", () => {
    expect(stripeSubscriptionIdFromInvoice({ subscription: "sub_123" })).toBe(
      "sub_123",
    );
    expect(
      stripeSubscriptionIdFromInvoice({ subscription: { id: "sub_obj" } }),
    ).toBe("sub_obj");
    // Newer API versions nest it. A webhook that silently stops matching after
    // a version bump is the same defect class as the metadata one.
    expect(
      stripeSubscriptionIdFromInvoice({
        parent: { subscription_details: { subscription: "sub_nested" } },
      }),
    ).toBe("sub_nested");
    expect(stripeSubscriptionIdFromInvoice({})).toBeNull();
  });

  it("reads a PayPal recurring sale's billing agreement id", () => {
    expect(
      paypalSubscriptionIdFromSale({ billing_agreement_id: "I-ABC" }),
    ).toBe("I-ABC");
    expect(paypalSubscriptionIdFromSale({})).toBeNull();
    expect(paypalSubscriptionIdFromSale({ billing_agreement_id: "  " })).toBeNull();
  });

  it("REGRESSION: Stripe renewals no longer require invoice metadata", async () => {
    const src = await readSource("../src/routes/webhooks.routes.ts");
    const invoiceBlock = src.slice(src.indexOf('event.type === "invoice.paid"'));
    // The old guard was `if (userId && plan)` over `invoice.metadata`. Stripe
    // does not copy subscription metadata onto invoice.metadata, so it never
    // fired and payment history stopped after the first checkout.
    expect(invoiceBlock).toMatch(/stripeSubscriptionIdFromInvoice/);
    expect(invoiceBlock).toMatch(/resolveSubjectFromProviderSubscription/);
  });

  it("REGRESSION: PayPal recurring sales are handled at all", async () => {
    const src = await readSource("../src/routes/webhooks.routes.ts");
    // `PAYMENT.SALE.COMPLETED` is the PayPal renewal event and was not
    // implemented, so every PayPal renewal was invisible.
    expect(src).toMatch(/PAYMENT\.SALE\.COMPLETED/);
    expect(src).toMatch(/PAYMENT\.SALE\.DENIED/);
    expect(src).toMatch(/paypalSubscriptionIdFromSale/);
  });

  it("does NOT attribute a payment it cannot bind", async () => {
    const src = await readSource("../src/routes/webhooks.routes.ts");
    // An unbindable provider event is a real state. Guessing an owner writes a
    // guess into someone's financial history.
    expect(src).toMatch(/unattributable_no_stored_subscription/);
  });
});

// =============================================================================
// 4. Cancellation
// =============================================================================

describe("cancellation never claims more than the provider confirmed", () => {
  it("schedules at period end on Stripe and is immediate on PayPal", () => {
    expect(cancellationModeForProvider("STRIPE")).toBe("PERIOD_END");
    // PayPal's subscription cancel has no period-end option. Saying so is the
    // point: the previous dialog promised a period end for both.
    expect(cancellationModeForProvider("PAYPAL")).toBe("IMMEDIATE");
  });

  it("REGRESSION: Stripe is asked to cancel at period end, not DELETEd", async () => {
    const src = await readSource(
      "../src/services/billing/subscription-cancellation.service.ts",
    );
    expect(src).toMatch(/cancel_at_period_end/);
    // `DELETE /subscriptions/{id}` is immediate termination and was what the
    // route actually did while the dialog promised otherwise.
    expect(src).not.toMatch(/"DELETE"/);
  });

  it("REGRESSION: a failed PayPal cancellation NEVER falls back to a local cancel", async () => {
    const src = await readSource(
      "../src/services/billing/subscription-cancellation.service.ts",
    );
    const paypalBranch = src.slice(
      src.indexOf("PaymentProvider.PAYPAL"),
      src.indexOf("// ---- Record ONLY what the provider confirmed"),
    );
    // The old route caught this failure, logged a warning and wrote CANCELED
    // anyway — reporting a cancellation PayPal was still billing for.
    expect(paypalBranch).toMatch(/throw Object\.assign\(providerFailure/);
    expect(paypalBranch).not.toMatch(/prisma\.subscription\.update/);
  });

  it("never writes the terminal CANCELED status itself", async () => {
    const src = await readSource(
      "../src/services/billing/subscription-cancellation.service.ts",
    );
    // BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the local
    // write moved INTO a transaction (it now records the dependent
    // obligations alongside the base result), so the anchor is the transaction
    // rather than the bare update. The property is unchanged and the
    // assertion is now stronger: no branch anywhere in the service may write
    // the terminal status.
    const updateBlock = src.slice(src.indexOf("tx.subscription.update"));
    // The terminal transition is the provider's own statement and arrives by
    // webhook. Writing it here recreates the disagreement.
    expect(updateBlock).not.toMatch(
      /status:\s*prismaPkg\.SubscriptionStatus\.CANCELED/,
    );
    expect(src).not.toMatch(
      /data:\s*\{[^}]*status:\s*prismaPkg\.SubscriptionStatus\.CANCELED/,
    );
    // Stripe's confirmed period-end schedule is still recorded.
    expect(updateBlock).toMatch(/cancelAtPeriodEnd:\s*schedulesPeriodEnd/);
  });

  it("writes nothing locally before the provider answers", async () => {
    const src = await readSource(
      "../src/services/billing/subscription-cancellation.service.ts",
    );
    const providerCallAt = src.indexOf("// ---- Ask the provider FIRST");
    // The local write is now the transaction that records the base result AND
    // the dependent obligations together. It must still come strictly after
    // the provider has answered — the obligation only exists because the base
    // cancellation really happened.
    const localWriteAt = src.indexOf("prisma.$transaction");
    expect(providerCallAt).toBeGreaterThan(0);
    expect(localWriteAt).toBeGreaterThan(providerCallAt);
    // And no bare subscription update may creep back in ahead of it.
    expect(src).not.toMatch(/prisma\.subscription\.update\(/);
  });

  it("the cancel route requires BILLING_CANCEL, not workspace ownership", async () => {
    const src = await readSource("../src/routes/billing.routes.ts");
    const route = src.slice(
      src.indexOf('"/v1/billing/subscription/cancel"'),
      src.indexOf('"/v1/billing/storage-addons/cancel"'),
    );
    expect(route).toMatch(/capability:\s*"BILLING_CANCEL"/);
    expect(route).not.toMatch(/assertOwnedTeamForCheckout/);
  });
});

// =============================================================================
// 5. Recurring storage add-ons + legacy preservation
// =============================================================================

describe("storage add-ons are recurring monthly, legacy purchases preserved", () => {
  it("no checkout path can create a ONE_TIME add-on any more", async () => {
    const src = await readSource("../src/services/billing-checkout.service.ts");
    expect(src).toMatch(
      /billingCycle !== prismaPkg\.StorageAddonBillingCycle\.MONTHLY/,
    );
    expect(src).toMatch(/recurring monthly subscriptions/);
  });

  it("the Stripe add-on checkout runs in subscription mode with a monthly interval", async () => {
    const src = await readSource("../src/services/billing-checkout.service.ts");
    const fn = src.slice(
      src.indexOf("export async function createStripeStorageAddonCheckoutSession"),
    );
    expect(fn).toMatch(/const mode = "subscription"/);
    // Without the recurring interval an inline price is a one-time charge, and
    // Stripe rejects it in subscription mode — a "monthly" add-on that bills
    // once and never again.
    expect(fn).toMatch(/price_data\]\[recurring\]\[interval\]/);
  });

  it("PayPal add-ons subscribe to the configured recurring plans", async () => {
    const map = await readSource("../src/services/paypal-plan-map.service.ts");
    // Twelve PAYPAL_PLAN_STORAGE_* ids were configured and read by no code.
    expect(map).toMatch(/PAYPAL_PLAN_STORAGE_/);
    expect(map).toMatch(/resolvePayPalStorageAddonPlanId/);

    const svc = await readSource("../src/services/paypal.service.ts");
    const fn = svc.slice(
      svc.indexOf("export async function createPayPalStorageAddonCheckout"),
    );
    expect(fn).toMatch(/\/v1\/billing\/subscriptions/);
    expect(fn).not.toMatch(/intent: "CAPTURE"/);
  });

  it("a grandfathered ONE_TIME add-on keeps its capacity and cannot be cancelled", async () => {
    const src = await readSource("../src/routes/billing.routes.ts");
    expect(src).toMatch(/LEGACY_ONE_TIME_ADDON_NOT_CANCELLABLE/);
    expect(src).toMatch(/does not renew, and the storage it added stays/);
  });

  it("the projection reports legacy and recurring capacity separately", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    expect(src).toMatch(/legacyAddonBytes/);
    expect(src).toMatch(/recurringAddonBytes/);
    expect(src).toMatch(/legacyOneTime/);
  });

  it("add-on status follows its subscription's lifecycle on BOTH providers", async () => {
    // BILLING RECONCILIATION (2026-08-27) — the mapping MOVED out of the
    // webhook route, and the assertion follows it while getting stronger.
    //
    // It used to check that the function was DEFINED in `webhooks.routes.ts`.
    // Reconciliation now learns the same provider facts by polling, so the
    // property that matters is no longer "the webhook has a mapping" but "both
    // paths use the SAME one" — a second copy is how a polled cancellation and
    // a pushed one would come to mean different things.
    const handlers = await readSource(
      "../src/services/billing/subscription-lifecycle.handlers.ts",
    );
    expect(handlers).toMatch(/function storageAddonStatusFromSubscription/);

    // Neither consumer may define its own.
    for (const consumer of [
      "../src/routes/webhooks.routes.ts",
      "../src/services/billing/reconciliation/reconciliation.service.ts",
    ]) {
      const src = await readSource(consumer);
      expect(
        src,
        `${consumer} must IMPORT the shared mapping, never redefine it`,
      ).not.toMatch(/function storageAddonStatusFromSubscription/);
      expect(src).toMatch(/storageAddonStatusFromSubscription/);
    }

    // Both branches previously logged "unsupported" and dropped the event, so a
    // cancelled add-on kept granting capacity.
    const webhook = await readSource("../src/routes/webhooks.routes.ts");
    expect(webhook).not.toMatch(
      /unsupported\.storage_addon_subscription_event_ignored/,
    );
  });
});

// =============================================================================
// 6. Honest meters
// =============================================================================

describe("usage meters never fabricate a zero", () => {
  it("models NOT_INCLUDED, CONTRACT_MANAGED and UNAVAILABLE as distinct states", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    expect(src).toMatch(/state:\s*"NOT_INCLUDED"/);
    expect(src).toMatch(/state:\s*"CONTRACT_MANAGED"/);
    expect(src).toMatch(/state:\s*"UNAVAILABLE"/);
  });

  it("carries the measurement WINDOW with every count", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    // "43 of 100" means something different on a lifetime cap and a rolling
    // 30-day cap, and one shared chip cannot say which the customer bought.
    expect(src).toMatch(/export type UsageWindow =/);
    expect(src).toMatch(/"ROLLING_30_DAYS"/);
    expect(src).toMatch(/"LIFETIME"/);
    expect(src).toMatch(/"CALENDAR_MONTH"/);
  });

  it("offers no fabricated payment-method or invoice surface", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    // PROOVRA stores no provider customer id and issues no invoices, so these
    // would be invented data.
    expect(src).not.toMatch(/cardBrand|last4|paymentMethodId|invoiceNumber|invoicePdf/);
  });

  it("Enterprise offers no self-service checkout", async () => {
    const src = await readSource(
      "../src/services/billing/billing-account-projection.service.ts",
    );
    const orgFn = src.slice(
      src.indexOf("async function buildOrganizationProjection"),
    );
    expect(orgFn).toMatch(/canStartCheckout:\s*false/);
    expect(orgFn).toMatch(/contactAccountManager:\s*true/);
  });
});
