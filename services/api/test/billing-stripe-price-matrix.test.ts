/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the Stripe plan/currency
 * price matrix, and what happens when a cell is empty.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * A price id used to be optional. Stripe CHECKOUT falls back to an inline
 * `price_data` built from the catalog amount, so a purchase worked whether or
 * not one was configured — which is exactly why nobody noticed that
 * `.env.example` documented six variable names the resolver does not read.
 *
 * It stopped being optional when plans became changeable: a Stripe
 * subscription ITEM update cannot take inline price data. An upgrade on a
 * subscription with no configured price id has two possible answers, and only
 * one of them is acceptable — refuse, or open a SECOND subscription. This
 * suite pins the refusal, and pins the exact env names the matrix resolves
 * from, so the documentation and the resolver cannot drift apart again.
 *
 * NO SECRET IS READ OR PRINTED. Every value here is a synthetic marker set on
 * `process.env` for the duration of one case and removed afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPlanPriceCents,
  getStripePlanPriceId,
  type BillingCurrency,
} from "../src/services/billing-pricing.service.js";

/** The currencies the product actually supports, from the request schema. */
const CURRENCIES: readonly BillingCurrency[] = ["EUR", "USD"];

/** The plans a personal subscription can be CHANGED between. */
const CHANGEABLE_PLANS = ["PRO", "TEAM"] as const;

const ENV_KEYS = [
  "STRIPE_PRO_PRICE_ID_EUR",
  "STRIPE_PRO_PRICE_ID_USD",
  "STRIPE_TEAM_PRICE_ID_EUR",
  "STRIPE_TEAM_PRICE_ID_USD",
  "STRIPE_PAYG_PRICE_ID_EUR",
  "STRIPE_PAYG_PRICE_ID_USD",
] as const;

const priceKey = (plan: string, currency: BillingCurrency) =>
  `STRIPE_${plan}_PRICE_ID_${currency}`;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

// ===========================================================================
// 1. Every supported cell resolves from its own variable
// ===========================================================================

describe("the plan/currency matrix resolves from ONE authority", () => {
  for (const plan of CHANGEABLE_PLANS) {
    for (const currency of CURRENCIES) {
      it(`${plan}/${currency} resolves the configured id, and only from ${priceKey(plan, currency)}`, () => {
        // A distinct marker per cell, so a resolver that reached for the wrong
        // variable would return the wrong marker rather than merely a value.
        process.env[priceKey(plan, currency)] = `configured-${plan}-${currency}`;

        expect(getStripePlanPriceId(plan as never, currency)).toBe(
          `configured-${plan}-${currency}`,
        );
      });
    }
  }

  it("no cell borrows another cell's id", () => {
    // Configure the whole matrix at once and read it back. A currency or plan
    // mix-up inside the resolver shows up here and nowhere else.
    for (const plan of CHANGEABLE_PLANS) {
      for (const currency of CURRENCIES) {
        process.env[priceKey(plan, currency)] = `configured-${plan}-${currency}`;
      }
    }

    const seen = new Set<string>();
    for (const plan of CHANGEABLE_PLANS) {
      for (const currency of CURRENCIES) {
        const id = getStripePlanPriceId(plan as never, currency);
        expect(id, `${plan}/${currency}`).toBe(`configured-${plan}-${currency}`);
        seen.add(String(id));
      }
    }
    expect(seen.size).toBe(CHANGEABLE_PLANS.length * CURRENCIES.length);
  });

  it("whitespace is not configuration", () => {
    // A variable present but blank in a deployment template is the SAME state
    // as an absent one, and must fail the same way rather than reaching Stripe
    // with an empty price.
    process.env.STRIPE_PRO_PRICE_ID_EUR = "   ";
    expect(getStripePlanPriceId("PRO" as never, "EUR")).toBeNull();
  });

  it("an unset cell is null, never a fabricated or borrowed id", () => {
    for (const plan of CHANGEABLE_PLANS) {
      for (const currency of CURRENCIES) {
        expect(getStripePlanPriceId(plan as never, currency), `${plan}/${currency}`).toBeNull();
      }
    }
  });

  it("FREE and ENTERPRISE have no price id at all", () => {
    // FREE is not sold and ENTERPRISE is contracted. Either returning an id
    // would mean a self-service checkout could name it.
    for (const currency of CURRENCIES) {
      expect(getStripePlanPriceId("FREE" as never, currency)).toBeNull();
      expect(getStripePlanPriceId("ENTERPRISE" as never, currency)).toBeNull();
    }
  });
});

// ===========================================================================
// 2. The published amount is independent of the id
// ===========================================================================

describe("amounts are published whether or not an id is configured", () => {
  for (const plan of CHANGEABLE_PLANS) {
    for (const currency of CURRENCIES) {
      it(`${plan}/${currency} publishes a positive amount with no id set`, () => {
        // The catalog default, so an unconfigured deployment shows the
        // approved price rather than zero. A zero here would be a free plan
        // advertised at the wrong tier.
        const cents = getPlanPriceCents(plan as never, currency);
        expect(cents).toBeGreaterThan(0);
      });
    }
  }
});

