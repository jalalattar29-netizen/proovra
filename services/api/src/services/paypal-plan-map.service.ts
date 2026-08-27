// D:\digital-witness\services\api\src\services\paypal-plan-map.service.ts
import * as prismaPkg from "@prisma/client";

export type SupportedPayPalCurrency = "EUR" | "USD";

export type PayPalRecurringPlan =
  | typeof prismaPkg.PlanType.PRO
  | typeof prismaPkg.PlanType.TEAM;

export function normalizePayPalCurrency(
  value?: string | null
): SupportedPayPalCurrency {
  const currency = (value ?? "USD").trim().toUpperCase();
  return currency === "EUR" ? "EUR" : "USD";
}

function must(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

export function resolvePayPalPlanId(params: {
  plan: PayPalRecurringPlan;
  currency?: string | null;
}): string {
  const currency = normalizePayPalCurrency(params.currency);

  if (params.plan === prismaPkg.PlanType.PRO) {
    return currency === "EUR"
      ? must("PAYPAL_PRO_PLAN_ID_EUR")
      : must("PAYPAL_PRO_PLAN_ID_USD");
  }

  if (params.plan === prismaPkg.PlanType.TEAM) {
    return currency === "EUR"
      ? must("PAYPAL_TEAM_PLAN_ID_EUR")
      : must("PAYPAL_TEAM_PLAN_ID_USD");
  }

  throw new Error(
    `PayPal subscription plan mapping is not supported for ${params.plan}`
  );
}

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the storage add-on plan map.
 *
 * Twelve `PAYPAL_PLAN_STORAGE_<KEY>_<CURRENCY>` billing-plan ids were already
 * configured in the environment and read by ZERO lines of code: the add-on
 * checkout created a one-time ORDER instead, and the recurring code path had
 * been deleted. Now that a storage add-on IS a recurring monthly subscription,
 * these are the plans it subscribes to.
 *
 * `must()` is deliberate. A missing plan id must fail the checkout loudly
 * rather than fall through to an inline one-time charge wearing a
 * subscription's name — that silent downgrade is the exact shape of the defect
 * this replaces.
 */
export function resolvePayPalStorageAddonPlanId(params: {
  addonKey: string;
  currency?: string | null;
}): string {
  const currency = normalizePayPalCurrency(params.currency);
  return must(`PAYPAL_PLAN_STORAGE_${params.addonKey}_${currency}`);
}

export function isPayPalRecurringPlan(
  plan: prismaPkg.PlanType
): plan is PayPalRecurringPlan {
  return plan === prismaPkg.PlanType.PRO || plan === prismaPkg.PlanType.TEAM;
}