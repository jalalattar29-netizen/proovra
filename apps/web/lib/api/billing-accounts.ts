"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the typed Billing client.
 *
 * These types MIRROR the server projection
 * (`services/api/src/services/billing/billing-account-projection.service.ts`)
 * and add nothing. The browser renders what the server decided; it does not
 * derive a plan, a limit, a price or a capability.
 *
 * That is not a style preference. The page this replaces read
 * `envelope.planFeatures.limits.maxOwnedWorkspaces` — a workspace-creation cap
 * — and rendered it as the denominator of a Collaboration Team membership
 * count, producing "Current usage: 1 of 2" from two unrelated quantities. A
 * client that only renders cannot invent that.
 *
 * Fields declared OPTIONAL here are optional because the SERVER omits them when
 * the viewer lacks the capability — an absent `priceCents` means "you may not
 * see amounts", never "the price is zero".
 */

import { apiFetch } from "../api";

/*
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — WORKSPACE was REMOVED.
 *
 * A workspace never paid for anything. It appeared here because the server
 * enumerated one billing account per Owned Workspace, each with its own plan
 * card, checkout target, payment history and storage catalogue — a selector
 * inviting a customer to choose which of their workspaces to pay for, when
 * there is one Personal Workspace and TEAM is a tier of it.
 */
export type BillingAccountType = "PERSONAL" | "ORGANIZATION";

export type BillingCapability =
  | "BILLING_ACCOUNT_VIEW"
  | "BILLING_AMOUNT_VIEW"
  | "BILLING_HISTORY_VIEW"
  | "BILLING_MANAGE"
  | "BILLING_CANCEL"
  | "BILLING_ADDON_PURCHASE";

export type BillingAccountRef = {
  type: BillingAccountType;
  id: string;
  displayName: string;
  capabilities: BillingCapability[];
  billingOwnerMissing: boolean;
};

export type UsageWindow = "LIFETIME" | "ROLLING_30_DAYS" | "CALENDAR_MONTH";

export type UsageMeter =
  | { state: "MEASURED"; used: number; limit: number | null; window: UsageWindow }
  | { state: "NOT_INCLUDED" }
  | { state: "CONTRACT_MANAGED" }
  | { state: "UNAVAILABLE"; reason: string };

/**
 * BILLING SURFACE CORRECTION (2026-08-29) — the parts of the evidence allowance,
 * kept apart so the page can state them instead of collapsing them into one
 * number it then has to describe wrongly.
 *
 * Mirrors the server projection exactly. Nothing here is derived in the
 * browser: `next` is the SAME decision the enforcement gate makes, computed
 * once on the server by the same pure policy, so the page cannot promise a
 * record the gate would refuse.
 */
export type EvidenceAdmission = {
  /** What the PLAN includes, before any grandfather substitution. */
  planIncludedLifetime: number | null;
  /** The cap actually enforced; `capSource` says which of the two this is. */
  effectiveLifetimeCap: number | null;
  capSource: "PLAN_DEFAULT" | "LEGACY_RECORD_CAP_OVERRIDE";
  recordsHeld: number;
  creditsAvailable: number;
  planCapacityRemaining: number | null;
  overCap: boolean;
  next:
    | { allowed: true; funding: "PLAN" | "EVIDENCE_CREDIT" }
    | {
        allowed: false;
        reason:
          | "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS"
          | "CREDIT_REQUIRED_NONE_AVAILABLE";
      };
};

export type StorageMeter =
  | {
      state: "MEASURED";
      usedBytes: string;
      usedLabel: string;
      limitBytes: string;
      limitLabel: string;
      baseBytes: string;
      baseLabel: string;
      recurringAddonBytes: string;
      recurringAddonLabel: string;
      legacyAddonBytes: string;
      legacyAddonLabel: string;
      usagePercent: number;
      nearLimit: boolean;
      limitReached: boolean;
    }
  | { state: "UNAVAILABLE"; reason: string };

export type CommercialModel = "FREE" | "MONTHLY" | "CREDIT" | "CONTRACT";

export type PlanLifecycle =
  | "ACTIVE"
  | "TRIALING"
  | "PAST_DUE"
  | "ACTION_REQUIRED"
  | "CANCELING"
  | "CANCELLED"
  | "INACTIVE";