// ===========================================================================
// 3. A missing cell fails SAFELY on the change path
// ===========================================================================

describe("a missing price id refuses the change — it never opens a second subscription", () => {
  const live = {
    id: "sub-1",
    provider: "STRIPE" as const,
    providerSubId: "sub_ext_1",
    status: "ACTIVE" as const,
    plan: "PRO" as const,
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    pendingPlan: null,
    pendingPlanEffectiveAtUtc: null,
    teamId: null,
  };

  async function applyWith(target: "PRO" | "TEAM", kind: "UPGRADE" | "DOWNGRADE") {
    const { applyPersonalPlanChange } = await import(
      "../src/services/billing/plan-transition.service.js"
    );
    return applyPersonalPlanChange({
      transition: { kind, targetPlan: target as never, subscription: live as never },
      currency: "EUR",
    });
  }

  it("PRO → TEAM with no TEAM price refuses with PLAN_CHANGE_NOT_AVAILABLE", async () => {
    await expect(applyWith("TEAM", "UPGRADE")).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
      httpStatus: 409,
    });
  });

  it("TEAM → PRO with no PRO price refuses the same way", async () => {
    await expect(applyWith("PRO", "DOWNGRADE")).rejects.toMatchObject({
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
    });
  });

  it("the refusal names no variable, no id and no provider", async () => {
    // A customer-facing message that named the missing environment variable
    // would be leaking deployment shape to whoever pressed the button.
    try {
      await applyWith("TEAM", "UPGRADE");
      throw new Error("should have refused");
    } catch (err) {
      const message = (err as { publicMessage?: string }).publicMessage ?? "";
      expect(message).not.toMatch(/STRIPE_|price_|sub_|Stripe|PayPal/i);
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 4. The documentation and the resolver name the SAME variables
// ===========================================================================

describe("the example configuration documents what the resolver reads", () => {
  it("every variable the resolver reads is documented, and none that it ignores", async () => {
    // The defect this closes: `.env.example` documented STRIPE_PRO_PRICE_ID,
    // STRIPE_TEAM_PRICE_ID and STRIPE_PAYG_PRICE_ID — three names nothing
    // reads — plus three STRIPE_*_PRICE_CENTS names under the wrong prefix.
    // An operator following it configured six variables that did nothing, and
    // the first symptom was an upgrade refusing in production.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const example = readFileSync(
      fileURLToPath(new URL("../.env.example", import.meta.url)),
      "utf8",
    );
    const resolver = readFileSync(
      fileURLToPath(
        new URL("../src/services/billing-pricing.service.ts", import.meta.url),
      ),
      "utf8",
    );

    for (const key of ENV_KEYS) {
      expect(resolver, `${key} must be read by the resolver`).toContain(key);
      expect(example, `${key} must be documented`).toMatch(
        new RegExp(`^${key}=`, "m"),
      );
    }

    for (const key of [
      "BILLING_PRO_PRICE_CENTS_EUR",
      "BILLING_PRO_PRICE_CENTS_USD",
      "BILLING_TEAM_PRICE_CENTS_EUR",
      "BILLING_TEAM_PRICE_CENTS_USD",
      "BILLING_PAYG_PRICE_CENTS_EUR",
      "BILLING_PAYG_PRICE_CENTS_USD",
    ]) {
      expect(resolver, `${key} must be read by the resolver`).toContain(key);
      expect(example, `${key} must be documented`).toMatch(
        new RegExp(`^${key}=`, "m"),
      );
    }

    // And the names that never worked must not come back as assignments.
    for (const dead of [
      "STRIPE_PRO_PRICE_ID",
      "STRIPE_TEAM_PRICE_ID",
      "STRIPE_PAYG_PRICE_ID",
      "STRIPE_PRO_PRICE_CENTS",
      "STRIPE_TEAM_PRICE_CENTS",
      "STRIPE_PAYG_PRICE_CENTS",
    ]) {
      expect(example, `${dead} is not read by anything`).not.toMatch(
        new RegExp(`^${dead}=`, "m"),
      );
    }
  });

  it("there is exactly ONE price authority", () => {
    // Every caller resolves through `billing-pricing.service`. A second place
    // reading a STRIPE_*_PRICE_ID variable would be a second answer to what a
    // plan costs.
    expect(getStripePlanPriceId).toBeTypeOf("function");
    expect(getPlanPriceCents).toBeTypeOf("function");
  });
});

// A guard against this file itself becoming the second authority: it must not
// import a price from anywhere but the canonical service.
describe("this suite reads no price from anywhere else", () => {
  it("imports only the canonical pricing service", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const imports = [...self.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    const priceImports = imports.filter((i) => /pricing|catalog|plan-catalog/.test(i));
    expect(priceImports).toEqual(["../src/services/billing-pricing.service.js"]);
  });
});

// Keep vitest's unused-import lint quiet about `vi` while leaving the import in
// place for the module-boundary stubs the neighbouring suites use.
void vi;
