/**
 * READ-ONLY OPERATOR CHECK — do the configured Stripe prices and PayPal plans
 * bill what the catalogue shows?
 *
 * In `src/`, so it ships compiled in the API image (`tsx` does not):
 *
 *   docker exec <api container> node dist/scripts/verify-billing-offers.js
 *
 * It reads only that environment's configuration, makes one GET per configured
 * id, and writes nothing. Prints ids, amounts, currencies and intervals, never a
 * secret. Exit 0 when every offer on sale agrees, 2 otherwise.
 */
import "../env.js";

import { getSecret } from "../config/runtime-secrets.js";
import {
  evaluateBillingOffers,
  offersNeedingAttention,
} from "../services/billing/offer-preflight.service.js";
import type { StripePriceFacts } from "../services/billing/commercial-offer.service.js";
import { getPayPalPlan, payPalPlanPriceMismatch } from "../services/paypal.service.js";
import { stripeGet } from "../services/stripe.service.js";

async function main(): Promise<number> {
  if (!getSecret("STRIPE_SECRET_KEY")) {
    console.log("STRIPE_SECRET_KEY is not set in this environment: nothing to check.");
    return 2;
  }
  const findings = await evaluateBillingOffers({
    fetchStripePrice: async (priceId) =>
      (await stripeGet(`/prices/${encodeURIComponent(priceId)}`)) as StripePriceFacts,
    fetchPayPalPlan: process.env.PAYPAL_CLIENT_ID?.trim() ? getPayPalPlan : undefined,
    payPalPlanMismatch: (plan, expected) => payPalPlanPriceMismatch(plan, expected),
  });
  for (const f of findings) {
    const wants = `${f.expected.amountCents} ${f.expected.currency} ${f.expected.interval}`;
    console.log(
      [f.verdict.padEnd(22), f.provider.padEnd(6), f.offer, `expected ${wants}`, f.variable, f.id ?? "", f.detail.join(",")]
        .filter(Boolean)
        .join("  "),
    );
  }
  const problems = offersNeedingAttention(findings).length;
  console.log(problems === 0 ? "\nEvery offer on sale agrees with the catalogue." : `\n${problems} offer(s) need attention.`);
  return problems === 0 ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error("verify-billing-offers failed:", err instanceof Error ? err.name : "unknown");
    process.exit(2);
  },
);
