/**
 * BILLING REMEDIATION (2026-10-30, AUD-21) — does this deployment's configuration
 * sell what the catalogue shows?
 *
 * The only check used to be the first customer's checkout. This walks every offer
 * in the currency it is actually sold in, resolves the EFFECTIVE amount through
 * the same functions checkout uses (cents overrides included), and asks each
 * provider ONE read per configured id.
 *
 * Read-only and bounded: GET only, one per id, no database, no customer. It
 * reports ids, amounts, currencies and intervals, and never a credential. A
 * provider's words are not reported; each failure is a closed verdict.
 */

import * as prismaPkg from "@prisma/client";

import { getStorageAddonCurrency, type BillingCurrency } from "../billing-pricing.service.js";
import {
  allSelfServiceOffers,
  compareStripePrice,
  describeOffer,
  type CommercialOffer,
  type StripePriceFacts,
} from "./commercial-offer.service.js";

export type OfferVerdict =
  | "OK"
  | "NOT_CONFIGURED"
  | "SHARED_PRICE"
  | "UNREADABLE"
  | "MISMATCH"
  | "PRODUCT_NOT_CONFIGURED";

export type OfferFinding = {
  provider: "STRIPE" | "PAYPAL";
  offer: string;
  verdict: OfferVerdict;
  /** The variable that holds this id, so a finding names its own repair. */
  variable: string;
  id: string | null;
  expected: { amountCents: number; currency: string; interval: string };
  /** Field names (Stripe) or a closed reason (PayPal). Never provider text. */
  detail: string[];
};

type PayPalPlanFacts = { status?: string };

export type OfferPreflightDeps = {
  fetchStripePrice: (priceId: string) => Promise<StripePriceFacts>;
  fetchPayPalPlan?: (planId: string) => Promise<PayPalPlanFacts>;
  payPalPlanMismatch?: (
    plan: PayPalPlanFacts,
    expected: { amountCents: number; currency: string },
  ) => string | null;
};

/** Storage sells in one currency, so a USD storage price is not a gap. */
function offersOnSale(): CommercialOffer[] {
  const sold = (o: CommercialOffer): boolean =>
    o.product.kind !== "STORAGE_ADDON" ||
    getStorageAddonCurrency({ addonKey: o.product.addonKey }) === o.currency;
  return (["USD", "EUR"] as BillingCurrency[]).flatMap((currency) => allSelfServiceOffers(currency).filter(sold));
}

function stripeVariable(offer: CommercialOffer): string {
  const p = offer.product;
  if (p.kind === "STORAGE_ADDON") return `STRIPE_STORAGE_${p.addonKey}_MONTHLY_${offer.currency}_PRICE_ID`;
  return `STRIPE_${p.kind === "PLAN" ? p.plan : "PAYG"}_PRICE_ID_${offer.currency}`;
}

function payPalVariable(offer: CommercialOffer): string | null {
  const p = offer.product;
  if (p.kind === "STORAGE_ADDON") return `PAYPAL_PLAN_STORAGE_${p.addonKey}_${offer.currency}`;
  // The credit is a PayPal ORDER at the server price: there is no plan to read.
  return p.kind === "PLAN" ? `PAYPAL_${p.plan}_PLAN_ID_${offer.currency}` : null;
}

export async function evaluateBillingOffers(deps: OfferPreflightDeps): Promise<OfferFinding[]> {
  const findings: OfferFinding[] = [];
  const seen = new Map<string, string>();

  for (const offer of offersOnSale()) {
    const name = describeOffer(offer);
    const expected = { amountCents: offer.amountCents, currency: offer.currency, interval: offer.interval };
    const variable = stripeVariable(offer);
    const report = (verdict: OfferVerdict, detail: string[] = []) =>
      findings.push({ provider: "STRIPE", offer: name, verdict, variable, id: offer.stripePriceId, expected, detail });

    if (!offer.stripePriceId) {
      report("NOT_CONFIGURED");
    } else if (seen.has(offer.stripePriceId)) {
      report("SHARED_PRICE", [seen.get(offer.stripePriceId)!]);
    } else {
      seen.set(offer.stripePriceId, name);
      let price: StripePriceFacts | null = null;
      try {
        price = await deps.fetchStripePrice(offer.stripePriceId);
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        report("UNREADABLE", status ? [`http_${status}`] : ["unreachable"]);
      }
      if (price) {
        const mismatched = compareStripePrice(price, offer);
        if (mismatched.length > 0) report("MISMATCH", mismatched);
        else if (!offer.stripeProductId) report("PRODUCT_NOT_CONFIGURED");
        else report("OK");
      }
    }

    const planVariable = payPalVariable(offer);
    if (!planVariable || !deps.fetchPayPalPlan) continue;
    const planId = process.env[planVariable]?.trim() || null;
    const reportPlan = (verdict: OfferVerdict, detail: string[] = []) =>
      findings.push({ provider: "PAYPAL", offer: name, verdict, variable: planVariable, id: planId, expected, detail });
    if (!planId) {
      reportPlan("NOT_CONFIGURED");
      continue;
    }
    try {
      const plan = await deps.fetchPayPalPlan(planId);
      const status = String(plan.status ?? "").toUpperCase();
      const mismatch = status === "ACTIVE" ? deps.payPalPlanMismatch?.(plan, expected) ?? null : "plan_not_active";
      if (mismatch) reportPlan("MISMATCH", [mismatch]);
      else reportPlan("OK");
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      reportPlan("UNREADABLE", status ? [`http_${status}`] : ["unreachable"]);
    }
  }
  return findings;
}

/** PRODUCT_NOT_CONFIGURED is advice: the price was verified on everything else. */
export function offersNeedingAttention(findings: OfferFinding[]): OfferFinding[] {
  return findings.filter((f) => f.verdict !== "OK" && f.verdict !== "PRODUCT_NOT_CONFIGURED");
}

export const ALL_STORAGE_ADDON_KEYS = Object.values(prismaPkg.StorageAddonKey);
