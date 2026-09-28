/**
 * BILLING ACTIVITY (2026-09-28) — every checkout attempt on ONE billing
 * account that has not produced a completed payment, across all products.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * Billing history reads only `payments` rows, and a payment row exists only
 * once a provider reports that money moved. So two PayPal storage approvals
 * that never completed appeared in the Storage card while the history said
 * "No payments yet" — both true, and together unexplained. Pending plan
 * approvals and uncaptured credit orders appeared nowhere at all.
 *
 * This is the account-scoped list of those attempts: what was started, with
 * which provider, for how much, when, what the provider has said, and the
 * safe action. It reads the existing durable rows — storage attempts are
 * `workspace_storage_addons` rows that never activated, plan and credit
 * attempts are `billing_checkout_attempts`, and pre-attempt PayPal plan
 * approvals are TRIALING subscriptions — and writes nothing.
 *
 * Provider ids and internal references are NOT in the DTO. The `id` is the
 * opaque attempt id the per-attempt actions take, scoped to this account.
 */

import * as prismaPkg from "@prisma/client";
import { EVIDENCE_CREDIT_PRODUCT } from "@proovra/shared-billing";

import { prisma } from "../../db.js";
import { listStorageAddonDefinitions } from "../billing.service.js";
import { getPlanCapabilities } from "../plan-catalog.service.js";
import type { BillingAccountRef, BillingCapability } from "./billing-accounts.service.js";
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import {
  abandonCheckoutAttempt,
  recheckCheckoutAttempt,
  type CheckoutAttemptAbandonResult,
  type CheckoutRecoveryDeps,
} from "./checkout-attempt-recovery.service.js";
import {
  abandonStorageAddonAttempt,
  defaultReconciliationProviders,
  reconcileStorageAddonAttempt,
  type ReconciliationProviders,
  type StorageAttemptAbandonResult,
} from "./reconciliation/reconciliation.service.js";
import {
  withoutProviderStatus,
  type CheckoutAttemptProduct,
  type CheckoutAttemptReconciliation,
} from "./reconciliation/types.js";

/** Terminal attempts stay visible this long; open ones stay until resolved. */
export const ACTIVITY_TERMINAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const ACTIVITY_LIMIT = 30;

export type BillingActivityState =
  | "STARTING"
  | "AWAITING_APPROVAL"
  | "NOT_CONFIRMED_BY_PROVIDER"
  | "PROVIDER_NO_RECORD"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_UNVERIFIED"
  | "PROCESSING"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED"
  | "ABANDONED";

export type BillingActivityItem = {
  id: string;
  product: CheckoutAttemptProduct;
  /** What was being bought, in words. */
  description: string;
  /** "PayPal" / "Card". Never a provider id. */
  providerLabel: string | null;
  createdAtUtc: string;
  state: BillingActivityState;
  /** Short status word for the row. */
  statusLabel: string;
  /** Why this has (not yet) produced a payment or entitlement, and what is safe. */
  explanation: string;
  /** True for a monthly product (plan, storage). */
  recurring: boolean;
  /** When a provider was last asked about it, if ever. */
  lastCheckedAtUtc: string | null;
  /** Present ONLY with BILLING_AMOUNT_VIEW. */
  amountCents?: number;
  currency?: string;
  actions: { canRecheck: boolean; canAbandon: boolean };
};

const TERMINAL_STATUSES = ["FAILED", "CANCELED", "EXPIRED", "ABANDONED"] as const;

function providerLabel(provider: prismaPkg.PaymentProvider | null): string | null {
  if (provider === prismaPkg.PaymentProvider.PAYPAL) return "PayPal";
  if (provider === prismaPkg.PaymentProvider.STRIPE) return "Card";
  return null;
}

