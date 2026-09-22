/**
 * PLAN CATALOGUE — pure projections for what each plan includes.
 *
 * Ports the substance of `apps/web/app/pricing/page.tsx` over
 * `GET /v1/billing/pricing?currency=`, which is the same canonical source. The
 * endpoint's own comment states the intent:
 *
 *   "The marketing object is published so the public Pricing page AND
 *    in-app Billing UI both source Enterprise capability copy from the
 *    same place."
 *
 * So the native destination for this content is Billing, not a second pricing
 * page. A phone user comparing what their plan includes is doing it next to
 * what they are currently on.
 *
 * ===========================================================================
 * DISPLAY IS NOT A TRANSACTION
 * ===========================================================================
 * This module shows what each plan, storage add-on and credit offer contains
 * and costs. None of that is a purchase.
 *
 * An earlier version of this comment said the absent checkout was "a decision
 * about mobile app-store payment rules". That was an unsourced claim doing a
 * lot of work: it was used to justify withholding the catalogue itself, which
 * no store has a position on. The classification now lives in
 * `src/product/billing.ts`, where every billing action is placed on a row —
 * and exactly three, the subscription, storage and credit CHECKOUTS, are the
 * distribution-policy question. Blocking the price because of the checkout
 * would be blocking a read on a write.
 *
 * Every figure is the server's. Nothing here recomputes a price, a storage
 * allowance or a seat count — those live in PLAN_CAPABILITIES behind the
 * endpoint, and a client that restated them would be a second price list.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function buildPricingPath(currency?: string | null): string {
  const base = "/v1/billing/pricing";
  return currency ? `${base}?currency=${encodeURIComponent(currency)}` : base;
}

export interface PlanOffer {
  key: string;
  plan: string;
  displayName: string;
  /** null for a plan with no published price (Enterprise is CUSTOM). */
  monthlyPriceCents: number | null;
  pricingModel: "PUBLISHED" | "CUSTOM";
  storageLabel: string | null;
  seats: number | null;
  reportsIncluded: boolean | null;
  publicVerifyIncluded: boolean | null;
  capabilities: string[];
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function projectPublished(key: string, raw: unknown): PlanOffer | null {
  const p = obj(raw);
  const plan = str(p.plan);
  if (!plan) return null;
  return {
    key,
    plan,
    displayName: str(p.displayName) ?? plan,
    monthlyPriceCents: num(p.monthlyPriceCents),
    pricingModel: "PUBLISHED",
    storageLabel: str(p.storageLabel),
    seats: num(p.seats) ?? num(p.includedSeats),
    reportsIncluded: bool(p.reportsIncluded),
    publicVerifyIncluded: bool(p.publicVerifyIncluded),
    capabilities: rows(p.enterpriseFeatures).filter(
      (x): x is string => typeof x === "string",
    ),
  };
}

export interface PricingCatalogue {
  currency: string | null;
  plans: PlanOffer[];
}

export function parsePricingCatalogue(payload: unknown): PricingCatalogue {
  const d = obj(payload);
  const plans: PlanOffer[] = [];

  for (const key of ["free", "pro", "team"]) {
    const offer = projectPublished(key, d[key]);
    if (offer) plans.push(offer);
  }

  const ent = obj(d.enterprise);
  if (str(ent.displayName)) {
    plans.push({
      key: "enterprise",
      plan: "ENTERPRISE",
      displayName: str(ent.displayName) ?? "Enterprise",
      // CUSTOM, not zero. A price of 0 for a sales-provisioned plan would read
      // as "free", which is the opposite of what it means.
      monthlyPriceCents: null,
      pricingModel: "CUSTOM",
      storageLabel: null,
      seats: null,
      reportsIncluded: null,
      publicVerifyIncluded: null,
      capabilities: rows(ent.capabilities).filter(
        (x): x is string => typeof x === "string",
      ),
    });
  }

  return { currency: str(d.currency), plans };
}

/**
 * A price, in the currency the SERVER resolved.
 *
 * `null` cents means the plan is not publicly priced, which is a different
 * statement from free and must read differently. A currency the runtime cannot
 * format falls back to showing the code, never to silently showing a bare
 * number that could be read as dollars.
 */
