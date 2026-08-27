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

export type BillingAccountType = "PERSONAL" | "WORKSPACE" | "ORGANIZATION";

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
  lifecycle: PlanLifecycle;
  priceCents?: number | null;
  currency?: "USD" | "EUR";
  currentPeriodEndUtc: string | null;
  cancelAtPeriodEnd: boolean;
  paymentProviderLabel?: string | null;
  graceEndsAtUtc?: string | null;
  billingOwnerMissing: boolean;
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
  ownedWorkspaces?: { used: number; limit: number };
  collaborationTeams?: { used: number; limit: number };
  seats?: { used: number; limit: number; pendingInvites: number };
};

export type PlanOffer = {
  planKey: "PRO" | "TEAM";
  displayName: string;
  priceCents?: number;
  currency?: "USD" | "EUR";
  summary: string;
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
  };
  collaboration?: CollaborationUsage;
  contract?: EnterpriseContractSummary;
  planOffers?: PlanOffer[];
  actionRequired: {
    severity: "CRITICAL" | "WARNING";
    title: string;
    messages: string[];
    reassurance: string | null;
  } | null;
  storageAddons?: { offers: StorageAddonOffer[]; active: ActiveStorageAddon[] };
  actions: {
    canStartCheckout: boolean;
    canBuyEvidenceCredits: boolean;
    canBuyStorageAddon: boolean;
    canRequestCancellation: boolean;
    contactAccountManager: boolean;
    manageLabel: string | null;
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
};

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

export async function requestCancellation(input: {
  teamId?: string | null;
}): Promise<CancellationOutcome> {
  const res = (await apiFetch("/v1/billing/subscription/cancel", {
    method: "POST",
    body: JSON.stringify(input.teamId ? { teamId: input.teamId } : {}),
  })) as { cancellation: CancellationOutcome };
  return res.cancellation;
}

/**
 * Re-read the SERVER-AUTHORITATIVE commercial state for the caller's account.
 *
 * A provider checkout completes out of band, so a customer returning to the app
 * before the webhook lands sees a stale entitlement. This is idempotent by
 * construction — it accepts no plan, no account and no amount, and recomputes
 * from the persisted subscription rows — so retrying converges rather than
 * double-granting anything.
 */
export async function restorePurchases(): Promise<void> {
  await apiFetch("/v1/billing/restore", { method: "POST", body: "{}" });
}