function obj(value: prismaPkg.Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lastCheck(metadata: prismaPkg.Prisma.JsonValue | null | undefined): {
  outcome: string | null;
  atUtc: string | null;
} {
  const check = obj(obj(metadata).lastProviderCheck as prismaPkg.Prisma.JsonValue);
  return {
    outcome: typeof check.outcome === "string" ? check.outcome : null,
    atUtc: typeof check.atUtc === "string" ? check.atUtc : null,
  };
}

/** The ONE mapping from recorded facts to an activity state. Pure. */
export function activityStateFor(input: {
  status: string;
  checkoutState: string | null;
  providerBound: boolean;
  lastCheckOutcome: string | null;
  ageMs: number;
}): BillingActivityState {
  switch (input.status) {
    case "FAILED":
      return "FAILED";
    case "CANCELED":
      return "CANCELED";
    case "EXPIRED":
      return "EXPIRED";
    case "ABANDONED":
      return "ABANDONED";
  }
  if (input.checkoutState === "CAPTURE_PENDING") return "PROCESSING";
  if (input.checkoutState === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  if (!input.providerBound) {
    return input.checkoutState === "PROVIDER_CREATE_IN_PROGRESS" && input.ageMs < 2 * 60 * 1000
      ? "STARTING"
      : "NOT_CONFIRMED_BY_PROVIDER";
  }
  switch (input.lastCheckOutcome) {
    case "PROVIDER_REFERENCE_NOT_FOUND":
      return "PROVIDER_NO_RECORD";
    case "PROVIDER_UNAVAILABLE":
      return "PROVIDER_UNREACHABLE";
    case "PROVIDER_REFERENCE_INVALID":
    case "PROVIDER_AUTHORIZATION_FAILED":
    case "PROVIDER_MALFORMED":
      return "PROVIDER_UNVERIFIED";
  }
  return "AWAITING_APPROVAL";
}

const NOT_APPLIED = "It has not produced a payment, so it is not in your payment history, and nothing has been added to your account.";

export function activityCopy(
  state: BillingActivityState,
  product: CheckoutAttemptProduct,
): { statusLabel: string; explanation: string } {
  const grants =
    product === "PLAN"
      ? "the plan"
      : product === "STORAGE"
        ? "the storage"
        : "the credit";
  switch (state) {
    case "STARTING":
      return { statusLabel: "Starting", explanation: "This checkout is being opened with PayPal." };
    case "AWAITING_APPROVAL":
      return {
        statusLabel: "Waiting for approval",
        explanation: `Waiting for you to approve it at PayPal. Nothing is charged until you do. ${NOT_APPLIED}`,
      };
    case "NOT_CONFIRMED_BY_PROVIDER":
      return {
        statusLabel: "Not confirmed",
        explanation: `PayPal never confirmed that this checkout was created, so there is nothing to approve from PROOVRA. Nothing can be charged without your approval at PayPal. ${NOT_APPLIED}`,
      };
    case "PROVIDER_NO_RECORD":
      return {
        statusLabel: "No record at PayPal",
        explanation: `PayPal no longer has a record of this checkout, and it was never approved through PROOVRA. ${NOT_APPLIED}`,
      };
    case "PROVIDER_UNREACHABLE":
      return {
        statusLabel: "Status unknown",
        explanation: `PayPal could not be reached the last time this was checked. Its status is unknown, not pending. ${NOT_APPLIED}`,
      };
    case "PROVIDER_UNVERIFIED":
      return {
        statusLabel: "Status unknown",
        explanation: `PayPal could not confirm this checkout the last time it was checked. ${NOT_APPLIED}`,
      };
    case "PROCESSING":
      return {
        statusLabel: "Processing",
        explanation: `You approved this at PayPal and PayPal is still processing the payment. ${grants.charAt(0).toUpperCase()}${grants.slice(1)} is added when PayPal reports it completed.`,
      };
    case "NEEDS_REVIEW":
      return {
        statusLabel: "Being reviewed",
        explanation: "PayPal's amount for this purchase did not match our price, so nothing was added automatically. Support will review it; contact us if you were charged.",
      };
    case "FAILED":
      return {
        statusLabel: "Failed",
        explanation: `PayPal did not complete this purchase. Nothing was added.`,
      };
    case "CANCELED":
      return {
        statusLabel: "Canceled",
        explanation: "This checkout was canceled at PayPal before any payment. Nothing was charged or added.",
      };
    case "EXPIRED":
      return {
        statusLabel: "Expired",
        explanation: "The approval window closed before it was approved. Nothing was charged or added.",
      };
    case "ABANDONED":
      return {
        statusLabel: "Abandoned",
        explanation: "You stopped this attempt in PROOVRA. That did not cancel anything at PayPal; if PayPal ever confirms a payment for it, PROOVRA will still apply it.",
      };
  }
}

function requiredCapability(product: CheckoutAttemptProduct): BillingCapability {
  return product === "PLAN" ? "BILLING_MANAGE" : "BILLING_ADDON_PURCHASE";
}

function actionsFor(
  account: BillingAccountRef,
  product: CheckoutAttemptProduct,
  state: BillingActivityState,
): BillingActivityItem["actions"] {
  const may = account.capabilities.includes(requiredCapability(product));
  const open = !["FAILED", "CANCELED", "EXPIRED", "ABANDONED"].includes(state);
  return {
    canRecheck: may && open && state !== "STARTING",
    canAbandon:
      may &&
      open &&
      state !== "STARTING" &&
      state !== "PROCESSING" &&
      state !== "NEEDS_REVIEW",
  };
}

/** ONE account's checkout activity. Read-only. */
export async function readBillingActivityForAccount(input: {
  account: BillingAccountRef;
  now?: Date;
}): Promise<BillingActivityItem[]> {
  const { account } = input;
  if (account.type !== "PERSONAL") return [];
  if (!account.capabilities.includes("BILLING_HISTORY_VIEW")) return [];
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - ACTIVITY_TERMINAL_WINDOW_MS);
  const showAmounts = account.capabilities.includes("BILLING_AMOUNT_VIEW");

  const [attempts, legacy, storage] = await Promise.all([
    prisma.billingCheckoutAttempt.findMany({
      where: {
        userId: account.id,
        OR: [
          { status: prismaPkg.BillingCheckoutAttemptStatus.PENDING },
          { status: { in: [...TERMINAL_STATUSES] }, createdAt: { gte: since } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
    }),
    prisma.subscription.findMany({
      where: {
        userId: account.id,
        provider: prismaPkg.PaymentProvider.PAYPAL,
        plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
        status: prismaPkg.SubscriptionStatus.TRIALING,
      },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
      select: { id: true, plan: true, provider: true, providerSubId: true, createdAt: true },
    }),
    prisma.workspaceStorageAddon.findMany({
      where: {
        ownerUserId: account.id,
        teamId: null,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        activatedAtUtc: null,
        OR: [
          { status: prismaPkg.WorkspaceStorageAddonStatus.PENDING },
          {
            status: {
              in: [
                prismaPkg.WorkspaceStorageAddonStatus.FAILED,
                prismaPkg.WorkspaceStorageAddonStatus.CANCELED,
                prismaPkg.WorkspaceStorageAddonStatus.EXPIRED,
                prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
              ],
            },
            createdAt: { gte: since },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
    }),
  ]);

  const items: BillingActivityItem[] = [];
  const boundSubs = new Set(
    attempts.filter((a) => a.providerResourceId).map((a) => `${a.provider}:${a.providerResourceId}`),
  );

  for (const a of attempts) {
    const product: CheckoutAttemptProduct = a.product === "PLAN" ? "PLAN" : "EVIDENCE_CREDIT";
    const check = lastCheck(a.metadata);
    const state = activityStateFor({
      status: a.status,
      checkoutState: a.checkoutState,
      providerBound: Boolean(a.providerResourceId),
      lastCheckOutcome: check.outcome,
      ageMs: now.getTime() - a.createdAt.getTime(),
    });
    const copy = activityCopy(state, product);
    const credits = EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase;
    items.push({
      id: a.id,
      product,
      description:
        product === "PLAN"
          ? `${getPlanCapabilities(a.planKey ?? prismaPkg.PlanType.PRO).displayName} plan`
          : credits === 1
            ? "Evidence credit"
            : `${credits} evidence credits`,
      providerLabel: providerLabel(a.provider),
      createdAtUtc: a.createdAt.toISOString(),
      state,
      ...copy,
      recurring: product === "PLAN",
      lastCheckedAtUtc: check.atUtc,
      ...(showAmounts ? { amountCents: a.amountCents, currency: a.currency } : {}),
      actions: actionsFor(account, product, state),
    });
  }

  for (const sub of legacy) {
    if (boundSubs.has(`${sub.provider}:${sub.providerSubId}`)) continue;
    const state: BillingActivityState = "AWAITING_APPROVAL";
    items.push({
      id: sub.id,
      product: "PLAN",
      description: `${getPlanCapabilities(sub.plan).displayName} plan`,
      providerLabel: providerLabel(sub.provider),
      createdAtUtc: sub.createdAt.toISOString(),
      state,
      ...activityCopy(state, "PLAN"),
      recurring: true,
      lastCheckedAtUtc: null,
      actions: actionsFor(account, "PLAN", state),
    });
  }

  const defs = listStorageAddonDefinitions();
  for (const row of storage) {
    const meta = obj(row.metadata);
    const check = lastCheck(row.metadata);
    const checkoutState = typeof meta.checkoutState === "string" ? meta.checkoutState : null;
    const state = activityStateFor({
      status: row.status,
      checkoutState,
      providerBound: Boolean(row.externalSubscriptionId),
      lastCheckOutcome: check.outcome,
      ageMs: now.getTime() - row.createdAt.getTime(),
    });
    const label = defs.find((d) => d.key === row.addonKey)?.label ?? "Storage";
    items.push({
      id: row.id,
      product: "STORAGE",
      description: `${label} storage add-on`,
      providerLabel: providerLabel(row.paymentProvider),
      createdAtUtc: row.createdAt.toISOString(),
      state,
      ...activityCopy(state, "STORAGE"),
      recurring: true,
      lastCheckedAtUtc: check.atUtc,
      ...(showAmounts && row.amountCents !== null && row.currency
        ? { amountCents: row.amountCents, currency: row.currency }
        : {}),
      actions: actionsFor(account, "STORAGE", state),
    });
  }

  return items
    .sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc))
    .slice(0, ACTIVITY_LIMIT);
}

// ===========================================================================
// Per-attempt actions, dispatched by product
// ===========================================================================

export class BillingAttemptBusyError extends Error {
  readonly statusCode = 409;
  readonly code = "BILLING_ATTEMPT_BUSY";
  constructor() {
    super("This purchase is already being checked. Wait a moment, then refresh.");
  }
}

/**
 * ONE action per attempt at a time. A double click (or a second tab) gets 409
 * instead of a second provider read-and-apply racing the first; the lock is
 * released the moment the action finishes, so "Check status" followed by
 * "Abandon" is never refused. Transaction-scoped PostgreSQL advisory lock:
 * nothing to clean up after a crash.
 */
export async function withBillingAttemptLock<T>(attemptId: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`billing-attempt-action:${attemptId}`})) AS locked
      `;
      if (!rows[0]?.locked) throw new BillingAttemptBusyError();
      return fn();
    },
    { maxWait: 5_000, timeout: 60_000 },
  );
}

type OwnedAttempt = { product: CheckoutAttemptProduct; storage: boolean };

async function resolveOwnedAttempt(
  account: BillingAccountRef,
  attemptId: string,
): Promise<OwnedAttempt | null> {
  if (account.type !== "PERSONAL") return null;
  const storage = await prisma.workspaceStorageAddon.findFirst({
    where: {
      id: attemptId,
      ownerUserId: account.id,
      teamId: null,
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    },
    select: { id: true },
  });
  if (storage) return { product: "STORAGE", storage: true };
  const attempt = await prisma.billingCheckoutAttempt.findFirst({
    where: { id: attemptId, userId: account.id },
    select: { product: true },
  });
  if (attempt) {
    return { product: attempt.product === "PLAN" ? "PLAN" : "EVIDENCE_CREDIT", storage: false };
  }
  const legacy = await prisma.subscription.findFirst({
    where: { id: attemptId, userId: account.id, status: prismaPkg.SubscriptionStatus.TRIALING },
    select: { id: true },
  });
  return legacy ? { product: "PLAN", storage: false } : null;
}

function notFound(): Error {
  const err: Error & { statusCode?: number } = new Error("Checkout attempt not found");
  err.statusCode = 404;
  return err;
}

function forbidden(): Error {
  const err: Error & { statusCode?: number; code?: string } = new Error(
    "This billing action is not available to you",
  );
  err.statusCode = 403;
  err.code = "BILLING_CAPABILITY_REQUIRED";
  return err;
}

async function authorize(account: BillingAccountRef, attemptId: string): Promise<OwnedAttempt> {
  const owned = await resolveOwnedAttempt(account, attemptId);
  if (!owned) throw notFound();
  if (!account.capabilities.includes(requiredCapability(owned.product))) throw forbidden();
  return owned;
}

export type BillingAttemptRecheckResult = CheckoutAttemptReconciliation;

export async function recheckBillingAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  providers?: ReconciliationProviders;
  deps?: Omit<CheckoutRecoveryDeps, "providers">;
}): Promise<BillingAttemptRecheckResult> {
  const owned = await authorize(input.account, input.attemptId);
  const providers = input.providers ?? defaultReconciliationProviders();
  return withBillingAttemptLock(input.attemptId, () => recheckOwned(input, owned, providers));
}

async function recheckOwned(
  input: {
    account: BillingAccountRef;
    attemptId: string;
    deps?: Omit<CheckoutRecoveryDeps, "providers">;
  },
  owned: OwnedAttempt,
  providers: ReconciliationProviders,
): Promise<BillingAttemptRecheckResult> {
  if (owned.storage) {
    const r = await reconcileStorageAddonAttempt({
      account: input.account,
      attemptId: input.attemptId,
      providers,
    });
    return {
      attemptId: r.attemptId,
      product: "STORAGE",
      createdAtUtc: r.createdAtUtc,
      provider: r.provider,
      providerBound: r.providerBound,
      previousStatus: r.previousStatus,
      currentStatus: r.currentStatus,
      outcome: r.outcome,
      locallyAbandoned: r.previousStatus === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
      ...(r.resumeUrl ? { resumeUrl: r.resumeUrl } : {}),
    };
  }
  const r = await recheckCheckoutAttempt({
    account: input.account,
    attemptId: input.attemptId,
    deps: { providers, ...(input.deps ?? {}) },
  });
  return withoutProviderStatus(r);
}

export type BillingAttemptAbandonResult = {
  attemptId: string;
  outcome:
    | "ABANDON_CONFIRMATION_REQUIRED"
    | "ABANDONED"
    | "ALREADY_ABANDONED"
    | "ALREADY_RESOLVED"
    | "ABANDON_NOT_ALLOWED"
    | "PROVIDER_STATE_RECORDED";
  warning?: string;
  /** Abandonment is local only. It never cancels anything at the provider. */
  cancelsAtProvider: false;
  currentStatus?: string;
};

function normalizeAbandon(
  attemptId: string,
  r: CheckoutAttemptAbandonResult | StorageAttemptAbandonResult,
): BillingAttemptAbandonResult {
  switch (r.outcome) {
    case "ABANDON_CONFIRMATION_REQUIRED":
    case "ABANDONED":
    case "ALREADY_ABANDONED":
    case "ALREADY_RESOLVED":
    case "ABANDON_NOT_ALLOWED":
      return {
        attemptId,
        outcome: r.outcome,
        ...("warning" in r && r.warning ? { warning: r.warning } : {}),
        cancelsAtProvider: false,
      };
    case "UPDATED":
      return {
        attemptId,
        outcome: "PROVIDER_STATE_RECORDED",
        cancelsAtProvider: false,
        currentStatus: "currentStatus" in r ? r.currentStatus : undefined,
      };
    default:
      // A provider answer that neither settles nor permits abandonment.
      return { attemptId, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false };
  }
}

export async function abandonBillingAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  confirmed?: boolean;
  providers?: ReconciliationProviders;
  deps?: Omit<CheckoutRecoveryDeps, "providers">;
}): Promise<BillingAttemptAbandonResult> {
  const owned = await authorize(input.account, input.attemptId);
  const providers = input.providers ?? defaultReconciliationProviders();
  const result = await withBillingAttemptLock<
    CheckoutAttemptAbandonResult | StorageAttemptAbandonResult
  >(input.attemptId, () => owned.storage
    ? abandonStorageAddonAttempt({
        account: input.account,
        attemptId: input.attemptId,
        confirmed: input.confirmed,
        providers,
      })
    : abandonCheckoutAttempt({
        account: input.account,
        attemptId: input.attemptId,
        confirmed: input.confirmed,
        deps: { providers, ...(input.deps ?? {}) },
      }));
  return normalizeAbandon(input.attemptId, result);
}
