/**
 * THE COMMERCIAL OFFER — one authority for what a self-service product costs
 * and what Stripe will charge for it (members audit ENT-08).
 *
 * The price a person is shown and the price Stripe charged came from two
 * places: the Pricing page and the Billing screen render the catalog amount
 * (`getPlanPriceCents` and friends), while Stripe checkout handed over a
 * configured price id and let Stripe decide — and with no id configured it
 * silently charged an ad-hoc inline `price_data`. Nothing compared the two,
 * so a misconfigured id could display €19 and charge $29, a monthly price
 * could be wired to a one-time one, or PRO and TEAM could share one price.
 *
 * PayPal already had this discipline (`assertPayPalPlanIsActive`: the plan is
 * read back and must bill the catalogue amount, currency and monthly interval,
 * refused as PAYMENTS_UNAVAILABLE before anything is created). Stripe now has
 * the same, with the same refusal:
 *
 *   - no configured price                 → PAYMENTS_UNAVAILABLE (plan_not_configured)
 *   - two products mapped to one price    → PAYMENTS_UNAVAILABLE (plan_price_mismatch)
 *   - the Price disagrees on active,
 *     currency, amount or interval, or
 *     (where the offer's Stripe Product is
 *     configured) on its product          → PAYMENTS_UNAVAILABLE (plan_price_mismatch)
 *
 * The Product id is OPTIONAL configuration (STRIPE_<…>_PRODUCT_ID). Owner
 * decision ENT-08 leaves exactly one thing pending: the live Stripe
 * configuration, confirmed by the read-only operator command
 * (scripts/verify-stripe-offers.ts), which reports a missing Product id as
 * NOT_CONFIGURED. Making it mandatory would refuse every checkout on a deploy
 * that predates the setting, so it is enforced only when configured.
 *   - Stripe cannot be asked              → PAYMENTS_UNAVAILABLE (provider_unreachable_before_create)
 *
 * The refusal precedes the checkout/session call, so nothing was created or
 * charged. The amounts are the numbers the display reads, from the same
 * functions, so display and charge cannot drift apart unnoticed. A verified
 * price is cached for ten minutes per process.
 */
import * as prismaPkg from "@prisma/client";

import {
  getPlanPriceCents,
  getStorageAddonPriceCents,
  getStripePlanPriceId,
  getStripeStorageAddonPriceId,
  type BillingCurrency,
} from "../billing-pricing.service.js";
import { stripeGet } from "../stripe.service.js";
import { paymentsUnavailable } from "./payments-unavailable.js";

export type SelfServiceProduct =
  | { kind: "PLAN"; plan: typeof prismaPkg.PlanType.PRO | typeof prismaPkg.PlanType.TEAM }
  | { kind: "EVIDENCE_CREDIT" }
  | { kind: "STORAGE_ADDON"; addonKey: prismaPkg.StorageAddonKey };

export type OfferInterval = "MONTH" | "ONE_TIME";

export type CommercialOffer = {
  product: SelfServiceProduct;
  currency: BillingCurrency;
  amountCents: number;
  interval: OfferInterval;
  /** The configured Stripe price, or null when none is configured. */
  stripePriceId: string | null;
  /**
   * The configured Stripe PRODUCT this offer is sold under, or null when none
   * is configured (second re-audit ENT-08 note). A Stripe Price belongs to one
   * Product; a price id pointing at a price of ANOTHER product (TEAM's price
   * id wired to a PRO-product price, a storage price under the credit product)
   * is a mismatch even when amount, currency and interval happen to agree.
   * Currency-agnostic: one Stripe Product carries every currency's Price.
   */
  stripeProductId: string | null;
};

/**
 * The configured Stripe Product id for a self-service product:
 * STRIPE_PRO_PRODUCT_ID, STRIPE_TEAM_PRODUCT_ID, STRIPE_PAYG_PRODUCT_ID (the
 * evidence credit, beside STRIPE_PAYG_PRICE_ID_*), STRIPE_STORAGE_<KEY>_PRODUCT_ID.
 */
export function getStripeProductId(product: SelfServiceProduct): string | null {
  const envKey =
    product.kind === "PLAN"
      ? `STRIPE_${product.plan}_PRODUCT_ID`
      : product.kind === "EVIDENCE_CREDIT"
        ? "STRIPE_PAYG_PRODUCT_ID"
        : `STRIPE_STORAGE_${product.addonKey}_PRODUCT_ID`;
  return process.env[envKey]?.trim() || null;
}

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
        stripeProductId: getStripeProductId(product),
      };
    case "EVIDENCE_CREDIT":
      return {
        product,
        currency,
        amountCents: getPlanPriceCents(prismaPkg.PlanType.PAYG, currency),
        interval: "ONE_TIME",
        stripePriceId: getStripePlanPriceId(prismaPkg.PlanType.PAYG, currency),
        stripeProductId: getStripeProductId(product),
      };
    case "STORAGE_ADDON":
      // Storage add-ons are sold as recurring monthly subscriptions only.
      return {
        product,
        currency,
        amountCents: getStorageAddonPriceCents({ addonKey: product.addonKey, currency }),
        interval: "MONTH",
        stripePriceId: getStripeStorageAddonPriceId({
          addonKey: product.addonKey,
          billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
          currency,
        }),
        stripeProductId: getStripeProductId(product),
      };
  }
}

