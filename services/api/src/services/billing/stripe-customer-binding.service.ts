/**
 * BILLING DECISIONS (2026-10-31, D4) — one Stripe customer per billing owner and
 * recurring currency.
 *
 * Every checkout used to leave the customer to Stripe, so one person gathered a
 * separate customer per purchase. This reuses one. Omitting `customer` makes
 * Stripe create another, so omission is never the answer to a doubt: it happens
 * only where a person has to look (CONFLICT) or no key mode can be read.
 *
 * WHY CURRENCY IS PART OF THE BINDING
 * ---------------------------------------------------------------------------
 * Stripe's `customer.currency` is the currency a customer "can be charged in for
 * recurring billing purposes". A customer with an active subscription, schedule,
 * discount, open quote or pending invoice item in one currency cannot take a
 * subscription in another until that object is gone. So each recurring currency
 * has its own row and customer, and two checkouts in two currencies cannot race
 * for one customer's first currency. A one-time payment is not a recurring charge,
 * so a credit purchase reuses any verified customer the owner has.
 *
 * WHAT A BINDING IS
 * ---------------------------------------------------------------------------
 * One row per (owner, provider, environment, currency). A customer id is unique
 * within an environment, so it cannot be bound to two owners or two currencies,
 * and test and live never meet.
 *
 * CREATING ONE, WITHOUT A LOST RESPONSE MAKING A SECOND
 * ---------------------------------------------------------------------------
 * The row is written FIRST, as CREATING, carrying a random key. The unique index
 * makes concurrent checkouts share that row and key, and the key is both Stripe's
 * idempotency key and `metadata[proovraCustomerKey]`.
 *
 *   * A timeout, a 5xx or a concurrent in-flight request: retried once on the same
 *     key, which Stripe answers with the original customer.
 *   * Still no answer: the checkout is refused before any session exists, and the
 *     row stays CREATING, so the next checkout continues the same creation.
 *   * Older than `CREATION_SEARCH_AFTER_MS`: Stripe saves a 500 against its key and
 *     may prune a key after 24 hours, so the key is no longer proof of anything.
 *     The customer is looked up by its metadata key instead. Found, it is bound;
 *     not found, the key is replaced. Search can lag, so a customer created in an
 *     outage could be missed: that leaves one empty, tagged customer, never a
 *     charge on the wrong one.
 *
 * WHICH CUSTOMER, WHEN THERE IS NO BINDING YET
 * ---------------------------------------------------------------------------
 * Old purchases each made their own customer, so several can exist. Stripe is
 * asked, because PROOVRA never stored them, and the first rule that applies wins:
 *
 *   1. a live Stripe base plan: its customer, when its metadata names this owner;
 *   2. no base plan, live Stripe add-ons on one customer: that customer;
 *   3. anything else: a new customer, bound from now on. Several old customers, or
 *      one whose record does not name this owner, offer no verified choice, and
 *      binding a new one stops the count growing with each checkout.
 *
 * An adopted customer billed in another currency is bound under THAT currency, and
 * this checkout gets its own. Nothing merges customers, moves a subscription or
 * touches an old one. Their references stay where they are.
 *
 * WHEN A BINDING STOPS BEING GOOD
 * ---------------------------------------------------------------------------
 *   * Stripe says deleted or unknown: replaced with a new customer, keeping the
 *     old id on the row.
 *   * Stripe's record names another owner, the other environment, or a recurring
 *     currency this row is not for: the row becomes CONFLICT, a review item is
 *     raised and checkouts go without one until a person resolves it. It is never
 *     rebound automatically.
 *   * Stripe cannot be reached: the checkout is refused and can be retried. The row
 *     is unchanged.
 */

import { randomUUID } from "node:crypto";

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { error as logError } from "../../utils/logger.js";
import { StripeHttpError, stripeGet, stripeRequest } from "../stripe.service.js";
import { findLivePersonalBaseSubscription } from "./base-subscription.service.js";
import { recordBillingReviewItem } from "./billing-review.service.js";
import { stripeKeyMode } from "./commercial-offer.service.js";
import { payerOwnedAddonWhere } from "./dependent-cancellation.service.js";

