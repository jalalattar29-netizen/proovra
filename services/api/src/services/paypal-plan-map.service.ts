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

export function isPayPalRecurringPlan(
  plan: prismaPkg.PlanType
): plan is PayPalRecurringPlan {
  return plan === prismaPkg.PlanType.PRO || plan === prismaPkg.PlanType.TEAM;
}