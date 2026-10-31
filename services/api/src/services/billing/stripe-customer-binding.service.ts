/**
 * BILLING DECISIONS (2026-10-31, D4) — one Stripe customer per billing owner.
 *
 * Every checkout used to leave the customer to Stripe, so one person gathered a
 * separate customer per purchase. This reuses one, and it is deliberately easier
 * to fall back than to attach the wrong one: without a `customer`, a checkout
 * simply behaves as it always has. So every doubt below answers null.
 *
 * WHAT A BINDING IS
 * ---------------------------------------------------------------------------
 * One row per (owner, provider, environment), written only after Stripe confirmed
 * the customer. A customer id is unique within an environment, so it cannot be
 * bound to two owners, and test and live never meet.
 *
 * WHICH CUSTOMER, WHEN THERE IS NO BINDING YET
 * ---------------------------------------------------------------------------
 * Old purchases each made their own customer, so several can exist. Stripe is
 * asked, because PROOVRA never stored them, and the first rule that applies wins:
 *
 *   1. a live Stripe base plan: its customer, when its metadata names this owner;
 *   2. no base plan, live Stripe add-ons on one customer: that customer;
 *   3. no base plan, live add-ons on several customers: no binding. Picking one
 *      would be arbitrary, so this checkout proceeds without a customer;
 *   4. nothing live: a new customer.
 *
 * Nothing merges customers, moves a subscription or touches an old one. Their
 * references stay where they are.
 *
 * WHEN A BINDING STOPS BEING GOOD
 * ---------------------------------------------------------------------------
 *   * Stripe says deleted or unknown: replaced with a new customer, keeping the
 *     old id on the row.
 *   * Stripe's record names another owner, or the other environment: the row
 *     becomes CONFLICT, a review item is raised and checkouts go without one until
 *     a person resolves it. It is never rebound automatically.
 *   * Stripe cannot be reached: this checkout goes without; the row is unchanged.
 *   * The customer is billed in another currency: Stripe refuses a second currency
 *     on one customer, so this checkout goes without; the row is unchanged.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { error as logError } from "../../utils/logger.js";
import { StripeHttpError, stripeGet, stripeRequest } from "../stripe.service.js";
import { findLivePersonalBaseSubscription } from "./base-subscription.service.js";
import { recordBillingReviewItem } from "./billing-review.service.js";
import { stripeKeyMode } from "./commercial-offer.service.js";
import { payerOwnedAddonWhere } from "./dependent-cancellation.service.js";

const STRIPE = prismaPkg.PaymentProvider.STRIPE;

/** Bounded: this runs in front of a checkout, once, for a customer with no binding. */
const MAX_ADDONS_READ = 10;

/** The Stripe calls used here. Tests pass synthetic ones. */
export type StripeCustomerDeps = {
  get: (path: string) => Promise<Record<string, unknown>>;
  post: (
    path: string,
    body: URLSearchParams,
    options?: { idempotencyKey?: string | null },
  ) => Promise<Record<string, unknown>>;
  environment: () => "live" | "test" | null;
};

const defaultDeps: StripeCustomerDeps = {
  get: stripeGet,
  post: stripeRequest,
  environment: stripeKeyMode,
};

type CustomerReading =
  | { kind: "OK"; currency: string | null }
  | { kind: "GONE" }
  | { kind: "MISMATCH" }
  | { kind: "UNKNOWN" };

async function readCustomer(
  customerId: string,
  owner: { userId: string; environment: "live" | "test" },
  deps: StripeCustomerDeps,
): Promise<CustomerReading> {
  let customer: Record<string, unknown>;
  try {
    customer = await deps.get(`/customers/${encodeURIComponent(customerId)}`);
  } catch (err) {
    return err instanceof StripeHttpError && err.status === 404 ? { kind: "GONE" } : { kind: "UNKNOWN" };
  }
  if (customer.deleted === true) return { kind: "GONE" };
  if (typeof customer.livemode === "boolean" && customer.livemode !== (owner.environment === "live")) {
    return { kind: "MISMATCH" };
  }
  // A customer PROOVRA created names its owner. One Checkout created names
  // nobody, which is why adoption goes through the subscription's metadata.
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.userId === "string" && metadata.userId !== owner.userId) return { kind: "MISMATCH" };
  return { kind: "OK", currency: typeof customer.currency === "string" ? customer.currency.toLowerCase() : null };
}

function customerIdOf(subscription: Record<string, unknown>): string | null {
  const customer = subscription.customer;
  if (typeof customer === "string") return customer;
  const expanded = (customer as { id?: unknown } | null)?.id;
  return typeof expanded === "string" ? expanded : null;
}

type Adoption =
  | { kind: "ADOPT"; customerId: string; source: "ADOPTED_BASE_PLAN" | "ADOPTED_STORAGE" }
  | { kind: "CREATE" }
  /** Several candidates, or a read that did not answer. Nothing is chosen. */
  | { kind: "UNDECIDED" };