export type PlanSummary = {
  planKey: string;
  displayName: string;
  model: CommercialModel;
  /**
   * HOW this account came to be on the tier it is on. Server-decided.
   *
   * The page could not tell a paying customer from one who was GRANTED a tier
   * and said "Billed monthly · $19.00 per month" to both, because the model
   * fell back to the CATALOGUE price whenever a paid tier had no subscription
   * row. A granted entitlement is real access with no billing relationship: it
   * does not renew, nothing is charged, and there is nothing for a provider to
   * cancel. Which it is depends on a subscription row the browser cannot see.
   */
  accessKind: "SUBSCRIPTION" | "GRANTED" | "CONTRACT" | "CREDIT" | "FREE";
  lifecycle: PlanLifecycle;
  priceCents?: number | null;
  currency?: "USD" | "EUR";
  currentPeriodEndUtc: string | null;
  cancelAtPeriodEnd: boolean;
  paymentProviderLabel?: string | null;
  graceEndsAtUtc?: string | null;
  billingOwnerMissing: boolean;
  /** A provider-accepted change that has not taken effect yet. */
  scheduledChange?: {
    planKey: string;
    displayName: string;
    effectiveAtUtc: string | null;
  };
};

export type EnterpriseContractSummary = {
  status: string;
  activationState: string | null;
  effectiveAtUtc: string | null;
  endsAtUtc: string | null;
  seatCount: number | null;
  storageGb: number | null;
  region: string | null;
  derivedFromLegacyFallback: boolean;
};

export type CollaborationUsage = {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `ownedWorkspaces` was
  // removed with the allowance it reported: no plan grants additional
  // workspaces, so there is no meter to render.
  collaborationTeams?: { used: number; limit: number };
  /** `limit: null` = the agreement is silent, not a limit of zero. */
  seats?: { used: number; limit: number | null; pendingInvites: number };
};

export type PlanOffer = {
  planKey: "PRO" | "TEAM";
  displayName: string;
  priceCents?: number;
  currency?: "USD" | "EUR";
  summary: string;
  /**
   * WHAT this offer does, decided by the server against a subscription the
   * browser cannot see. The page renders the verb; it never works it out by
   * comparing plan names, which would be a commercial decision made in a
   * place that does not have the facts.
   */
  action: "CHECKOUT" | "UPGRADE" | "DOWNGRADE";
  effect: "IMMEDIATE" | "AT_PERIOD_END";
  /** The button's words. Composed by the server, rendered verbatim. */
  actionLabel: string;
  /** What will happen, shown before the customer commits. */
  effectSummary: string;
};

export type StorageAddonOffer = {
  key: string;
  label: string;
  storageBytes: string;
  storageLabel: string;
  priceCents: number;
  currency: "USD" | "EUR";
  billingCycle: "MONTHLY";
};

export type ActiveStorageAddon = {
  id: string;
  addonKey: string;
  label: string;
  storageLabel: string;
  status: string;
  billingCycle: string;
  legacyOneTime: boolean;
  canCancel: boolean;
  activatedAtUtc: string | null;
  currentPeriodEndUtc: string | null;
  priceCents?: number | null;
  currency?: string | null;
};

