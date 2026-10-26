/**
 * ENT-08 — ONE COMMERCIAL AUTHORITY (owner decision 2026-10-25).
 *
 * Pricing display, plan catalog, checkout resolution and the provider mapping
 * must agree on currency, amount, interval, product and plan, or the checkout
 * is refused — typed, before anything is created. This suite drives the real
 * Stripe checkout functions for EVERY self-service product and interval, with
 * a fake Stripe transport (global fetch) that answers the price read-back and
 * records the session create. No secret is read: every price id and key is a
 * synthetic marker set on process.env for one case.
 *
 * PayPal already reads its plan back before create (`assertPayPalPlanIsActive`
 * — amount, currency, monthly interval, no trial, no setup fee) and has its
 * own suite; this one closes the Stripe side, which had none.
 */
import * as prismaPkg from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStripeCheckoutSession,
  createStripeStorageAddonCheckoutSession,
} from "../src/services/billing-checkout.service.js";
import {
  __clearVerifiedOffersForTests,
  allSelfServiceOffers,
  compareStripePrice,
  describeOffer,
  type CommercialOffer,
} from "../src/services/billing/commercial-offer.service.js";
import {
  buildPricingCatalogResponse,
  getStorageAddonCurrency,
  type BillingCurrency,
} from "../src/services/billing-pricing.service.js";
import { listStorageAddonDefinitions } from "../src/services/billing.service.js";

const CURRENCIES: readonly BillingCurrency[] = ["EUR", "USD"];
const STRIPE = "https://api.stripe.com/v1";

type StripePrice = {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: "recurring" | "one_time";
  recurring: { interval: string; interval_count: number } | null;
  product: string;
};

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Every price-id variable the resolver reads, cleared for each case. */
function priceEnvKeys(): string[] {
  const keys: string[] = [];
  for (const c of CURRENCIES) {
    keys.push(`STRIPE_PRO_PRICE_ID_${c}`, `STRIPE_TEAM_PRICE_ID_${c}`, `STRIPE_PAYG_PRICE_ID_${c}`);
    for (const a of Object.values(prismaPkg.StorageAddonKey)) keys.push(`STRIPE_STORAGE_${a}_MONTHLY_${c}_PRICE_ID`);
  }
  keys.push("STRIPE_PRO_PRODUCT_ID", "STRIPE_TEAM_PRODUCT_ID", "STRIPE_PAYG_PRODUCT_ID");
  for (const a of Object.values(prismaPkg.StorageAddonKey)) keys.push(`STRIPE_STORAGE_${a}_PRODUCT_ID`);
  return keys;
}

let prices: Map<string, StripePrice>;
let posts: Array<{ url: string; form: URLSearchParams }>;
let gets: string[];
let priceReadFails: boolean;

