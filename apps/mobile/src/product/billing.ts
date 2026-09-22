/**
 * BILLING — pure projections for the self-service billing surface.
 *
 * ===========================================================================
 * THE TRANSACTION MATRIX, AND WHY ONLY THREE ROWS ARE UNRESOLVED
 * ===========================================================================
 * "App-store rules" is not evidence, and it is not a reason to remove a
 * surface. Every billing action was classified against what it actually does:
 *
 *   READ — account state, plan, credits, storage add-ons, payment history
 *     GET /v1/billing/accounts, /accounts/:type/:id, /:id/history,
 *     /overview, /plan, /pricing
 *     No provider. No entitlement change. Nothing to decide. BUILT.
 *
 *   MANAGE AN EXISTING ENTITLEMENT — cancelling what is already bought
 *     POST /v1/billing/subscription/cancel
 *     POST /v1/billing/storage-addons/cancel
 *     POST /v1/billing/accounts/:type/:id/retry-storage-cancellation
 *     No provider call, no purchase, and no store takes a position on letting
 *     a customer STOP paying. BUILT.
 *
 *   PURCHASE — a new digital entitlement, through Stripe or PayPal
 *     POST /v1/billing/checkout/{stripe,paypal}
 *     POST /v1/billing/storage-addons/checkout/{stripe,paypal}
 *     POST /v1/billing/credits/checkout/{stripe,paypal}
 *     These three, and only these three, are a distribution-policy question
 *     the repository cannot answer. Recorded as COMMERCIAL_POLICY_PENDING on
 *     the transaction, not on the surface.
 *
 *   OPERATOR — reconcile
 *     Out of scope: it is not a customer action.
 *
 * So a native user can see everything they are paying for, read every payment,
 * and stop paying. The only thing they cannot yet do on the device is start
 * paying, and that is named precisely rather than used to hide the rest.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const BILLING_ACCOUNTS_PATH = "/v1/billing/accounts";
export const BILLING_OVERVIEW_PATH = "/v1/billing/overview";
export const SUBSCRIPTION_CANCEL_PATH = "/v1/billing/subscription/cancel";
export const STORAGE_ADDON_CANCEL_PATH = "/v1/billing/storage-addons/cancel";

export function buildBillingAccountPath(type: string, id: string): string {
  return `/v1/billing/accounts/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

export function buildBillingHistoryPath(type: string, id: string): string {
  return `${buildBillingAccountPath(type, id)}/history`;
}

export function buildRetryStorageCancellationPath(type: string, id: string): string {
  return `${buildBillingAccountPath(type, id)}/retry-storage-cancellation`;
}

export function buildStorageAddonCancelBody(addonId: string) {
  return { addonId };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface StorageAddon {
  id: string;
  label: string;
  status: string;
  bytes: string | null;
}

export interface BillingOverview {
  plan: string | null;
  credits: number | null;
  storageLabel: string | null;
  storageLimitLabel: string | null;
  activeAddons: StorageAddon[];
  paymentsTotal: number | null;
  paymentsFailed: number | null;
}

export function parseBillingOverview(payload: unknown): BillingOverview | null {
  const d = obj(payload);
  const summary = obj(d.summary);
  const personal = obj(obj(d.workspaces).personal);
  if (Object.keys(summary).length === 0 && Object.keys(personal).length === 0) return null;

  const payments = obj(summary.payments);
  const storage = obj(personal.storage);

  return {
    plan: str(summary.personalPlan) ?? str(personal.plan),
    credits: num(summary.personalCredits) ?? num(personal.credits),
    storageLabel: str(storage.usedLabel) ?? str(storage.storageUsedLabel),
    storageLimitLabel: str(storage.limitLabel) ?? str(storage.storageLimitLabel),
    activeAddons: rows(summary.activeStorageAddons)
      .map((raw) => {
        const a = obj(raw);
        const id = str(a.id);
        if (!id) return null;
        return {
          id,
          label: str(a.label) ?? str(a.key) ?? "Storage add-on",
          status: str(a.status) ?? "ACTIVE",
          bytes: str(a.bytes) ?? str(a.storageBytes),
        };
      })
      .filter((a): a is StorageAddon => a !== null),
    paymentsTotal: num(payments.total),
    paymentsFailed: num(payments.failed),
  };
}

/** Only an ACTIVE add-on can be cancelled; one already ending is not offered. */
export function isCancellableAddon(addon: StorageAddon): boolean {
  return addon.status.toUpperCase() === "ACTIVE";
}

// ---------------------------------------------------------------------------
// Payment history
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  occurredAtIso: string | null;
  description: string;
  status: string;
  providerLabel: string | null;
  /** Absent when the projection withheld amounts for this viewer. */
  amountCents: number | null;
  currency: string | null;
}

export function parsePaymentHistory(payload: unknown): PaymentRow[] {
  return rows(obj(payload).items)
    .map((raw) => {
      const p = obj(raw);
      const id = str(p.id);
      if (!id) return null;
      return {
        id,
        occurredAtIso: str(p.occurredAtUtc),
        description: str(p.description) ?? "Payment",
        status: str(p.status) ?? "UNKNOWN",
        providerLabel: str(p.providerLabel),
        // The server withholds amounts from a viewer who may not see them.
        // Absent is NOT zero: rendering a payment as costing nothing is worse
        // than rendering it without a figure.
        amountCents: num(p.amountCents),
        currency: str(p.currency),
      };
    })
    .filter((p): p is PaymentRow => p !== null);
}

export function paymentStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
    case "PAID":
      return "verified";
    case "FAILED":
      return "risk";
    case "REFUNDED":
      return "neutral";
    case "PENDING":
    case "PROCESSING":
      return "pending";
    default:
      return "neutral";
  }
}

export function formatPaymentAmount(row: PaymentRow): string | null {
  if (row.amountCents === null) return null;
  const amount = row.amountCents / 100;
  const code = row.currency ?? "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount} ${code}`;
  }
}

// ---------------------------------------------------------------------------
// Purchase — the one unresolved item
// ---------------------------------------------------------------------------

/**
 * The three purchase transactions, named individually.
 *
 * Recorded as pending a distribution-policy decision, on the TRANSACTION and
 * not on the surface. Nothing else in Billing waits on this: a user can read
 * everything and cancel anything.
 */
export const PURCHASE_TRANSACTIONS = [
  "SUBSCRIPTION_CHECKOUT",
  "STORAGE_ADDON_CHECKOUT",
  "EVIDENCE_CREDIT_CHECKOUT",
] as const;

export type PurchaseTransaction = (typeof PURCHASE_TRANSACTIONS)[number];

export const PURCHASE_PENDING_NOTE =
  "Starting a new subscription, buying storage or buying evidence credits is not " +
  "available in the app yet. Everything else on this screen — what you are paying " +
  "for, what you have paid, and cancelling — works here.";
