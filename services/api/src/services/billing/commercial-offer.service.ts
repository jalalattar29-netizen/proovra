/**
 * THE COMMERCIAL OFFER — one authority for what a self-service product costs
 * and what the payment provider will charge for it (members audit ENT-08).
 *
 * The price a person is shown and the price a provider charges came from two
 * places: the Pricing page and the Billing screen render the catalog amount
 * (`getPlanPriceCents` and friends), while checkout handed the provider a
 * configured price id and let the provider decide. Nothing compared the two,
 * so a misconfigured id could display €19 and charge $29, or a monthly price
 * could be wired to a yearly one; and a product with no configured id was
 * silently charged with an ad-hoc inline price.
 *
 * Now every self-service checkout and plan change resolves ONE offer
 * (product, plan, currency, amount, interval) from the catalog, and before it
 * reaches the provider:
 *
 *   - a missing provider mapping is refused: CHECKOUT_PRICE_NOT_CONFIGURED;
 *   - the provider's own object is read back and must agree on currency,
 *     amount, interval and that it is active: otherwise
 *     CHECKOUT_PRICE_MISMATCH, naming only which fields disagree;
 *   - a provider that cannot be asked: CHECKOUT_PRICE_UNVERIFIABLE (retry).
 *
 * The amounts are the same numbers the display reads, from the same
 * functions, so the display and the charge cannot drift apart unnoticed. A
 * verified mapping is cached for ten minutes per process.
 */
import * as prismaPkg from "@prisma/client";

import { DomainError } from "../../errors.js";
import {
  getPlanPriceCents,
  getStorageAddonPriceCents,
  getStripePlanPriceId,
  getStripeStorageAddonPriceId,
  type BillingCurrency,
} from "../billing-pricing.service.js";

export type SelfServiceProduct =
  | { kind: "PLAN"; plan: typeof prismaPkg.PlanType.PRO | typeof prismaPkg.PlanType.TEAM }
  | { kind: "EVIDENCE_CREDIT" }
  | {
      kind: "STORAGE_ADDON";
      addonKey: prismaPkg.StorageAddonKey;
      billingCycle: prismaPkg.StorageAddonBillingCycle;
    };

export type OfferInterval = "MONTH" | "ONE_TIME";

export type CommercialOffer = {
  product: SelfServiceProduct;
  currency: BillingCurrency;
  amountCents: number;
  interval: OfferInterval;
  /** The configured Stripe price, or null when none is configured. */
  stripePriceId: string | null;
};

export function resolveCommercialOffer(
  product: SelfServiceProduct,
  currency: BillingCurrency,
): CommercialOffer {
  switch (product.kind) {
    case "PLAN":
      return {
        product,
        currency,
        amountCents: getPlanPriceCents(product.plan, currency),
        interval: "MONTH",
        stripePriceId: getStripePlanPriceId(product.plan, currency),
      };
    case "EVIDENCE_CREDIT":
      return {
        product,
        currency,
        amountCents: getPlanPriceCents(prismaPkg.PlanType.PAYG, currency),
        interval: "ONE_TIME",
        stripePriceId: getStripePlanPriceId(prismaPkg.PlanType.PAYG, currency),
      };
    case "STORAGE_ADDON":
      return {
        product,
        currency,
        amountCents: getStorageAddonPriceCents({ addonKey: product.addonKey, currency }),
        interval: product.billingCycle === "MONTHLY" ? "MONTH" : "ONE_TIME",
        stripePriceId: getStripeStorageAddonPriceId({
          addonKey: product.addonKey,
          billingCycle: product.billingCycle,
          currency,
        }),
      };
  }
}

export function describeOffer(offer: CommercialOffer): string {
  const p = offer.product;
  const name =
    p.kind === "PLAN" ? p.plan : p.kind === "EVIDENCE_CREDIT" ? "EVIDENCE_CREDIT" : `STORAGE_${p.addonKey}_${p.billingCycle}`;
  return `${name}/${offer.currency}/${offer.interval}`;
}

export type OfferRefusalCode =
  | "CHECKOUT_PRICE_NOT_CONFIGURED"
  | "CHECKOUT_PRICE_MISMATCH"
  | "CHECKOUT_PRICE_UNVERIFIABLE";

export function offerRefusal(
  code: OfferRefusalCode,
  offer: CommercialOffer,
  provider: "stripe" | "paypal",
  mismatched: readonly string[] = [],
): DomainError {
  const describe = describeOffer(offer);
  if (code === "CHECKOUT_PRICE_NOT_CONFIGURED") {
    return new DomainError(`No ${provider} price configured for ${describe}`, {
      httpStatus: 409,
      publicCode: code,
      publicMessage:
        "This purchase is not available right now. Nothing was charged. Please try again later or contact support.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
      metadata: { provider, offer: describe },
    });
  }
  if (code === "CHECKOUT_PRICE_MISMATCH") {
    return new DomainError(`${provider} price for ${describe} disagrees on: ${mismatched.join(",")}`, {
      httpStatus: 409,
      publicCode: code,
      publicMessage:
        "This purchase is not available right now: the price we would charge does not match the price shown. Nothing was charged.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
      metadata: { provider, offer: describe, mismatched: mismatched.join(",") },
    });
  }
  return new DomainError(`${provider} price for ${describe} could not be checked`, {
    httpStatus: 503,
    publicCode: code,
    publicMessage: "We could not confirm the price with the payment provider. Nothing was charged — please try again.",
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
    metadata: { provider, offer: describe },
  });
}

