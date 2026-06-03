// D:\digital-witness\services\api\src\services\paypal-plan-map.service.ts
import * as prismaPkg from "@prisma/client";
export function normalizePayPalCurrency(value) {
    const currency = (value ?? "USD").trim().toUpperCase();
    return currency === "EUR" ? "EUR" : "USD";
}
function must(name) {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`${name} is not set`);
    }
    return value.trim();
}
export function resolvePayPalPlanId(params) {
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
    throw new Error(`PayPal subscription plan mapping is not supported for ${params.plan}`);
}
export function isPayPalRecurringPlan(plan) {
    return plan === prismaPkg.PlanType.PRO || plan === prismaPkg.PlanType.TEAM;
}