export type BillingAccountProjection = {
  account: BillingAccountRef;
  plan: PlanSummary;
  usage: { evidence: UsageMeter; storage: StorageMeter; ai: UsageMeter };
  wallet?: {
    availableCredits: number;
    purchasedCredits: number;
    consumedCredits: number;
    hasLedgerHistory: boolean;
    unitPriceCents?: number;
    currency?: "USD" | "EUR";
    /** How many credits ONE purchase grants. Server-owned; never chosen here. */
    creditsPerPurchase: number;
  };
  /** PERSONAL accounts only; a contract-managed Organization has no wallet. */
  evidenceAdmission?: EvidenceAdmission;
  collaboration?: CollaborationUsage;
  contract?: EnterpriseContractSummary;
  planOffers?: PlanOffer[];
  actionRequired: {
    severity: "CRITICAL" | "WARNING";
    title: string;
    messages: string[];
    reassurance: string | null;
  } | null;
  /**
   * Storage add-ons whose cancellation the provider has not confirmed.
   *
   * Absent when nothing is outstanding, so its presence IS the condition. The
   * server decides every value here; the browser renders it and classifies
   * nothing.
   */
  dependentStorageCancellation?: {
    status:
      | "PENDING"
      | "RETRY_SCHEDULED"
      | "ACTION_REQUIRED"
      | "MANUAL_INTERVENTION";
    affectedCount: number;
    lastAttemptAtUtc: string | null;
    nextRetryAtUtc: string | null;
    actionAvailable: boolean;
    supportRequired: boolean;
  };
  storageAddons?: { offers: StorageAddonOffer[]; active: ActiveStorageAddon[] };
  /**
   * Why storage add-ons are NOT on offer, and which tier includes them.
   * Present only while they are unavailable, so its presence is the condition.
   */
  storageAddonsLocked?: { reason: string; unlockedByPlan: string | null };
  actions: {
    canStartCheckout: boolean;
    canBuyEvidenceCredits: boolean;
    canBuyStorageAddon: boolean;
    canRequestCancellation: boolean;
    contactAccountManager: boolean;
    manageLabel: string | null;
    /**
     * THE ONE plan-management action. Server-decided, rendered verbatim.
     *
     * The card used to render one button per offer, so FREE showed "Subscribe
     * to Pro" and "Subscribe to Team" side by side — both opening the same
     * drawer — and PRO was offered "Subscribe to Team" for what is an upgrade
     * of the subscription it already has.
     */
    planManagement: {
      label: string;
      mode:
        | "CHOOSE"
        | "MANAGE"
        | "REVIEW_SCHEDULED"
        | "VIEW_ACCESS"
        | "VIEW_AGREEMENT";
      enabled: boolean;
    };
    /**
     * A SECOND plan action, present only for a GRANTED tier with a real tier
     * above it.
     *
     * It is a PURCHASE, not a transition: `planKey` opens the new-subscription
     * checkout, because a granted tier has no provider subscription to change.
     * The page renders what the server composed and derives none of it.
     */
    secondaryPlanAction?: {
      kind: "START_SUBSCRIPTION";
      planKey: "PRO" | "TEAM";
      label: string;
    };
    /** Why cancellation is absent, when it is. Present only then. */
    cancellationUnavailableReason?: "NOT_AUTHORIZED" | "NO_SUBSCRIPTION_BOUND";
  };
};

export type BillingHistoryEntry = {
  id: string;
  occurredAtUtc: string;
  description: string;
  status: string;
  amountCents?: number;
  currency?: string;
  providerLabel?: string | null;
  /**
   * BILLING SURFACE CORRECTION (2026-08-29) — what may be done with THIS row,
   * decided by the server.
   *
   * Never derived here. Whether a payment can be stopped depends on what the
   * provider actually supports — Stripe can expire an open Checkout Session,
   * PayPal has no equivalent for an unapproved order — and on the viewer's own
   * capability. A page that worked it out from the status string would offer
   * PayPal customers a button that could only ever lie to them.
   */
  actions: { canRecheck: boolean; canCancel: boolean; canAbandon: boolean };
};

/** What the server learned when it asked the provider about one payment. */
export type PaymentRecheckResult = {
  /**
   * Every failure used to be PROVIDER_UNAVAILABLE, which is a claim about the
   * network. Three of these are not outages, and "try again shortly" is the
   * wrong advice for all three.
   */
  outcome:
    | "UPDATED"
    | "NO_CHANGE"
    | "PROVIDER_UNAVAILABLE"
    | "PROVIDER_REFERENCE_NOT_FOUND"
    | "PROVIDER_REFERENCE_INVALID"
    | "PROVIDER_AUTHORIZATION_FAILED";
  status: string;
  /**
   * Where the customer can finish paying, when the provider still holds the
   * flow open. Read live from the provider and never stored — a checkout URL
   * outlives the session it points at, so one that was saved would eventually
   * send a paying customer to a dead page.
   */
  resumeUrl: string | null;
  actions: { canRecheck: boolean; canCancel: boolean; canAbandon: boolean };
};

/**
 * Giving up on a checkout the provider cannot be asked to stop.
 *
 * PayPal exposes no cancellation for an unapproved order, so a months-old
 * approval attempt had "Re-check" and nothing else. This records the
 * CUSTOMER's decision — after the server reconciles and confirms nothing was
 * captured — and claims nothing about the provider.
 */