beforeEach(() => {
  __clearVerifiedOffersForTests();
  setEnv("STRIPE_SECRET_KEY", "sk_test_synthetic_marker");
  for (const k of priceEnvKeys()) setEnv(k, undefined);
  prices = new Map();
  posts = [];
  gets = [];
  priceReadFails = false;
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: URLSearchParams }) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith(`${STRIPE}/prices/`)) {
      gets.push(url);
      if (priceReadFails) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
      const id = decodeURIComponent(url.slice(`${STRIPE}/prices/`.length));
      const p = prices.get(id);
      return p
        ? new Response(JSON.stringify(p), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "No such price" } }), { status: 404 });
    }
    if (method === "POST" && url === `${STRIPE}/checkout/sessions`) {
      posts.push({ url, form: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify({ id: "cs_test_synthetic", url: "https://checkout.example/x" }), { status: 200 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

/** The env variable naming the Stripe Product an offer is sold under. */
function productEnvKey(offer: CommercialOffer): string {
  const p = offer.product;
  return p.kind === "PLAN"
    ? `STRIPE_${p.plan}_PRODUCT_ID`
    : p.kind === "EVIDENCE_CREDIT"
      ? "STRIPE_PAYG_PRODUCT_ID"
      : `STRIPE_STORAGE_${p.addonKey}_PRODUCT_ID`;
}

/** The synthetic Stripe Product id an offer is sold under. */
function productIdOf(offer: CommercialOffer): string {
  return `prod_${productEnvKey(offer).toLowerCase()}`;
}

/** Configure a Stripe price that agrees with the offer (then let a case break it). */
function configure(offer: CommercialOffer, envKey: string, patch: Partial<StripePrice> = {}): string {
  const id = `price_${describeOffer(offer).replace(/[^A-Za-z0-9]/g, "_")}`;
  setEnv(envKey, id);
  setEnv(productEnvKey(offer), productIdOf(offer));
  prices.set(id, {
    id,
    active: true,
    currency: offer.currency.toLowerCase(),
    unit_amount: offer.amountCents,
    type: offer.interval === "MONTH" ? "recurring" : "one_time",
    recurring: offer.interval === "MONTH" ? { interval: "month", interval_count: 1 } : null,
    product: productIdOf(offer),
    ...patch,
  });
  return id;
}

type Case = {
  label: string;
  offer: () => CommercialOffer;
  envKey: string;
  displayedCents: () => number;
  run: () => Promise<{ amountCents: number }>;
};

function cases(): Case[] {
  const out: Case[] = [];
  for (const currency of CURRENCIES) {
    const catalog = () => buildPricingCatalogResponse({ currency });
    const offers = () => allSelfServiceOffers(currency);
    for (const plan of ["PRO", "TEAM"] as const) {
      out.push({
        label: `${plan} monthly / ${currency}`,
        offer: () => offers().find((o) => o.product.kind === "PLAN" && o.product.plan === plan)!,
        envKey: `STRIPE_${plan}_PRICE_ID_${currency}`,
        displayedCents: () => (plan === "PRO" ? catalog().pro : catalog().team).monthlyPriceCents,
        run: () => createStripeCheckoutSession({ userId: "u-1", plan, currency, attemptId: "att-1" }),
      });
    }
    out.push({
      label: `evidence credit one-time / ${currency}`,
      offer: () => offers().find((o) => o.product.kind === "EVIDENCE_CREDIT")!,
      envKey: `STRIPE_PAYG_PRICE_ID_${currency}`,
      displayedCents: () => catalog().payg.unitPriceCents,
      run: () =>
        createStripeCheckoutSession({ userId: "u-1", plan: prismaPkg.PlanType.PAYG, currency, productKey: "EVIDENCE_CREDIT", attemptId: "att-1" }),
    });
  }
  for (const def of listStorageAddonDefinitions()) {
    const currency = getStorageAddonCurrency({ addonKey: def.key });
    out.push({
      label: `storage ${def.key} monthly / ${currency}`,
      offer: () => allSelfServiceOffers(currency).find((o) => o.product.kind === "STORAGE_ADDON" && o.product.addonKey === def.key)!,
      envKey: `STRIPE_STORAGE_${def.key}_MONTHLY_${currency}_PRICE_ID`,
      displayedCents: () => buildPricingCatalogResponse({ currency }).storageAddons.find((s) => s.key === def.key)!.priceCents,
      run: () =>
        createStripeStorageAddonCheckoutSession({
          userId: "u-1",
          addonKey: def.key,
          billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
          currency,
          workspacePlan: prismaPkg.PlanType.PRO,
          attemptId: "att-1",
        }),
    });
  }
  return out;
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    return err as { publicCode?: string; httpStatus?: number; metadata?: { reason?: string; provider?: string } };
  }
  throw new Error("expected the checkout to be refused");
}

describe("ENT-08 — every self-service Stripe product × interval", () => {
  it("the matrix covers every product the Pricing page sells", () => {
    const labels = cases().map((c) => c.label);
    expect(labels.filter((l) => l.startsWith("PRO "))).toHaveLength(2);
    expect(labels.filter((l) => l.startsWith("TEAM "))).toHaveLength(2);
    expect(labels.filter((l) => l.startsWith("evidence credit"))).toHaveLength(2);
    expect(labels.filter((l) => l.startsWith("storage "))).toHaveLength(listStorageAddonDefinitions().length);
  });

  for (const c of cases()) {
    describe(c.label, () => {
      it("charges the configured, verified price — the amount the Pricing page shows", async () => {
        const offer = c.offer();
        expect(offer.amountCents).toBe(c.displayedCents());
        const id = configure(offer, c.envKey);
        const out = await c.run();
        expect(posts).toHaveLength(1);
        const form = posts[0]!.form;
        expect(form.get("line_items[0][price]")).toBe(id);
        expect([...form.keys()].some((k) => k.includes("price_data"))).toBe(false);
        expect(form.get("metadata[amountCents]")).toBe(String(c.displayedCents()));
        expect(form.get("metadata[currency]")).toBe(offer.currency);
        expect(out.amountCents).toBe(c.displayedCents());
        expect(form.get("mode")).toBe(offer.interval === "MONTH" ? "subscription" : "payment");
      });

      it("no configured Stripe product: the product is not compared (optional setting); everything else still is", async () => {
        const offer = c.offer();
        const priceId = configure(offer, c.envKey, { product: "prod_some_other_product" });
        setEnv(productEnvKey(offer), undefined);
        // A Price of some other product is accepted while no Product is
        // configured — the operator check reports it NOT_CONFIGURED …
        await expect(c.run()).resolves.toBeTruthy();
        // … but the amount is still held to the catalogue (positive control).
        prices.set(priceId, { ...prices.get(priceId)!, unit_amount: 1 });
        __clearVerifiedOffersForTests();
        const err = await refusal(c.run);
        expect(err.metadata).toMatchObject({ provider: "stripe", reason: "plan_price_mismatch" });
      });

      it("no configured price: refused before Stripe is asked anything", async () => {
        const err = await refusal(c.run);
        expect(err.publicCode).toBe("PAYMENTS_UNAVAILABLE");
        expect(err.httpStatus).toBe(503);
        expect(err.metadata).toMatchObject({ provider: "stripe", reason: "plan_not_configured" });
        expect(gets).toEqual([]);
        expect(posts).toEqual([]);
      });

      for (const [what, patch] of [
        ["a different amount", (o: CommercialOffer) => ({ unit_amount: o.amountCents + 100 })],
        ["a different currency", (o: CommercialOffer) => ({ currency: o.currency === "EUR" ? "usd" : "eur" })],
        [
          "a different interval",
          (o: CommercialOffer) =>
            o.interval === "MONTH"
              ? { type: "recurring" as const, recurring: { interval: "year", interval_count: 1 } }
              : { type: "recurring" as const, recurring: { interval: "month", interval_count: 1 } },
        ],
        ["an archived price", () => ({ active: false })],
        // Second re-audit ENT-08 note: a Price under ANOTHER Stripe Product is a
        // mismatch even when amount, currency and interval agree.
        ["another product", () => ({ product: "prod_some_other_product" })],
      ] as const) {
        it(`a Stripe price with ${what} is refused — display and charge never disagree`, async () => {
          const offer = c.offer();
          configure(offer, c.envKey, patch(offer));
          const err = await refusal(c.run);
          expect(err.publicCode).toBe("PAYMENTS_UNAVAILABLE");
          expect(err.metadata).toMatchObject({ provider: "stripe", reason: "plan_price_mismatch" });
          expect(posts).toEqual([]);
        });
      }
    });
  }
});

describe("ENT-08 — the mapping as a whole", () => {
  it("one price mapped to two products is refused for both", async () => {
    const all = allSelfServiceOffers("EUR");
    const pro = all.find((o) => o.product.kind === "PLAN" && o.product.plan === "PRO")!;
    const id = configure(pro, "STRIPE_PRO_PRICE_ID_EUR");
    setEnv("STRIPE_TEAM_PRICE_ID_EUR", id);
    for (const plan of ["PRO", "TEAM"] as const) {
      const err = await refusal(() => createStripeCheckoutSession({ userId: "u-1", plan, currency: "EUR" }));
      expect(err.metadata).toMatchObject({ reason: "plan_price_mismatch" });
    }
    expect(posts).toEqual([]);
  });

  it("Stripe unreachable at read-back: refused as certain-not-created", async () => {
    const pro = allSelfServiceOffers("USD").find((o) => o.product.kind === "PLAN" && o.product.plan === "PRO")!;
    configure(pro, "STRIPE_PRO_PRICE_ID_USD");
    priceReadFails = true;
    const err = await refusal(() => createStripeCheckoutSession({ userId: "u-1", plan: "PRO", currency: "USD" }));
    expect(err.metadata).toMatchObject({ reason: "provider_unreachable_before_create" });
    expect(posts).toEqual([]);
  });

  it("a configured id Stripe does not know is a configuration fault, not an outage", async () => {
    setEnv("STRIPE_PRO_PRICE_ID_EUR", "price_that_was_deleted");
    setEnv("STRIPE_PRO_PRODUCT_ID", "prod_stripe_pro_product_id");
    const err = await refusal(() => createStripeCheckoutSession({ userId: "u-1", plan: "PRO", currency: "EUR" }));
    expect(err.metadata).toMatchObject({ reason: "plan_not_configured" });
    expect(posts).toEqual([]);
  });

  it("a plan that is not self-service has no checkout at all", async () => {
    for (const plan of [prismaPkg.PlanType.FREE, prismaPkg.PlanType.ENTERPRISE]) {
      const err = await refusal(() => createStripeCheckoutSession({ userId: "u-1", plan, currency: "EUR" }));
      expect(err.metadata).toMatchObject({ reason: "plan_not_configured" });
    }
    expect(gets).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("a verified price is read once per process window, then reused", async () => {
    const team = allSelfServiceOffers("EUR").find((o) => o.product.kind === "PLAN" && o.product.plan === "TEAM")!;
    configure(team, "STRIPE_TEAM_PRICE_ID_EUR");
    await createStripeCheckoutSession({ userId: "u-1", plan: "TEAM", currency: "EUR" });
    await createStripeCheckoutSession({ userId: "u-2", plan: "TEAM", currency: "EUR" });
    expect(gets).toHaveLength(1);
    expect(posts).toHaveLength(2);
  });
});

describe("ENT-08 — the Stripe Product is part of the offer (second re-audit)", () => {
  it("TEAM's price id pointing at a price of the PRO product is refused; the same price under TEAM's product is charged", async () => {
    const all = allSelfServiceOffers("EUR");
    const pro = all.find((o) => o.product.kind === "PLAN" && o.product.plan === "PRO")!;
    const team = all.find((o) => o.product.kind === "PLAN" && o.product.plan === "TEAM")!;
    configure(pro, "STRIPE_PRO_PRICE_ID_EUR");
    // TEAM's amount, currency and interval — but the Price lives under PRO's product.
    const teamId = configure(team, "STRIPE_TEAM_PRICE_ID_EUR", { product: productIdOf(pro) });

    const err = await refusal(() => createStripeCheckoutSession({ userId: "u-1", plan: "TEAM", currency: "EUR" }));
    expect(err.publicCode).toBe("PAYMENTS_UNAVAILABLE");
    expect(err.metadata).toMatchObject({ provider: "stripe", reason: "plan_price_mismatch" });
    expect(posts).toEqual([]);

    // Positive control: the same price, moved under TEAM's product, is charged.
    prices.set(teamId, { ...prices.get(teamId)!, product: productIdOf(team) });
    __clearVerifiedOffersForTests();
    await createStripeCheckoutSession({ userId: "u-1", plan: "TEAM", currency: "EUR" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form.get("line_items[0][price]")).toBe(teamId);
  });

  it("compareStripePrice reads the product as an id or as the expanded object", () => {
    const pro = allSelfServiceOffers("USD").find((o) => o.product.kind === "PLAN" && o.product.plan === "PRO")!;
    const offer: CommercialOffer = { ...pro, stripeProductId: "prod_pro" };
    const base = {
      active: true,
      currency: "usd",
      unit_amount: offer.amountCents,
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    };
    expect(compareStripePrice({ ...base, product: "prod_pro" }, offer)).toEqual([]);
    expect(compareStripePrice({ ...base, product: { id: "prod_pro" } }, offer)).toEqual([]);
    expect(compareStripePrice({ ...base, product: "prod_team" }, offer)).toEqual(["product"]);
    expect(compareStripePrice({ ...base, product: { id: "prod_team" } }, offer)).toEqual(["product"]);
    expect(compareStripePrice({ ...base }, offer)).toEqual(["product"]);
    // No configured Product: not compared.
    expect(compareStripePrice({ ...base, product: "prod_team" }, { ...offer, stripeProductId: null })).toEqual([]);
  });
});
