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

/**
 * T-12 / RC-13 — the billing ACCOUNTS a person can see (`GET /v1/billing/accounts`,
 * billing.routes.ts:551). The web picks among them (AccountSelector.tsx) and,
 * when there are none, says billing is handled by the organization
 * (billing/page.tsx:945-958). Native used to take the PERSONAL account or,
 * finding none, display "FREE · Active" — a plan claim for an account whose
 * billing it had never read.
 */
export type BillingAccountType = "PERSONAL" | "ORGANIZATION";
export interface BillingAccountRef {
  type: BillingAccountType;
  id: string;
  displayName: string;
}
export function parseBillingAccounts(data: unknown): BillingAccountRef[] {
  return rows(obj(data).accounts)
    .map((raw): BillingAccountRef | null => {
      const a = obj(raw);
      const type = a.type === "PERSONAL" || a.type === "ORGANIZATION" ? a.type : null;
      const id = str(a.id);
      if (!type || !id) return null;
      return { type, id, displayName: str(a.displayName) ?? (type === "PERSONAL" ? "Personal" : "Organization") };
    })
    .filter((x): x is BillingAccountRef => x !== null);
}
/** AccountSelector.tsx KIND_LABEL. */
export const BILLING_ACCOUNT_KIND_LABEL: Readonly<Record<BillingAccountType, string>> = {
  PERSONAL: "Personal",
  ORGANIZATION: "Organization",
};
/** billing/page.tsx:952-956, verbatim. */
export const BILLING_MANAGED_COPY = {
  title: "Billing is managed for you",
  body: "Your organization looks after billing for this account. Your administrator can make changes.",
} as const;

/**
 * Payment-history failure → the web's copy (StorageAndHistory.tsx). A 403 is
 * not an outage: the records exist and belong to the billing owner.
 */