// ---------------------------------------------------------------------------
// Provider read-back
// ---------------------------------------------------------------------------

const VERIFIED_TTL_MS = 10 * 60 * 1000;
const verified = new Map<string, number>();

/** Test seam: the cache is process-local. */
export function __clearVerifiedOffersForTests(): void {
  verified.clear();
}

function cacheKey(provider: string, id: string, offer: CommercialOffer): string {
  return `${provider}:${id}:${offer.currency}:${offer.amountCents}:${offer.interval}`;
}

/** The fields of a Stripe Price this compares. */
export type StripePriceFacts = {
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  type?: string;
  recurring?: { interval?: string; interval_count?: number } | null;
};

export function compareStripePrice(price: StripePriceFacts, offer: CommercialOffer): string[] {
  const out: string[] = [];
  if (price.active !== true) out.push("active");
  if (String(price.currency ?? "").toUpperCase() !== offer.currency) out.push("currency");
  if (price.unit_amount !== offer.amountCents) out.push("amount");
  if (offer.interval === "MONTH") {
    if (price.recurring?.interval !== "month" || (price.recurring.interval_count ?? 1) !== 1) out.push("interval");
  } else if (price.recurring) {
    out.push("interval");
  }
  return out;
}

/**
 * The Stripe price this offer will be charged with — refused unless it is
 * configured and the provider's Price agrees with the offer.
 */
export async function requireVerifiedStripePrice(
  offer: CommercialOffer,
  fetchPrice: (priceId: string) => Promise<StripePriceFacts>,
): Promise<string> {
  const priceId = offer.stripePriceId;
  if (!priceId) throw offerRefusal("CHECKOUT_PRICE_NOT_CONFIGURED", offer, "stripe");
  const key = cacheKey("stripe", priceId, offer);
  const at = verified.get(key);
  if (at && Date.now() - at < VERIFIED_TTL_MS) return priceId;
  let price: StripePriceFacts;
  try {
    price = await fetchPrice(priceId);
  } catch {
    throw offerRefusal("CHECKOUT_PRICE_UNVERIFIABLE", offer, "stripe");
  }
  const mismatched = compareStripePrice(price, offer);
  if (mismatched.length > 0) throw offerRefusal("CHECKOUT_PRICE_MISMATCH", offer, "stripe", mismatched);
  verified.set(key, Date.now());
  return priceId;
}

/** The fields of a PayPal billing plan this compares. */
export type PayPalPlanFacts = {
  status?: string;
  billing_cycles?: Array<{
    tenure_type?: string;
    frequency?: { interval_unit?: string; interval_count?: number };
    pricing_scheme?: { fixed_price?: { value?: string; currency_code?: string } };
  }>;
};

export function comparePayPalPlan(plan: PayPalPlanFacts, offer: CommercialOffer): string[] {
  const out: string[] = [];
  if (plan.status !== "ACTIVE") out.push("active");
  const regular = (plan.billing_cycles ?? []).find((c) => c.tenure_type === "REGULAR");
  const price = regular?.pricing_scheme?.fixed_price;
  if (String(price?.currency_code ?? "").toUpperCase() !== offer.currency) out.push("currency");
  const cents = price?.value !== undefined ? Math.round(Number(price.value) * 100) : NaN;
  if (cents !== offer.amountCents) out.push("amount");
  if (offer.interval !== "MONTH") out.push("interval");
  else if (regular?.frequency?.interval_unit !== "MONTH" || (regular.frequency.interval_count ?? 1) !== 1) out.push("interval");
  return out;
}

export async function requireVerifiedPayPalPlan(
  offer: CommercialOffer,
  planId: string,
  fetchPlan: (planId: string) => Promise<PayPalPlanFacts>,
): Promise<string> {
  const key = cacheKey("paypal", planId, offer);
  const at = verified.get(key);
  if (at && Date.now() - at < VERIFIED_TTL_MS) return planId;
  let plan: PayPalPlanFacts;
  try {
    plan = await fetchPlan(planId);
  } catch {
    throw offerRefusal("CHECKOUT_PRICE_UNVERIFIABLE", offer, "paypal");
  }
  const mismatched = comparePayPalPlan(plan, offer);
  if (mismatched.length > 0) throw offerRefusal("CHECKOUT_PRICE_MISMATCH", offer, "paypal", mismatched);
  verified.set(key, Date.now());
  return planId;
}