/** The product a plan checkout sells — refused for anything not self-service. */
export function selfServiceProductForPlan(plan: prismaPkg.PlanType): SelfServiceProduct {
  if (plan === prismaPkg.PlanType.PRO || plan === prismaPkg.PlanType.TEAM) return { kind: "PLAN", plan };
  if (plan === prismaPkg.PlanType.PAYG) return { kind: "EVIDENCE_CREDIT" };
  throw paymentsUnavailable("stripe", `self-service checkout for ${plan}`, "plan_not_configured");
}

/** Every self-service offer in one currency — the mapping's whole domain. */
export function allSelfServiceOffers(currency: BillingCurrency): CommercialOffer[] {
  const products: SelfServiceProduct[] = [
    { kind: "PLAN", plan: prismaPkg.PlanType.PRO },
    { kind: "PLAN", plan: prismaPkg.PlanType.TEAM },
    { kind: "EVIDENCE_CREDIT" },
    ...Object.values(prismaPkg.StorageAddonKey).map((addonKey) => ({ kind: "STORAGE_ADDON" as const, addonKey })),
  ];
  return products.map((p) => resolveCommercialOffer(p, currency));
}

export function describeOffer(offer: CommercialOffer): string {
  const p = offer.product;
  const name = p.kind === "PLAN" ? p.plan : p.kind === "EVIDENCE_CREDIT" ? "EVIDENCE_CREDIT" : `STORAGE_${p.addonKey}`;
  return `${name}/${offer.currency}/${offer.interval}`;
}

// ---------------------------------------------------------------------------
// Stripe read-back
// ---------------------------------------------------------------------------

const VERIFIED_TTL_MS = 10 * 60 * 1000;
const verified = new Map<string, number>();

/** Test seam: the cache is process-local. */
export function __clearVerifiedOffersForTests(): void {
  verified.clear();
}

/** The fields of a Stripe Price this compares. */
export type StripePriceFacts = {
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  type?: string;
  recurring?: { interval?: string; interval_count?: number } | null;
  /** The Product the Price belongs to: an id, or the expanded object. */
  product?: string | { id?: string } | null;
};

function stripePriceProductId(price: StripePriceFacts): string | null {
  const p = price.product;
  if (typeof p === "string") return p.trim() || null;
  if (p && typeof p === "object" && typeof p.id === "string") return p.id.trim() || null;
  return null;
}

export function compareStripePrice(price: StripePriceFacts, offer: CommercialOffer): string[] {
  const out: string[] = [];
  if (price.active !== true) out.push("active");
  // A Price of another Product is not this offer, whatever its amount says
  // (checked wherever the offer's Product is configured).
  if (offer.stripeProductId && stripePriceProductId(price) !== offer.stripeProductId) out.push("product");
  if (String(price.currency ?? "").toUpperCase() !== offer.currency) out.push("currency");
  if (price.unit_amount !== offer.amountCents) out.push("amount");
  if (offer.interval === "MONTH") {
    if (price.type !== "recurring" || price.recurring?.interval !== "month" || (price.recurring.interval_count ?? 1) !== 1) {
      out.push("interval");
    }
  } else if (price.type !== "one_time" || price.recurring) {
    out.push("interval");
  }
  return out;
}

async function fetchStripePrice(priceId: string): Promise<StripePriceFacts> {
  return (await stripeGet(`/prices/${encodeURIComponent(priceId)}`)) as StripePriceFacts;
}

/**
 * The Stripe price this offer will be charged with — refused unless it is
 * configured, used by no other self-service product, and Stripe's Price
 * agrees with the offer.
 */
export async function requireVerifiedStripePrice(
  offer: CommercialOffer,
  fetchPrice: (priceId: string) => Promise<StripePriceFacts> = fetchStripePrice,
): Promise<string> {
  const describe = describeOffer(offer);
  const priceId = offer.stripePriceId;
  if (!priceId) throw paymentsUnavailable("stripe", `Stripe price for ${describe}`, "plan_not_configured");
  const sharedWith = allSelfServiceOffers(offer.currency).filter(
    (o) => o.stripePriceId === priceId && describeOffer(o) !== describe,
  );
  if (sharedWith.length > 0) {
    throw paymentsUnavailable(
      "stripe",
      `Stripe price for ${describe} is also mapped to ${sharedWith.map(describeOffer).join(", ")}`,
      "plan_price_mismatch",
    );
  }
  const key = `${priceId}:${offer.stripeProductId}:${offer.currency}:${offer.amountCents}:${offer.interval}`;
  const at = verified.get(key);
  if (at && Date.now() - at < VERIFIED_TTL_MS) return priceId;
  let price: StripePriceFacts;
  try {
    price = await fetchPrice(priceId);
  } catch (err) {
    // A configured id Stripe does not know is a configuration fault, not an
    // outage: nothing to retry until the mapping is fixed.
    if ((err as { status?: number } | null)?.status === 404) {
      throw paymentsUnavailable("stripe", `Stripe price for ${describe} does not exist`, "plan_not_configured");
    }
    throw paymentsUnavailable("stripe", `Stripe price lookup for ${describe}`, "provider_unreachable_before_create");
  }
  const mismatched = compareStripePrice(price, offer);
  if (mismatched.length > 0) {
    throw paymentsUnavailable(
      "stripe",
      `Stripe price for ${describe} (disagrees on ${mismatched.join(", ")}; expected ${offer.amountCents} ${offer.currency})`,
      "plan_price_mismatch",
    );
  }
  verified.set(key, Date.now());
  return priceId;
}
