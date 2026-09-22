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
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It offers no purchase, no upgrade and no checkout link. That is a decision
 * about mobile app-store payment rules, not an oversight, and the surface says
 * so rather than leaving a user to wonder why the button is missing. The
 * catalogue is informational: it answers "what does each plan include", which
 * is the question a billing screen has to answer anyway.
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