export type PaymentAbandonResult = {
  outcome:
    | "ABANDONED"
    | "ALREADY_ABANDONED"
    | "ALREADY_FINISHED"
    | "PROVIDER_ANSWERED"
    /**
     * The provider could not be asked. The customer is told exactly what
     * abandoning does and does not mean, and asked again.
     *
     * This replaces a 503: the projection advertised `canAbandon: true` while
     * the endpoint could only refuse whenever the provider was unreachable —
     * which is the one case the action exists for.
     */
    | "ABANDON_CONFIRMATION_REQUIRED";
  status: string;
  actions: { canRecheck: boolean; canCancel: boolean; canAbandon: boolean };
  /** Present ONLY with ABANDON_CONFIRMATION_REQUIRED. Server-composed. */
  warning?: string;
  confirmation?: { canConfirmAbandon: true };
  providerFailure?: string;
};

export async function abandonPayment(
  account: BillingAccountRef,
  paymentId: string,
  options: { confirmed?: boolean } = {},
): Promise<PaymentAbandonResult> {
  return (await apiFetch(
    `/v1/billing/accounts/${account.type}/${encodeURIComponent(
      account.id,
    )}/payments/${encodeURIComponent(paymentId)}/abandon`,
    {
      method: "POST",
      // The confirmation is only ever CONSULTED where the provider proved
      // nothing; it can never turn a settled payment into an abandoned one.
      body: JSON.stringify({ confirmed: options.confirmed === true }),
    },
  )) as PaymentAbandonResult;
}

export type PaymentCancelResult = {
  outcome: "CANCELLED" | "ALREADY_FINISHED";
  status: string;
  actions: { canRecheck: boolean; canCancel: boolean; canAbandon: boolean };
};

/**
 * Ask the server to check ONE payment with the provider.
 *
 * Nothing is charged and no checkout is created: the server reads the
 * transaction it already stored a reference for, and records what the provider
 * says. Safe to press repeatedly — the transition rules make a second identical
 * answer a no-op.
 */
export async function recheckPayment(
  account: BillingAccountRef,
  paymentId: string,
): Promise<PaymentRecheckResult> {
  return (await apiFetch(
    `/v1/billing/accounts/${account.type}/${encodeURIComponent(
      account.id,
    )}/payments/${encodeURIComponent(paymentId)}/recheck`,
    { method: "POST", body: "{}" },
  )) as PaymentRecheckResult;
}

/**
 * Ask the PROVIDER to stop one unsettled payment.
 *
 * Refused by the server where the provider has no such operation, rather than
 * marked cancelled locally while the provider is still free to complete it.
 */
export async function cancelPayment(
  account: BillingAccountRef,
  paymentId: string,
): Promise<PaymentCancelResult> {
  return (await apiFetch(
    `/v1/billing/accounts/${account.type}/${encodeURIComponent(
      account.id,
    )}/payments/${encodeURIComponent(paymentId)}/cancel`,
    { method: "POST", body: "{}" },
  )) as PaymentCancelResult;
}

export type CancellationOutcome = {
  mode: "PERIOD_END" | "IMMEDIATE";
  accessEndsAtUtc: string | null;
  cancelAtPeriodEnd: boolean;
  status: string;
  alreadyScheduled: boolean;
};

export function hasCapability(
  account: Pick<BillingAccountRef, "capabilities">,
  capability: BillingCapability,
): boolean {
  return account.capabilities.includes(capability);
}

export async function listBillingAccounts(): Promise<BillingAccountRef[]> {
  const res = (await apiFetch("/v1/billing/accounts")) as {
    accounts?: BillingAccountRef[];
  } | null;
  return Array.isArray(res?.accounts) ? res.accounts : [];
}

export async function readBillingAccount(input: {
  type: BillingAccountType;
  id: string;
  currency?: string;
}): Promise<BillingAccountProjection> {
  const qs = input.currency
    ? `?currency=${encodeURIComponent(input.currency)}`
    : "";
  return (await apiFetch(
    `/v1/billing/accounts/${input.type}/${encodeURIComponent(input.id)}${qs}`,
  )) as BillingAccountProjection;
}

export async function readBillingHistory(input: {
  type: BillingAccountType;
  id: string;
  limit?: number;
}): Promise<BillingHistoryEntry[]> {
  const qs = input.limit ? `?limit=${input.limit}` : "";
  const res = (await apiFetch(
    `/v1/billing/accounts/${input.type}/${encodeURIComponent(input.id)}/history${qs}`,
  )) as { items?: BillingHistoryEntry[] } | null;
  return Array.isArray(res?.items) ? res.items : [];
}

