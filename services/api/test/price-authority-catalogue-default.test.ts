/**
 * DEFECT 13 (members re-audit, owner decision 4) — ONE PRICE AUTHORITY.
 *
 * `getPlanPriceCents` restated the catalogue's prices as its own fallback
 * literals (500 / 1900 / 7900), so the plan catalogue's `monthlyPriceCents`
 * and the number every surface displayed and every checkout charged were two
 * independent numbers that merely happened to match.
 *
 * This suite replaces the catalogue's prices with values that exist nowhere
 * else in the codebase. If the price authority still carried its own literals,
 * it would keep answering 1900 / 7900 / 500 and every assertion here fails.
 * With no env override set, the Pricing catalogue, the checkout offer and the
 * credit price must all be the CATALOGUE's numbers.
 */
import * as prismaPkg from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { CATALOGUE_PRO, CATALOGUE_TEAM, CATALOGUE_CREDIT } = vi.hoisted(() => ({
  CATALOGUE_PRO: 2347,
  CATALOGUE_TEAM: 8761,
  CATALOGUE_CREDIT: 613,
}));

vi.mock("@proovra/shared-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@proovra/shared-billing")>();
  return {
    ...actual,
    PLAN_CAPABILITIES: {
      ...actual.PLAN_CAPABILITIES,
      PRO: { ...actual.PLAN_CAPABILITIES.PRO, monthlyPriceCents: CATALOGUE_PRO },
      TEAM: { ...actual.PLAN_CAPABILITIES.TEAM, monthlyPriceCents: CATALOGUE_TEAM },
    },
    EVIDENCE_CREDIT_PRODUCT: {
      ...actual.EVIDENCE_CREDIT_PRODUCT,
      unitPriceCents: CATALOGUE_CREDIT,
    },
  };
});

import {
  buildPricingCatalogResponse,
  getEvidenceCreditPriceCents,
  getPlanPriceCents,
  type BillingCurrency,
} from "../src/services/billing-pricing.service.js";
import { resolveCommercialOffer } from "../src/services/billing/commercial-offer.service.js";

const OVERRIDES = [
  "BILLING_PRO_PRICE_CENTS_EUR",
  "BILLING_PRO_PRICE_CENTS_USD",
  "BILLING_TEAM_PRICE_CENTS_EUR",
  "BILLING_TEAM_PRICE_CENTS_USD",
  "BILLING_PAYG_PRICE_CENTS_EUR",
  "BILLING_PAYG_PRICE_CENTS_USD",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of OVERRIDES) {
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

describe("defect 13 — the price authority's default IS the plan catalogue", () => {
  for (const currency of ["USD", "EUR"] as BillingCurrency[]) {
    it(`${currency}: with no override, every surface publishes and charges the catalogue's numbers`, () => {
      expect(getPlanPriceCents(prismaPkg.PlanType.PRO, currency)).toBe(CATALOGUE_PRO);
      expect(getPlanPriceCents(prismaPkg.PlanType.TEAM, currency)).toBe(CATALOGUE_TEAM);
      expect(getEvidenceCreditPriceCents(currency)).toBe(CATALOGUE_CREDIT);

      const catalogue = buildPricingCatalogResponse({ currency });
      expect(catalogue.pro.monthlyPriceCents).toBe(CATALOGUE_PRO);
      expect(catalogue.team.monthlyPriceCents).toBe(CATALOGUE_TEAM);
      expect(catalogue.payg.unitPriceCents).toBe(CATALOGUE_CREDIT);
      expect(catalogue.free.monthlyPriceCents).toBe(0);

      expect(
        resolveCommercialOffer({ kind: "PLAN", plan: prismaPkg.PlanType.PRO }, currency).amountCents,
      ).toBe(CATALOGUE_PRO);
      expect(
        resolveCommercialOffer({ kind: "PLAN", plan: prismaPkg.PlanType.TEAM }, currency).amountCents,
      ).toBe(CATALOGUE_TEAM);
      expect(resolveCommercialOffer({ kind: "EVIDENCE_CREDIT" }, currency).amountCents).toBe(
        CATALOGUE_CREDIT,
      );
    });
  }

  it("FREE and ENTERPRISE publish no monthly price", () => {
    expect(getPlanPriceCents(prismaPkg.PlanType.FREE, "USD")).toBe(0);
    expect(getPlanPriceCents(prismaPkg.PlanType.ENTERPRISE, "EUR")).toBe(0);
  });

  it("an unparseable override falls back to the catalogue, never to a stale literal", () => {
    process.env.BILLING_PRO_PRICE_CENTS_USD = "not-a-number";
    expect(getPlanPriceCents(prismaPkg.PlanType.PRO, "USD")).toBe(CATALOGUE_PRO);
  });
});
