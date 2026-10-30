/**
 * BILLING REMEDIATION (2026-10-30) — the pure contracts, each named by finding:
 * price verification per catalogue family, offer availability, Stripe's object
 * shapes, status mapping and tie handling, and the preflight's closed verdicts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __clearVerifiedOffersForTests,
  compareStripePrice,
  requireVerifiedStripePrice,
  resolveCommercialOffer,
  stripeOfferAvailability,
  type SelfServiceProduct,
  type StripePriceFacts,
} from "../src/services/billing/commercial-offer.service.js";
import { evaluateBillingOffers, offersNeedingAttention } from "../src/services/billing/offer-preflight.service.js";
import { parseStripeSubscriptionStatus } from "../src/services/billing/stripe-settlement.service.js";
import {
  stripeInvoiceSubscriptionMetadata,
  stripeSubscriptionEnding,
  stripeSubscriptionPeriodEnd,
  stripeSubscriptionScheduleId,
} from "../src/services/billing/stripe-object-shapes.js";
import { decideSubscriptionStatusWrite } from "../src/services/billing/subscription-status.js";
import { decidePaymentTransition } from "../src/services/billing/reconciliation/payment-status.js";
import { planFromStripePriceId } from "../src/services/billing-pricing.service.js";
import { paymentsUnavailable } from "../src/services/billing/payments-unavailable.js";

const FAMILIES: Array<{ name: string; product: SelfServiceProduct; variable: string; recurring: boolean }> = [
  { name: "plan", product: { kind: "PLAN", plan: "PRO" }, variable: "STRIPE_PRO_PRICE_ID_EUR", recurring: true },
  { name: "credit", product: { kind: "EVIDENCE_CREDIT" }, variable: "STRIPE_PAYG_PRICE_ID_EUR", recurring: false },
  {
    name: "personal storage",
    product: { kind: "STORAGE_ADDON", addonKey: "PERSONAL_10_GB" },
    variable: "STRIPE_STORAGE_PERSONAL_10_GB_MONTHLY_EUR_PRICE_ID",
    recurring: true,
  },
  {
    name: "team storage",
    product: { kind: "STORAGE_ADDON", addonKey: "TEAM_500_GB" },
    variable: "STRIPE_STORAGE_TEAM_500_GB_MONTHLY_EUR_PRICE_ID",
    recurring: true,
  },
];

const goodPrice = (offer: ReturnType<typeof resolveCommercialOffer>, recurring: boolean): StripePriceFacts => ({
  active: true,
  currency: "eur",
  unit_amount: offer.amountCents,
  billing_scheme: "per_unit",
  ...(recurring
    ? { type: "recurring", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } }
    : { type: "one_time", recurring: null }),
});

describe.each(FAMILIES)("AUD-21 price verification: $name", ({ product, variable, recurring }) => {
  const before = process.env[variable];
  beforeEach(() => {
    process.env[variable] = "price_under_test";
    __clearVerifiedOffersForTests();
  });
  afterEach(() => {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  });
  const offer = () => resolveCommercialOffer(product, "EUR");

  it("accepts a matching price", async () => {
    await expect(requireVerifiedStripePrice(offer(), async () => goodPrice(offer(), recurring))).resolves.toBe(
      "price_under_test",
    );
  });

  it("refuses a missing id as plan_not_configured, before any read", async () => {
    delete process.env[variable];
    let reads = 0;
    await expect(
      requireVerifiedStripePrice(offer(), async () => {
        reads += 1;
        return {};
      }),
    ).rejects.toMatchObject({ publicCode: "PAYMENTS_UNAVAILABLE", metadata: { reason: "plan_not_configured" } });
    expect(reads).toBe(0);
    expect(stripeOfferAvailability(offer())).toEqual({ available: false, reason: "NOT_CONFIGURED" });
  });

  it.each([
    ["amount", { unit_amount: 1 }],
    ["currency", { currency: "usd" }],
    ["active", { active: false }],
    ["billing_scheme", { billing_scheme: "tiered", tiers_mode: "graduated" }],
    ["transform_quantity", { transform_quantity: { divide_by: 10, round: "up" } }],
  ])("refuses a mismatched %s and marks only this offer unavailable", async (field, patch) => {
    const price = { ...goodPrice(offer(), recurring), ...patch };
    expect(compareStripePrice(price, offer())).toContain(field);
    await expect(requireVerifiedStripePrice(offer(), async () => price)).rejects.toMatchObject({
      metadata: { reason: "plan_price_mismatch" },
    });
    expect(stripeOfferAvailability(offer())).toEqual({ available: false, reason: "REFUSED_RECENTLY" });
  });

  it("classifies a rejected key apart from an outage, and an unknown id as configuration", async () => {
    const fail = (status: number) => async () => {
      throw Object.assign(new Error("no"), { status });
    };
    await expect(requireVerifiedStripePrice(offer(), fail(401))).rejects.toMatchObject({
      metadata: { reason: "provider_authorization_failed" },
    });
    await expect(requireVerifiedStripePrice(offer(), fail(500))).rejects.toMatchObject({
      metadata: { reason: "provider_unreachable_before_create" },
    });
    await expect(requireVerifiedStripePrice(offer(), fail(404))).rejects.toMatchObject({
      metadata: { reason: "plan_not_configured" },
    });
  });
});

describe("AUD-21 recurring-only refusals", () => {
  const variable = "STRIPE_STORAGE_TEAM_500_GB_MONTHLY_EUR_PRICE_ID";
  beforeEach(() => {
    process.env[variable] = "price_team";
    __clearVerifiedOffersForTests();
  });
  afterEach(() => {
    delete process.env[variable];
  });
  const offer = () => resolveCommercialOffer({ kind: "STORAGE_ADDON", addonKey: "TEAM_500_GB" }, "EUR");

  it("a metered price with a matching amount is refused", () => {
    const price = goodPrice(offer(), true);
    expect(
      compareStripePrice({ ...price, recurring: { interval: "month", usage_type: "metered" } }, offer()),
    ).toContain("usage_type");
  });

  it("a one-time price of the right amount is refused", () => {
    expect(compareStripePrice({ ...goodPrice(offer(), true), type: "one_time", recurring: null }, offer())).toContain(
      "interval",
    );
  });

  it("a yearly price of the right amount is refused", () => {
    expect(
      compareStripePrice({ ...goodPrice(offer(), true), recurring: { interval: "year", usage_type: "licensed" } }, offer()),
    ).toContain("interval");
  });

  it("the effective cents override, not the catalogue default, is what is compared", () => {
    const key = "BILLING_STORAGE_TEAM_500_GB_EUR_PRICE_CENTS";
    const catalogue = offer().amountCents;
    process.env[key] = String(catalogue + 100);
    try {
      expect(offer().amountCents).toBe(catalogue + 100);
      expect(compareStripePrice({ ...goodPrice(offer(), true), unit_amount: catalogue }, offer())).toContain("amount");
    } finally {
      delete process.env[key];
    }
  });

  it("one missing SKU does not touch another's availability", () => {
    const other = resolveCommercialOffer({ kind: "STORAGE_ADDON", addonKey: "TEAM_100_GB" }, "EUR");
    expect(stripeOfferAvailability(other)).toEqual({ available: false, reason: "NOT_CONFIGURED" });
    expect(stripeOfferAvailability(offer())).toEqual({ available: true, reason: "OK" });
  });
});

describe("AUD-21 preflight", () => {
  it("reports each storage SKU once, in its own currency, naming the variable, with no USD storage gap", async () => {
    const findings = await evaluateBillingOffers({ fetchStripePrice: async () => ({}) });
    const storage = findings.filter((f) => f.offer.startsWith("STORAGE_"));
    expect(storage).toHaveLength(6);
    expect(storage.every((f) => f.expected.currency === "EUR")).toBe(true);
    const team = storage.find((f) => f.offer.includes("TEAM_500_GB"));
    expect(team).toMatchObject({
      verdict: "NOT_CONFIGURED",
      variable: "STRIPE_STORAGE_TEAM_500_GB_MONTHLY_EUR_PRICE_ID",
    });
  });

  it("a read failure reports a closed category and no provider text", async () => {
    process.env.STRIPE_PRO_PRICE_ID_EUR = "price_x";
    try {
      const findings = await evaluateBillingOffers({
        fetchStripePrice: async () => {
          throw Object.assign(new Error("Stripe says: secret stuff"), { status: 403 });
        },
      });
      const row = findings.find((f) => f.id === "price_x");
      expect(row).toMatchObject({ verdict: "UNREADABLE", detail: ["http_403"] });
      expect(JSON.stringify(findings)).not.toContain("secret stuff");
      expect(offersNeedingAttention(findings).length).toBeGreaterThan(0);
    } finally {
      delete process.env.STRIPE_PRO_PRICE_ID_EUR;
    }
  });
});

describe("AUD-14a Stripe object shapes", () => {
  it("reads the period end from an item or from the older top level", () => {
    expect(stripeSubscriptionPeriodEnd({ id: "s", items: { data: [{ current_period_end: 100 }] } })?.getTime()).toBe(100000);
    expect(stripeSubscriptionPeriodEnd({ id: "s", current_period_end: 200 })?.getTime()).toBe(200000);
    expect(stripeSubscriptionPeriodEnd({ id: "s" })).toBeNull();
  });
  it("a schedule may be an id or an expanded object; cancel_at counts as ending", () => {
    expect(stripeSubscriptionScheduleId({ id: "s", schedule: "sub_sched_1" })).toBe("sub_sched_1");
    expect(stripeSubscriptionScheduleId({ id: "s", schedule: { id: "sub_sched_2" } })).toBe("sub_sched_2");
    expect(stripeSubscriptionEnding({ id: "s", cancel_at: 5 })).toBe(true);
    expect(stripeSubscriptionEnding({ id: "s", cancel_at_period_end: false, cancel_at: null })).toBe(false);
  });
  it("reads invoice subscription metadata from either shape", () => {
    expect(stripeInvoiceSubscriptionMetadata({ parent: { subscription_details: { metadata: { userId: "a" } } } })).toEqual({ userId: "a" });
    expect(stripeInvoiceSubscriptionMetadata({ subscription_details: { metadata: { userId: "b" } } })).toEqual({ userId: "b" });
    expect(stripeInvoiceSubscriptionMetadata({})).toEqual({});
  });
});

describe("AUD-02 status and tie rules", () => {
  it("incomplete is pending; only a true ending cancels; an unknown word decides nothing", () => {
    expect(parseStripeSubscriptionStatus("incomplete")).toBe("TRIALING");
    expect(parseStripeSubscriptionStatus("incomplete_expired")).toBe("CANCELED");
    expect(parseStripeSubscriptionStatus("canceled")).toBe("CANCELED");
    expect(parseStripeSubscriptionStatus("something_new")).toBeNull();
    expect(parseStripeSubscriptionStatus(null)).toBeNull();
  });
  const at = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-02-01T00:00:00Z");
  it("a tie lets a pending row move on, and nothing else", () => {
    expect(decideSubscriptionStatusWrite({ current: "TRIALING", currentObservedAtUtc: at, next: "ACTIVE", observedAtUtc: at, now }).apply).toBe(true);
    expect(decideSubscriptionStatusWrite({ current: "ACTIVE", currentObservedAtUtc: at, next: "CANCELED", observedAtUtc: at, now }).apply).toBe(false);
    expect(decideSubscriptionStatusWrite({ current: "CANCELED", currentObservedAtUtc: at, next: "ACTIVE", observedAtUtc: at, now }).apply).toBe(false);
  });
});

describe("AUD-06 payment transitions", () => {
  it("FAILED may become SUCCEEDED, not the other way, and an older success loses", () => {
    expect(decidePaymentTransition({ current: "FAILED", currentObservedAtUtc: null, observed: "SUCCEEDED", observedAtUtc: null }).apply).toBe(true);
    expect(decidePaymentTransition({ current: "SUCCEEDED", currentObservedAtUtc: null, observed: "FAILED", observedAtUtc: null }).apply).toBe(false);
    expect(
      decidePaymentTransition({
        current: "FAILED",
        currentObservedAtUtc: new Date(2000),
        observed: "SUCCEEDED",
        observedAtUtc: new Date(1000),
      }).apply,
    ).toBe(false);
  });
});

describe("AUD-01 plan from billed price", () => {
  it("maps a configured price, and leaves a grandfathered one to the caller", () => {
    process.env.STRIPE_TEAM_PRICE_ID_USD = "price_t";
    try {
      expect(planFromStripePriceId("price_t")).toBe("TEAM");
      expect(planFromStripePriceId("price_old")).toBeNull();
      expect(planFromStripePriceId(null)).toBeNull();
    } finally {
      delete process.env.STRIPE_TEAM_PRICE_ID_USD;
    }
  });
});

describe("AUD-15 no unproven 'nothing was charged'", () => {
  it("a missing setting makes no claim; a refusal proven to precede creation may", () => {
    expect(paymentsUnavailable("paypal", "PAYPAL_SECRET").publicMessage).not.toMatch(/nothing was charged/i);
    expect(paymentsUnavailable("stripe", "x", "plan_not_configured").publicMessage).toMatch(/nothing was charged/i);
  });
});