const STRIPE = prismaPkg.PaymentProvider.STRIPE;

/** Bounded: this runs in front of a checkout, once, for a customer with no binding. */
const MAX_ADDONS_READ = 10;

/** Well past Search's normal one minute, so a miss means the create did not land. */
export const CREATION_SEARCH_AFTER_MS = 5 * 60_000;

/** Long enough for a concurrent create on the same key to finish. */
const SAME_KEY_RETRY_DELAY_MS = 400;

/**
 * Whether a customer exists could not be settled, so no session was opened. Going
 * ahead without one would have Stripe make another customer.
 */
export class StripeCustomerUnresolved extends DomainError {
  constructor() {
    super("Stripe customer could not be settled before checkout", {
      httpStatus: 503,
      publicCode: "CHECKOUT_CUSTOMER_UNRESOLVED",
      publicMessage: "The payment service did not answer. No checkout was opened and nothing was charged. Try again in a moment.",
      reportability: "OPERATIONAL_WARNING",
      metadata: { reason: "customer_unresolved" },
    });
    Object.setPrototypeOf(this, StripeCustomerUnresolved.prototype);
  }
}

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
  /** Nothing to adopt, or nothing verified. A new customer becomes the binding. */
  | { kind: "CREATE" }
  /** A read did not answer: nothing is decided, and nothing is created. */
  | { kind: "UNKNOWN" };

const missing = (err: unknown): boolean => err instanceof StripeHttpError && err.status === 404;

async function adoptionFor(userId: string, deps: StripeCustomerDeps): Promise<Adoption> {
  const base = await findLivePersonalBaseSubscription(userId);
  try {
    if (base?.provider === STRIPE) {
      const subscription = await deps.get(`/subscriptions/${encodeURIComponent(base.providerSubId)}`);
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const customerId = customerIdOf(subscription);
      if (!customerId || metadata.userId !== userId) return { kind: "CREATE" };
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
    if (addons.length === 0 || addons.length > MAX_ADDONS_READ) return { kind: "CREATE" };
    const customers = new Set<string>();
    for (const addon of addons) {
      const subscription = await deps.get(`/subscriptions/${encodeURIComponent(addon.externalSubscriptionId!)}`);
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const customerId = customerIdOf(subscription);
      if (!customerId || metadata.userId !== userId) return { kind: "CREATE" };
      customers.add(customerId);
    }
    const [only] = customers;
    return customers.size === 1 && only
      ? { kind: "ADOPT", customerId: only, source: "ADOPTED_STORAGE" }
      : { kind: "CREATE" };
  } catch (err) {
    return missing(err) ? { kind: "CREATE" } : { kind: "UNKNOWN" };
  }
}

type Owner = { userId: string; environment: "live" | "test" };
type BindingRow = prismaPkg.BillingProviderCustomer;

const findBinding = (owner: Owner, currency: string) =>
  prisma.billingProviderCustomer.findFirst({
    where: { userId: owner.userId, provider: STRIPE, environment: owner.environment, currency },
  });

/** Writes the first binding. A race is settled by the unique indexes. */
async function bind(input: Owner & { currency: string; customerId: string; source: string }): Promise<string | null> {
  try {
    const row = await prisma.billingProviderCustomer.create({
      data: {
        userId: input.userId,
        provider: STRIPE,
        environment: input.environment,
        currency: input.currency,
        providerCustomerId: input.customerId,
        source: input.source,
        verifiedAtUtc: new Date(),
      },
      select: { providerCustomerId: true },
    });
    return row.providerCustomerId;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "P2002") throw err;
    const winner = await findBinding(input, input.currency);
    // No row of ours means the customer is bound elsewhere. It is not used.
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
    detail: { recordDoesNotMatchBinding: true },
  });
}

