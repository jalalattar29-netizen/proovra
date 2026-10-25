/**
 * READ-ONLY OPERATOR CHECK — do the configured Stripe Prices bill what the
 * catalogue shows? (members audit ENT-08)
 *
 *   pnpm --filter proovra-api exec tsx scripts/verify-stripe-offers.ts
 *
 * Run it in the environment whose configuration you want to check (it reads
 * that environment's STRIPE_SECRET_KEY and STRIPE_*_PRICE_ID variables). For
 * every self-service offer — PRO and TEAM monthly, the evidence credit, each
 * storage add-on, in USD and EUR — it resolves the catalogue amount through
 * the same commercial authority checkout uses, issues ONE `GET /v1/prices/<id>`
 * per configured price, and prints the verdict. It never creates, updates or
 * deletes anything, never touches the database, and never prints the secret
 * key or any value other than price ids, amounts, currencies and intervals.
 *
 * Exit code 0 when every offer is configured and agrees; 2 otherwise.
 */
import { stripeGet } from "../src/services/stripe.service.js";
import {
  allSelfServiceOffers,
  compareStripePrice,
  describeOffer,
  type StripePriceFacts,
} from "../src/services/billing/commercial-offer.service.js";

async function main(): Promise<number> {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    console.log("STRIPE_SECRET_KEY is not set in this environment — nothing to check.");
    return 2;
  }
  let problems = 0;
  const seen = new Map<string, string>();
  for (const currency of ["USD", "EUR"] as const) {
    for (const offer of allSelfServiceOffers(currency)) {
      const name = describeOffer(offer);
      if (!offer.stripePriceId) {
        console.log(`NOT_CONFIGURED  ${name}  expected ${offer.amountCents} ${offer.currency} ${offer.interval}`);
        problems += 1;
        continue;
      }
      const shared = seen.get(offer.stripePriceId);
      if (shared) {
        console.log(`SHARED_PRICE    ${name}  ${offer.stripePriceId} is also mapped to ${shared}`);
        problems += 1;
        continue;
      }
      seen.set(offer.stripePriceId, name);
      let price: StripePriceFacts;
      try {
        price = (await stripeGet(`/prices/${encodeURIComponent(offer.stripePriceId)}`)) as StripePriceFacts;
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        console.log(`UNREADABLE      ${name}  ${offer.stripePriceId}${status ? ` (HTTP ${status})` : ""}`);
        problems += 1;
        continue;
      }
      const mismatched = compareStripePrice(price, offer);
      if (mismatched.length > 0) {
        console.log(
          `MISMATCH        ${name}  ${offer.stripePriceId}  disagrees on ${mismatched.join(", ")}` +
            `  (stripe: ${price.unit_amount ?? "?"} ${String(price.currency ?? "?").toUpperCase()} ${price.recurring?.interval ?? price.type ?? "?"}, active=${price.active === true};` +
            ` catalogue: ${offer.amountCents} ${offer.currency} ${offer.interval})`,
        );
        problems += 1;
        continue;
      }
      console.log(`OK              ${name}  ${offer.stripePriceId}`);
    }
  }
  console.log(problems === 0 ? "\nAll self-service Stripe offers agree with the catalogue." : `\n${problems} offer(s) need attention.`);
  return problems === 0 ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("verify-stripe-offers failed:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