export function formatMonthlyPrice(
  cents: number | null,
  currency: string | null,
): string {
  if (cents === null) return "Custom pricing";
  if (cents === 0) return "Free";

  const amount = cents / 100;
  const code = currency ?? "USD";
  try {
    return `${new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)} / month`;
  } catch {
    return `${amount} ${code} / month`;
  }
}

/** The line a plan card shows under its price, from the server's figures. */
export function planSummaryLine(offer: PlanOffer): string {
  const parts: string[] = [];
  if (offer.storageLabel) parts.push(`${offer.storageLabel} storage`);
  if (offer.seats !== null) parts.push(`${offer.seats} seat${offer.seats === 1 ? "" : "s"}`);
  if (offer.reportsIncluded === true) parts.push("reports included");
  if (offer.publicVerifyIncluded === true) parts.push("public verification");
  return parts.join(" · ");
}

/** Whether this offer is the plan the workspace is currently on. */
export function isCurrentPlan(offer: PlanOffer, activePlan: string | null): boolean {
  return activePlan !== null && offer.plan.toUpperCase() === activePlan.toUpperCase();
}

// ---------------------------------------------------------------------------
// Storage add-ons and the pay-per-evidence offer
// ---------------------------------------------------------------------------

/**
 * Both are DISPLAY. The catalogue answers "what can I buy and what does it
 * cost", which a customer is entitled to know wherever they are — the
 * transaction matrix in `billing.ts` puts only the CHECKOUT itself on the
 * unresolved row, and blocking the price on the checkout would be blocking a
 * read on a write.
 */
export interface StorageAddonOffer {
  key: string;
  label: string;
  storageBytes: number | null;
  priceCents: number | null;
  billingCycle: string | null;
}

export function parseStorageAddons(payload: unknown): StorageAddonOffer[] {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(d.storageAddons) ? d.storageAddons : [];
  return list
    .map((raw) => {
      const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const key = typeof a.key === "string" && a.key.length > 0 ? a.key : null;
      if (!key) return null;
      return {
        key,
        label: typeof a.label === "string" && a.label.length > 0 ? a.label : key,
        storageBytes: typeof a.storageBytes === "number" ? a.storageBytes : null,
        priceCents: typeof a.priceCents === "number" ? a.priceCents : null,
        billingCycle: typeof a.billingCycle === "string" ? a.billingCycle : null,
      };
    })
    .filter((a): a is StorageAddonOffer => a !== null);
}

export interface EvidenceCreditOffer {
  displayName: string;
  unitPriceCents: number | null;
  creditsGrantedPerPurchase: number | null;
  creditsRequiredPerCompletion: number | null;
  /**
   * Whether a credit expires.
   *
   * Reported, not assumed. "Credits do not expire" is a commercial promise,
   * and a surface that states it without reading it would be making the
   * promise on the product's behalf.
   */
  creditsExpire: boolean | null;
  requiresSubscription: boolean;
}

export function parseEvidenceCreditOffer(payload: unknown): EvidenceCreditOffer | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const p = (d.payg && typeof d.payg === "object" ? d.payg : null) as Record<string, unknown> | null;
  if (!p) return null;

  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    displayName:
      typeof p.displayName === "string" && p.displayName.length > 0
        ? p.displayName
        : "Pay per evidence record",
    unitPriceCents: n(p.unitPriceCents),
    creditsGrantedPerPurchase: n(p.creditsGrantedPerPurchase),
    creditsRequiredPerCompletion: n(p.creditsRequiredPerCompletion),
    creditsExpire: typeof p.creditsExpire === "boolean" ? p.creditsExpire : null,
    requiresSubscription: p.requiresSubscription === true,
  };
}

/** Bytes as the label a person reads, or null when the server sent none. */
export function formatAddonSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const gb = bytes / 1_000_000_000;
  if (gb >= 1000) return `${Math.round(gb / 1000)} TB`;
  return `${Math.round(gb)} GB`;
}
