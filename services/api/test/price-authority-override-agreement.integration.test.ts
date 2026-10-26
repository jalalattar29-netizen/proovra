/**
 * DEFECT 13 (members re-audit, owner decision 4) — an override moves EVERY
 * surface together, against live PostgreSQL.
 *
 * The per-currency `BILLING_*_PRICE_CENTS_<CURRENCY>` override is the
 * documented published amount (services/api/.env.example). It is only safe if
 * nothing anywhere renders or charges a different number. This drives the
 * three consumers a customer meets with an override set in-test to values
 * that exist nowhere else:
 *
 *   - the public Pricing catalogue API      GET /v1/billing/pricing
 *   - the Billing projection                buildBillingAccountProjection
 *                                           (plan offers + credit wallet)
 *   - the checkout offer                    resolveCommercialOffer (what Stripe
 *                                           is verified against and charges)
 *
 * and asserts they agree to the cent, for both currencies.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

const OVERRIDE = {
  EUR: { PRO: 2111, TEAM: 8222, PAYG: 633 },
  USD: { PRO: 2444, TEAM: 9555, PAYG: 766 },
} as const;

describe("defect 13 — an env price override: Pricing API, Billing and checkout agree (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let deps: FixtureDeps;
  let project: typeof import(
    "../src/services/billing/billing-account-projection.service.js"
  )["buildBillingAccountProjection"];
  let resolveOffer: typeof import(
    "../src/services/billing/commercial-offer.service.js"
  )["resolveCommercialOffer"];
  const saved = new Map<string, string | undefined>();

  function setOverride(key: string, value: number) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = String(value);
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    const { prisma } = await import("../src/db.js");
    ({ buildBillingAccountProjection: project } = await import(
      "../src/services/billing/billing-account-projection.service.js"
    ));
    ({ resolveCommercialOffer: resolveOffer } = await import(
      "../src/services/billing/commercial-offer.service.js"
    ));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `price-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  for (const currency of ["EUR", "USD"] as const) {
    it(`${currency}: the Pricing API, the Billing projection and the checkout offer show and charge the same overridden price`, async () => {
      const want = OVERRIDE[currency];
      setOverride(`BILLING_PRO_PRICE_CENTS_${currency}`, want.PRO);
      setOverride(`BILLING_TEAM_PRICE_CENTS_${currency}`, want.TEAM);
      setOverride(`BILLING_PAYG_PRICE_CENTS_${currency}`, want.PAYG);

      // 1. The public Pricing catalogue, over HTTP.
      const res = await harness.app.inject({
        method: "GET",
        url: `/v1/billing/pricing?currency=${currency}`,
      });
      expect(res.statusCode).toBe(200);
      const catalogue = res.json() as {
        currency: string;
        pro: { monthlyPriceCents: number };
        team: { monthlyPriceCents: number };
        payg: { unitPriceCents: number };
      };
      expect(catalogue.currency).toBe(currency);

      // 2. The Billing projection a FREE owner (holding one credit) reads.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
      const projection = await project({
        account: {
          type: "PERSONAL",
          id: t.owner.userId,
          displayName: "Personal",
          capabilities: [
            "BILLING_VIEW",
            "BILLING_MANAGE",
            "BILLING_CANCEL",
            "BILLING_AMOUNT_VIEW",
            "BILLING_ADDON_PURCHASE",
          ] as never,
          billingOwnerMissing: false,
        } as never,
        viewerUserId: t.owner.userId,
        requestedCurrency: currency,
      });
      const offer = (k: "PRO" | "TEAM") =>
        (projection.planOffers ?? []).find((o) => o.planKey === k);

      // 3. The checkout offer — the amount Stripe/PayPal are verified against.
      const checkoutPro = resolveOffer({ kind: "PLAN", plan: "PRO" }, currency);
      const checkoutTeam = resolveOffer({ kind: "PLAN", plan: "TEAM" }, currency);
      const checkoutCredit = resolveOffer({ kind: "EVIDENCE_CREDIT" }, currency);

      // PRO
      expect(catalogue.pro.monthlyPriceCents).toBe(want.PRO);
      expect(offer("PRO")?.priceCents).toBe(want.PRO);
      expect(offer("PRO")?.currency).toBe(currency);
      expect(checkoutPro.amountCents).toBe(want.PRO);
      // TEAM
      expect(catalogue.team.monthlyPriceCents).toBe(want.TEAM);
      expect(offer("TEAM")?.priceCents).toBe(want.TEAM);
      expect(checkoutTeam.amountCents).toBe(want.TEAM);
      // Evidence credit
      expect(catalogue.payg.unitPriceCents).toBe(want.PAYG);
      expect(projection.wallet?.unitPriceCents).toBe(want.PAYG);
      expect(checkoutCredit.amountCents).toBe(want.PAYG);
    });
  }
});