async function adoptionFor(userId: string, deps: StripeCustomerDeps): Promise<Adoption> {
  const base = await findLivePersonalBaseSubscription(userId);
  try {
    if (base?.provider === STRIPE) {
      const subscription = await deps.get(`/subscriptions/${encodeURIComponent(base.providerSubId)}`);
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const customerId = customerIdOf(subscription);
      if (!customerId || metadata.userId !== userId) return { kind: "UNDECIDED" };
      return { kind: "ADOPT", customerId, source: "ADOPTED_BASE_PLAN" };
    }
    const addons = await prisma.workspaceStorageAddon.findMany({
      where: {
        ...payerOwnedAddonWhere(userId),
        paymentProvider: STRIPE,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        externalSubscriptionId: { not: null },
        status: {
          in: [prismaPkg.WorkspaceStorageAddonStatus.ACTIVE, prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE],
        },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ADDONS_READ + 1,
      select: { externalSubscriptionId: true },
    });
    if (addons.length === 0) return { kind: "CREATE" };
    if (addons.length > MAX_ADDONS_READ) return { kind: "UNDECIDED" };
    const customers = new Set<string>();
    for (const addon of addons) {
      const subscription = await deps.get(`/subscriptions/${encodeURIComponent(addon.externalSubscriptionId!)}`);
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const customerId = customerIdOf(subscription);
      if (!customerId || metadata.userId !== userId) return { kind: "UNDECIDED" };
      customers.add(customerId);
    }
    const [only] = customers;
    return customers.size === 1 && only
      ? { kind: "ADOPT", customerId: only, source: "ADOPTED_STORAGE" }
      : { kind: "UNDECIDED" };
  } catch {
    return { kind: "UNDECIDED" };
  }
}

/**
 * Created with one idempotency key per owner and generation, so concurrent
 * checkouts get the same customer from Stripe. No personal data is sent; Checkout
 * collects what it needs.
 */
async function createCustomer(
  owner: { userId: string; environment: "live" | "test" },
  replaces: string | null,
  deps: StripeCustomerDeps,
): Promise<string | null> {
  const body = new URLSearchParams();
  body.append("metadata[userId]", owner.userId);
  try {
    const customer = await deps.post("/customers", body, {
      idempotencyKey: `proovra-customer-${owner.environment}-${owner.userId}-${replaces ?? "first"}`,
    });
    return typeof customer.id === "string" && customer.id ? customer.id : null;
  } catch {
    return null;
  }
}

function usableFor(currency: string, customerCurrency: string | null): boolean {
  return customerCurrency === null || customerCurrency === currency.toLowerCase();
}

/** Writes the first binding. A race is settled by the unique indexes. */
async function bind(input: {
  userId: string;
  environment: "live" | "test";
  customerId: string;
  source: string;
}): Promise<string | null> {
  try {
    const row = await prisma.billingProviderCustomer.create({
      data: {
        userId: input.userId,
        provider: STRIPE,
        environment: input.environment,
        providerCustomerId: input.customerId,
        source: input.source,
        verifiedAtUtc: new Date(),
      },
      select: { providerCustomerId: true },
    });
    return row.providerCustomerId;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "P2002") throw err;
    const winner = await prisma.billingProviderCustomer.findUnique({
      where: {
        userId_provider_environment: { userId: input.userId, provider: STRIPE, environment: input.environment },
      },
      select: { providerCustomerId: true, state: true },
    });
    // No row of ours means the customer is bound to someone else. It is not used.
    return winner?.state === "ACTIVE" ? winner.providerCustomerId : null;
  }
}

async function markConflict(rowId: string, userId: string, customerId: string): Promise<void> {
  const claimed = await prisma.billingProviderCustomer.updateMany({
    where: { id: rowId, state: "ACTIVE" },
    data: { state: "CONFLICT" },
  });
  if (claimed.count === 0) return;
  await recordBillingReviewItem({
    userId,
    provider: STRIPE,
    providerResourceId: customerId,
    product: "PLAN",
    reason: "PROVIDER_CUSTOMER_CONFLICT",
    detail: { environmentMismatchOrOwnerMismatch: true },
  });
}

/**
 * The customer a Stripe checkout should name, or null to let Stripe make one.
 *
 * Never throws: a checkout that would have worked must not fail because reuse
 * could not be decided.
 */
export async function resolveStripeCheckoutCustomer(
  input: { userId: string; currency: string },
  deps: StripeCustomerDeps = defaultDeps,
): Promise<string | null> {
  try {
    const environment = deps.environment();
    if (!environment) return null;
    const owner = { userId: input.userId, environment };

    const row = await prisma.billingProviderCustomer.findUnique({
      where: { userId_provider_environment: { userId: input.userId, provider: STRIPE, environment } },
    });

    if (row) {
      if (row.state !== "ACTIVE") return null;
      const reading = await readCustomer(row.providerCustomerId, owner, deps);
      if (reading.kind === "UNKNOWN") return null;
      if (reading.kind === "MISMATCH") {
        await markConflict(row.id, input.userId, row.providerCustomerId);
        return null;
      }
      if (reading.kind === "OK") {
        await prisma.billingProviderCustomer.update({
          where: { id: row.id },
          data: { verifiedAtUtc: new Date() },
        });
        return usableFor(input.currency, reading.currency) ? row.providerCustomerId : null;
      }
      const replacement = await createCustomer(owner, row.providerCustomerId, deps);
      if (!replacement) return null;
      const replaced = await prisma.billingProviderCustomer.updateMany({
        where: { id: row.id, providerCustomerId: row.providerCustomerId, state: "ACTIVE" },
        data: {
          providerCustomerId: replacement,
          replacedProviderCustomerId: row.providerCustomerId,
          source: "CREATED",
          verifiedAtUtc: new Date(),
        },
      });
      return replaced.count === 1 ? replacement : null;
    }

    const adoption = await adoptionFor(input.userId, deps);
    if (adoption.kind === "UNDECIDED") return null;
    if (adoption.kind === "CREATE") {
      const created = await createCustomer(owner, null, deps);
      return created ? await bind({ userId: input.userId, environment, customerId: created, source: "CREATED" }) : null;
    }
    const reading = await readCustomer(adoption.customerId, owner, deps);
    if (reading.kind !== "OK") return null;
    const bound = await bind({
      userId: input.userId,
      environment,
      customerId: adoption.customerId,
      source: adoption.source,
    });
    return bound && usableFor(input.currency, reading.currency) ? bound : null;
  } catch (err) {
    logError("billing.stripe_customer_binding_unresolved", err);
    return null;
  }
}