/**
 * BILLING RECONCILIATION (2026-08-27) — a cancellation is only COMPLETE when
 * every recurring Storage add-on that depended on the plan has stopped too.
 * `ACTION_REQUIRED` means one of them is still charging.
 */
export type CancellationResult = CancellationOutcome & {
  result: "COMPLETE" | "ACTION_REQUIRED";
  dependentAddonsFound: number;
  dependentAddonsScheduled: number;
  dependentAddonsFailed: number;
};

/**
 * Retry ONLY the outstanding storage add-on cancellations.
 *
 * Named separately from `requestCancellation` because it is a different act:
 * the plan is already cancelled, and re-running that would ask the provider to
 * cancel a subscription it has already cancelled. This retries the durable
 * obligations the server recorded, and nothing else.
 *
 * The request names the ACCOUNT and nothing else — no add-on id, no provider
 * reference.
 */
export async function retryStorageCancellation(
  account: BillingAccountRef,
): Promise<{
  outcome: "UPDATED" | "PENDING" | "ACTION_REQUIRED";
  supportRequired: boolean;
}> {
  return (await apiFetch(
    `/v1/billing/accounts/${account.type}/${encodeURIComponent(account.id)}/retry-storage-cancellation`,
    { method: "POST", body: "{}" },
  )) as { outcome: "UPDATED" | "PENDING" | "ACTION_REQUIRED"; supportRequired: boolean };
}

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — cancellation takes NO
 * argument.
 *
 * It took a `teamId`, which selected which of the caller's workspace
 * subscriptions to cancel. There is one subscription per person now, the
 * server knows which, and a client that could name a different one could name
 * the wrong one.
 */
export async function requestCancellation(): Promise<CancellationResult> {
  const res = (await apiFetch("/v1/billing/subscription/cancel", {
    method: "POST",
    body: JSON.stringify({}),
  })) as { cancellation: CancellationResult };
  return res.cancellation;
}

/** What the server did about a requested plan change. */
export type PlanChangeResult = {
  outcome: "UPGRADE" | "DOWNGRADE" | "NO_CHANGE";
  plan: string;
  /** DOWNGRADE: when the lower tier takes over. UPGRADE: null — it already has. */
  effectiveAtUtc?: string | null;
  /** PayPal only, and only when the buyer must authorise the revised agreement. */
  approvalUrl?: string | null;
  providerConfirmed?: boolean;
};

/**
 * Move the plan on the subscription that already exists.
 *
 * The request carries a TARGET and nothing else — not the current plan, not a
 * direction, not a price. Every one of those is something the server already
 * knows, and any of them accepted from a browser is a value a browser can be
 * wrong about.
 */
export async function changePlan(input: {
  plan: "PRO" | "TEAM";
}): Promise<PlanChangeResult> {
  return (await apiFetch("/v1/billing/subscription/plan", {
    method: "POST",
    body: JSON.stringify({ plan: input.plan }),
  })) as PlanChangeResult;
}

/** A safe, server-decided reconciliation verdict. Never provider detail. */
export type ReconciliationOutcome =
  | "NO_CHANGE"
  | "UPDATED"
  | "PENDING"
  | "ACTION_REQUIRED"
  | "PROVIDER_UNAVAILABLE";

export type ReconciliationResult = {
  outcome: ReconciliationOutcome;
  summary: {
    checked: number;
    creditsRestored: number;
    paymentsRecorded: number;
    subscriptionsUpdated: number;
    pending: number;
    actionRequired: number;
    unavailable: number;
    discrepancies: number;
  } | null;
};

/**
 * Ask the server to CHECK THE PROVIDER for one billing account.
 *
 * BILLING RECONCILIATION (2026-08-27) — this replaces `restorePurchases`,
 * which posted to a route that re-read local rows. That could not help the one
 * customer who needs it: the customer whose webhook was lost, for whom the
 * local rows are exactly what is wrong.
 *
 * The request names the ACCOUNT and nothing else. No session id, no
 * subscription id, no amount, no product, no quantity — the server resolves
 * the bindings it stored and asks the provider only about those, so there is
 * no field here in which another account's purchase could be claimed.
 */
export async function reconcileAccount(
  account: BillingAccountRef,
): Promise<ReconciliationResult> {
  return (await apiFetch(
    `/v1/billing/accounts/${account.type}/${encodeURIComponent(account.id)}/reconcile`,
    { method: "POST", body: "{}" },
  )) as ReconciliationResult;
}