export function paymentHistoryFailureCopy(err: unknown): { message: string; retry: boolean } {
  return obj(err).statusCode === 403
    ? { message: "Payment records for this account are visible to its billing owner.", retry: false }
    : { message: "We could not load payment history just now.", retry: true };
}

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
    // The ACTIVE add-on rows are `storageAddons.active` (billing-overview.service.ts);
    // `summary.activeStorageAddons` is a COUNT, so iterating it rendered no
    // add-on and no Cancel control, ever.
    activeAddons: rows(obj(d.storageAddons).active)
      .map((raw) => {
        const a = obj(raw);
        const id = str(a.id);
        if (!id) return null;
        const bytes = str(a.extraStorageBytes) ?? str(a.bytes);
        return {
          id,
          label: storageAddonLabel(bytes) ?? str(a.addonKey) ?? "Storage add-on",
          status: str(a.status) ?? "ACTIVE",
          bytes,
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
  /** The server's own affordances for this payment (PaymentRowActions). */
  canRecheck: boolean;
  canCancel: boolean;
  /** Remove an attempt the provider cannot be asked to stop (StorageAndHistory "Abandon payment attempt"). */
  canAbandon: boolean;
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
        canRecheck: obj(p.actions).canRecheck === true,
        canCancel: obj(p.actions).canCancel === true,
        canAbandon: obj(p.actions).canAbandon === true,
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

/** "+100 GB storage" from the server's byte count (a string: it is a BigInt server-side). */
export function storageAddonLabel(bytes: string | null): string | null {
  if (!bytes || !/^\d+$/.test(bytes)) return null;
  const n = Number(bytes);
  const gb = n / 1024 ** 3;
  if (gb >= 1024) return `+${Math.round((gb / 1024) * 10) / 10} TB storage`;
  if (gb >= 1) return `+${Math.round(gb * 10) / 10} GB storage`;
  return `+${Math.round(n / 1024 ** 2)} MB storage`;
}

// ---------------------------------------------------------------------------
// T-14 — the Evidence allowance facts of the web BillingOverview, from the
// account projection (billing-account-projection.service.ts): what the plan
// includes, an agreed (grandfathered) limit, records ABOVE it, the allowance
// period, credits, and — after an upgrade — how many existing records became
// eligible for outputs (a count and a link, never a "generate all").
// Display only; nothing here purchases.
// ---------------------------------------------------------------------------

export interface EvidenceAllowance {
  facts: Array<{ label: string; value: string }>;
  historicalEligible: number;
}

export function parseEvidenceAllowance(projection: unknown): EvidenceAllowance {
  const p = obj(projection);
  const adm = p.evidenceAdmission && typeof p.evidenceAdmission === "object" ? obj(p.evidenceAdmission) : null;
  const meter = obj(obj(p.usage).evidence);
  const planName = str(obj(p.plan).displayName) ?? str(obj(p.plan).planKey) ?? "your plan";
  const included = adm ? num(adm.planIncludedLifetime) : null;
  const cap = adm ? num(adm.effectiveLifetimeCap) : null;
  const held = adm ? num(adm.recordsHeld) ?? 0 : 0;
  const grandfathered = Boolean(adm) && adm!.capSource === "LEGACY_RECORD_CAP_OVERRIDE" && included !== null && cap !== null && included !== cap;
  const over = cap !== null && held > cap ? held - cap : 0;
  const windowNote =
    str(meter.state) === "MEASURED"
      ? meter.window === "ROLLING_30_DAYS"
        ? "Rolling 30-day window"
        : meter.window === "CALENDAR_MONTH"
          ? "Resets each month"
          : null
      : null;
  const credits = (adm ? num(adm.creditsAvailable) : null) ?? num(obj(p.wallet).availableCredits);
  const fmt = (n: number) => n.toLocaleString();
  const facts: Array<{ label: string; value: string }> = [];
  if (included !== null) facts.push({ label: `Included with ${planName}`, value: fmt(included) });
  if (grandfathered) facts.push({ label: "Agreed account limit", value: fmt(cap as number) });
  if (over > 0) facts.push({ label: `Above the ${grandfathered ? "agreed limit" : "included allowance"}`, value: fmt(over) });
  if (windowNote) facts.push({ label: "Allowance period", value: windowNote });
  if (credits !== null) facts.push({ label: "Credits available", value: fmt(credits) });
  return { facts, historicalEligible: num(obj(p.historicalOutputEligibility).eligibleWithoutOutputs) ?? 0 };
}

export function historicalEligibleLine(n: number): string {
  return `${n.toLocaleString()} existing evidence ${n === 1 ? "record is" : "records are"} now eligible for a report and verification package.`;
}

// ---------------------------------------------------------------------------
// T-14 — per-payment Re-check and Cancel (web StorageAndHistory actions).
// Neither is a purchase: re-check asks the provider for the truth of an
// unsettled payment; cancel asks it to stop one that was never paid. Resume
// (a provider checkout) stays with the distribution-policy decision.
// ---------------------------------------------------------------------------

export function buildPaymentRecheckPath(type: string, id: string, paymentId: string): string {
  return buildBillingAccountPath(type, id) + "/payments/" + encodeURIComponent(paymentId) + "/recheck";
}
export function buildPaymentCancelPath(type: string, id: string, paymentId: string): string {
  return buildBillingAccountPath(type, id) + "/payments/" + encodeURIComponent(paymentId) + "/cancel";
}

/** The web's words for each re-check outcome. */
export function paymentRecheckMessage(result: unknown): { message: string; tone: "success" | "info" | "error" } {
  const r = obj(result);
  switch (str(r.outcome)) {
    case "UPDATED":
      return { message: "We checked with your provider and updated this payment.", tone: "success" };
    case "PROVIDER_UNAVAILABLE":
      return { message: "We couldn't verify this payment with your payment provider. Its status is still pending and nothing was changed in PROOVRA.", tone: "error" };
    case "PROVIDER_REFERENCE_NOT_FOUND":
      return { message: "Your payment provider could not find this payment attempt. It stays pending in PROOVRA until you re-check it or abandon the local attempt.", tone: "info" };
    case "PROVIDER_REFERENCE_INVALID":
      return { message: "This older payment attempt cannot be matched with your payment provider automatically. You can remove it from your active Billing view.", tone: "info" };
    case "PROVIDER_AUTHORIZATION_FAILED":
      return { message: "We could not verify this payment because our connection to the payment provider needs attention. Our team has been notified. Nothing was changed in PROOVRA.", tone: "error" };
    default:
      return {
        message: str(r.resumeUrl) ? "This payment is still open with your provider. Use Resume payment to finish it." : "Your provider reports no change to this payment.",
        tone: "info",
      };
  }
}

export function paymentCancelMessage(result: unknown): { message: string; tone: "success" | "info" } {
  return str(obj(result).outcome) === "ALREADY_FINISHED"
    ? { message: "Your provider reports this payment had already finished. Nothing was changed.", tone: "info" }
    : { message: "Your provider has closed this payment. Nothing was charged.", tone: "success" };
}

export const PAYMENT_CANCEL_COPY = {
  title: "Stop this payment?",
  body: "We will ask your payment provider to close it. It has not been paid, so nothing is being reversed. The record stays in your billing history.",
  confirm: "Stop payment",
  cancel: "Leave it open",
};