/** The row every concurrent creation for this owner and currency shares. */
async function claimCreation(owner: Owner, currency: string): Promise<BindingRow> {
  try {
    return await prisma.billingProviderCustomer.create({
      data: {
        userId: owner.userId,
        provider: STRIPE,
        environment: owner.environment,
        currency,
        state: "CREATING",
        source: "CREATED",
        creationKey: randomUUID(),
        creationStartedAtUtc: new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "P2002") throw err;
    const winner = await findBinding(owner, currency);
    if (!winner) throw new StripeCustomerUnresolved();
    return winner;
  }
}

async function completeCreation(row: BindingRow, customerId: string): Promise<string | null> {
  const done = await prisma.billingProviderCustomer.updateMany({
    where: { id: row.id, state: "CREATING" },
    data: {
      state: "ACTIVE",
      providerCustomerId: customerId,
      creationKey: null,
      creationStartedAtUtc: null,
      verifiedAtUtc: new Date(),
    },
  });
  if (done.count === 1) return customerId;
  // A concurrent checkout finished first, with the same key and so the same customer.
  const current = await prisma.billingProviderCustomer.findUnique({ where: { id: row.id } });
  return current?.state === "ACTIVE" ? current.providerCustomerId : null;
}

/** A creation that may have landed, found by the key it carried. */
async function findCreatedCustomer(row: BindingRow, owner: Owner, deps: StripeCustomerDeps): Promise<string | null> {
  const query = `metadata['proovraCustomerKey']:'${row.creationKey}'`;
  const found = await deps.get(`/customers/search?query=${encodeURIComponent(query)}`);
  const data = Array.isArray(found.data) ? (found.data as Array<Record<string, unknown>>) : [];
  const customer = data.find((c) => ((c.metadata ?? {}) as Record<string, unknown>).userId === owner.userId);
  return typeof customer?.id === "string" ? customer.id : null;
}

async function postCustomer(row: BindingRow, owner: Owner, deps: StripeCustomerDeps): Promise<string> {
  const body = new URLSearchParams();
  body.append("metadata[userId]", owner.userId);
  body.append("metadata[proovraCustomerKey]", row.creationKey!);
  const customer = await deps.post("/customers", body, { idempotencyKey: `proovra-customer-${row.creationKey}` });
  if (typeof customer.id !== "string" || !customer.id) throw new StripeCustomerUnresolved();
  return customer.id;
}

/** Whether repeating the same key can still answer: a 4xx other than a collision will not. */
const retryable = (err: unknown): boolean =>
  !(err instanceof StripeHttpError) || err.status === 409 || err.status === 429 || err.status >= 500;

async function finishCreation(claimed: BindingRow, owner: Owner, deps: StripeCustomerDeps): Promise<string | null> {
  let row = claimed;
  const started = row.creationStartedAtUtc?.getTime() ?? 0;
  if (Date.now() - started > CREATION_SEARCH_AFTER_MS) {
    let found: string | null;
    try {
      found = await findCreatedCustomer(row, owner, deps);
    } catch {
      throw new StripeCustomerUnresolved();
    }
    if (found) return completeCreation(row, found);
    await prisma.billingProviderCustomer.updateMany({
      where: { id: row.id, state: "CREATING", creationKey: row.creationKey },
      data: { creationKey: randomUUID(), creationStartedAtUtc: new Date() },
    });
    row = (await prisma.billingProviderCustomer.findUnique({ where: { id: row.id } })) ?? row;
    if (row.state === "ACTIVE") return row.providerCustomerId;
  }
  for (const attempt of [1, 2]) {
    try {
      return await completeCreation(row, await postCustomer(row, owner, deps));
    } catch (err) {
      if (attempt === 2 || !retryable(err)) throw new StripeCustomerUnresolved();
      await new Promise((settle) => setTimeout(settle, SAME_KEY_RETRY_DELAY_MS));
    }
  }
  throw new StripeCustomerUnresolved();
}

async function replaceCustomer(row: BindingRow, owner: Owner, deps: StripeCustomerDeps): Promise<string | null> {
  await prisma.billingProviderCustomer.updateMany({
    where: { id: row.id, providerCustomerId: row.providerCustomerId, state: "ACTIVE" },
    data: {
      state: "CREATING",
      providerCustomerId: null,
      replacedProviderCustomerId: row.providerCustomerId,
      source: "CREATED",
      creationKey: randomUUID(),
      creationStartedAtUtc: new Date(),
    },
  });
  const current = await prisma.billingProviderCustomer.findUnique({ where: { id: row.id } });
  if (current?.state === "ACTIVE") return current.providerCustomerId;
  return current?.state === "CREATING" ? finishCreation(current, owner, deps) : null;
}

async function resolveBoundRow(
  row: BindingRow,
  owner: Owner,
  input: { currency: string; recurring: boolean },
  deps: StripeCustomerDeps,
): Promise<string | null> {
  if (row.state === "CREATING") return finishCreation(row, owner, deps);
  if (row.state !== "ACTIVE" || !row.providerCustomerId) return null;
  const reading = await readCustomer(row.providerCustomerId, owner, deps);
  if (reading.kind === "UNKNOWN") throw new StripeCustomerUnresolved();
  if (reading.kind === "GONE") return replaceCustomer(row, owner, deps);
  const wrongCurrency =
    reading.kind === "OK" && input.recurring && reading.currency !== null && reading.currency !== input.currency;
  if (reading.kind === "MISMATCH" || wrongCurrency) {
    await markConflict(row.id, owner.userId, row.providerCustomerId);
    return null;
  }
  await prisma.billingProviderCustomer.update({ where: { id: row.id }, data: { verifiedAtUtc: new Date() } });
  return row.providerCustomerId;
}

/** A one-time payment is not tied to a recurring currency: any good customer serves. */
async function anyVerifiedCustomer(owner: Owner, deps: StripeCustomerDeps): Promise<string | null> {
  const rows = await prisma.billingProviderCustomer.findMany({
    where: {
      userId: owner.userId,
      provider: STRIPE,
      environment: owner.environment,
      state: "ACTIVE",
      providerCustomerId: { not: null },
    },
    orderBy: { verifiedAtUtc: "desc" },
  });
  for (const row of rows) {
    const reading = await readCustomer(row.providerCustomerId!, owner, deps);
    if (reading.kind === "OK") return row.providerCustomerId;
    if (reading.kind === "UNKNOWN") throw new StripeCustomerUnresolved();
  }
  return null;
}

/**
 * The customer a Stripe checkout should name. Null means go without one, which
 * happens only for a key whose mode cannot be read or a binding awaiting review.
 *
 * Throws `StripeCustomerUnresolved` when that cannot be settled: before any session
 * exists, and retryable, because going ahead would make another customer.
 */
export async function resolveStripeCheckoutCustomer(
  input: { userId: string; currency: string; recurring: boolean },
  deps: StripeCustomerDeps = defaultDeps,
): Promise<string | null> {
  try {
    const environment = deps.environment();
    if (!environment) return null;
    const owner: Owner = { userId: input.userId, environment };
    const currency = input.currency.toLowerCase();

    const row = await findBinding(owner, currency);
    if (row) return await resolveBoundRow(row, owner, { currency, recurring: input.recurring }, deps);

    if (!input.recurring) {
      const existing = await anyVerifiedCustomer(owner, deps);
      if (existing) return existing;
    }

    const adoption = await adoptionFor(input.userId, deps);
    if (adoption.kind === "UNKNOWN") throw new StripeCustomerUnresolved();
    if (adoption.kind === "ADOPT") {
      const reading = await readCustomer(adoption.customerId, owner, deps);
      if (reading.kind === "UNKNOWN") throw new StripeCustomerUnresolved();
      if (reading.kind === "OK") {
        const billedIn = reading.currency ?? currency;
        const bound = await bind({ ...owner, currency: billedIn, customerId: adoption.customerId, source: adoption.source });
        if (bound && (billedIn === currency || !input.recurring)) return bound;
      }
    }
    return await finishCreation(await claimCreation(owner, currency), owner, deps);
  } catch (err) {
    if (err instanceof StripeCustomerUnresolved) throw err;
    logError("billing.stripe_customer_binding_unresolved", err);
    throw new StripeCustomerUnresolved();
  }
}
